import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact } from "../skills/_shared/lib/artifact.ts";
import {
  illustrate,
  parseArgs,
  UsageError,
  type ImageProvider,
} from "../skills/illustrate-card/scripts/illustrate.ts";

const SCRIPT = join(
  import.meta.dir,
  "..",
  "skills",
  "illustrate-card",
  "scripts",
  "illustrate.ts",
);

function goodArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "a-1",
    type: "insight-card",
    headline: "Usage-based pricing aligns revenue with value",
    body: "The team chose usage-based pricing because seats punish power users.",
    tags: ["pricing"],
    source_transcripts: ["/tmp/fireflies-style.md"],
    generated_at: "2026-06-10T12:00:00.000Z",
    quality: { critic_pass: true, quotes_verified: true },
    ...overrides,
  };
}

const PNG_BYTES = new TextEncoder().encode("fake-png-bytes");

function fakeProvider(
  mimeType = "image/png",
  bytes: Uint8Array = PNG_BYTES,
): ImageProvider & { calls: { prompt: string; aspectRatio?: string }[] } {
  const calls: { prompt: string; aspectRatio?: string }[] = [];
  const provider = (async (opts) => {
    calls.push({ prompt: opts.prompt, aspectRatio: opts.aspectRatio });
    return { bytes, mimeType };
  }) as ImageProvider & { calls: typeof calls };
  provider.calls = calls;
  return provider;
}

describe("parseArgs", () => {
  test("parses a full generation invocation", () => {
    const args = parseArgs([
      "--artifact-dir", "artifacts/insight-card/foo",
      "--prompt", "a water meter",
      "--aspect", "1:1",
      "--note", "retry: garbled text",
      "--skip-existing",
    ]);
    expect(args).toEqual({
      artifactDir: "artifacts/insight-card/foo",
      prompt: "a water meter",
      promptFile: undefined,
      annotate: undefined,
      aspectRatio: "1:1",
      note: "retry: garbled text",
      skipExisting: true,
    });
  });

  test("defaults aspect to 16:9", () => {
    const args = parseArgs(["--artifact-dir", "d", "--prompt", "p"]);
    expect(args.aspectRatio).toBe("16:9");
    expect(args.skipExisting).toBe(false);
  });

  test("accepts --prompt-file and --annotate modes", () => {
    expect(
      parseArgs(["--artifact-dir", "d", "--prompt-file", "p.txt"]).promptFile,
    ).toBe("p.txt");
    expect(
      parseArgs(["--artifact-dir", "d", "--annotate", "looks good"]).annotate,
    ).toBe("looks good");
  });

  test("requires --artifact-dir", () => {
    expect(() => parseArgs(["--prompt", "p"])).toThrow(UsageError);
  });

  test("requires exactly one of --prompt / --prompt-file / --annotate", () => {
    expect(() => parseArgs(["--artifact-dir", "d"])).toThrow(UsageError);
    expect(() =>
      parseArgs(["--artifact-dir", "d", "--prompt", "p", "--prompt-file", "f"]),
    ).toThrow(UsageError);
    expect(() =>
      parseArgs(["--artifact-dir", "d", "--prompt", "p", "--annotate", "x"]),
    ).toThrow(UsageError);
  });

  test("rejects --note / --skip-existing in annotate mode", () => {
    expect(() =>
      parseArgs(["--artifact-dir", "d", "--annotate", "x", "--note", "n"]),
    ).toThrow(UsageError);
    expect(() =>
      parseArgs(["--artifact-dir", "d", "--annotate", "x", "--skip-existing"]),
    ).toThrow(UsageError);
  });

  test("rejects flags missing their value and unknown flags", () => {
    expect(() => parseArgs(["--artifact-dir"])).toThrow(UsageError);
    expect(() =>
      parseArgs(["--artifact-dir", "d", "--prompt", "--skip-existing"]),
    ).toThrow(UsageError);
    expect(() =>
      parseArgs(["--artifact-dir", "d", "--prompt", "p", "--wat"]),
    ).toThrow(UsageError);
  });
});

describe("illustrate", () => {
  let dir: string;
  let jsonPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "distillery-illustrate-"));
    jsonPath = join(dir, "artifact.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seed(artifact: Artifact = goodArtifact()) {
    await writeFile(jsonPath, JSON.stringify(artifact, null, 2) + "\n");
  }

  function args(overrides: Record<string, unknown> = {}) {
    return {
      artifactDir: dir,
      prompt: "a water meter feeding coins into a jar",
      aspectRatio: "16:9",
      skipExisting: false,
      ...overrides,
    };
  }

  test("generates hero.png and updates hero_image + quality.notes", async () => {
    await seed();
    const provider = fakeProvider();
    const result = await illustrate(args(), provider);

    expect(result.status).toBe("generated");
    expect(result.heroPath).toBe(join(dir, "hero.png"));
    expect(provider.calls).toEqual([
      { prompt: "a water meter feeding coins into a jar", aspectRatio: "16:9" },
    ]);

    const hero = await readFile(join(dir, "hero.png"));
    expect(new Uint8Array(hero)).toEqual(PNG_BYTES);

    const updated = JSON.parse(await readFile(jsonPath, "utf8")) as Artifact;
    expect(updated.hero_image).toBe("hero.png");
    expect(updated.quality.notes).toBe(
      "[illustrate-card] hero image generated (gemini-2.5-flash-image)",
    );
    // Untouched fields survive the round-trip.
    expect(updated.headline).toBe(goodArtifact().headline);
    expect(updated.quality.critic_pass).toBe(true);
  });

  test("uses the extension from the mimeType and removes a stale hero", async () => {
    await seed(goodArtifact({ hero_image: "hero.png" }));
    await writeFile(join(dir, "hero.png"), "old-bytes");

    const result = await illustrate(args(), fakeProvider("image/jpeg"));
    expect(result.heroPath).toBe(join(dir, "hero.jpg"));
    expect(existsSync(join(dir, "hero.jpg"))).toBe(true);
    expect(existsSync(join(dir, "hero.png"))).toBe(false);

    const updated = JSON.parse(await readFile(jsonPath, "utf8")) as Artifact;
    expect(updated.hero_image).toBe("hero.jpg");
  });

  test("falls back to .png for unknown mime types", async () => {
    await seed();
    const result = await illustrate(args(), fakeProvider("image/whatever"));
    expect(result.heroPath).toBe(join(dir, "hero.png"));
  });

  test("appends custom --note to existing quality.notes", async () => {
    await seed(
      goodArtifact({
        quality: { critic_pass: true, quotes_verified: true, notes: "1 of 3 survived" },
      }),
    );
    await illustrate(args({ note: "retry: text artifacts in attempt 1" }), fakeProvider());
    const updated = JSON.parse(await readFile(jsonPath, "utf8")) as Artifact;
    expect(updated.quality.notes).toBe(
      "1 of 3 survived | [illustrate-card] retry: text artifacts in attempt 1",
    );
  });

  test("reads the prompt from --prompt-file", async () => {
    await seed();
    const promptFile = join(dir, "prompt.txt");
    await writeFile(promptFile, "  a paper boat on a ramp \n");
    const provider = fakeProvider();
    await illustrate(args({ prompt: undefined, promptFile }), provider);
    expect(provider.calls[0]?.prompt).toBe("a paper boat on a ramp");
  });

  test("fails on a missing or empty prompt file", async () => {
    await seed();
    expect(
      illustrate(args({ prompt: undefined, promptFile: join(dir, "nope.txt") }), fakeProvider()),
    ).rejects.toThrow("could not read prompt file");

    const empty = join(dir, "empty.txt");
    await writeFile(empty, "   \n");
    expect(
      illustrate(args({ prompt: undefined, promptFile: empty }), fakeProvider()),
    ).rejects.toThrow("prompt is empty");
  });

  test("--skip-existing skips when the hero file exists", async () => {
    await seed(goodArtifact({ hero_image: "hero.png" }));
    await writeFile(join(dir, "hero.png"), "existing");
    const provider = fakeProvider();

    const result = await illustrate(args({ skipExisting: true }), provider);
    expect(result.status).toBe("skipped");
    expect(provider.calls).toHaveLength(0);
    // artifact.json untouched.
    const updated = JSON.parse(await readFile(jsonPath, "utf8")) as Artifact;
    expect(updated.quality.notes).toBeUndefined();
  });

  test("--skip-existing regenerates when hero_image points at a missing file", async () => {
    await seed(goodArtifact({ hero_image: "hero.png" }));
    const provider = fakeProvider();
    const result = await illustrate(args({ skipExisting: true }), provider);
    expect(result.status).toBe("generated");
    expect(provider.calls).toHaveLength(1);
  });

  test("--annotate appends a note without calling the provider", async () => {
    await seed();
    const provider = fakeProvider();
    const result = await illustrate(
      args({ prompt: undefined, annotate: "hero reviewed: accepted on attempt 2" }),
      provider,
    );
    expect(result.status).toBe("annotated");
    expect(provider.calls).toHaveLength(0);
    const updated = JSON.parse(await readFile(jsonPath, "utf8")) as Artifact;
    expect(updated.quality.notes).toBe(
      "[illustrate-card] hero reviewed: accepted on attempt 2",
    );
  });

  test("fails when artifact.json is missing", async () => {
    expect(illustrate(args(), fakeProvider())).rejects.toThrow(
      "no artifact.json found",
    );
  });

  test("fails on malformed JSON", async () => {
    await writeFile(jsonPath, "{not json");
    expect(illustrate(args(), fakeProvider())).rejects.toThrow(
      "not valid JSON",
    );
  });

  test("fails on a contract-invalid artifact", async () => {
    await writeFile(
      jsonPath,
      JSON.stringify({ ...goodArtifact(), headline: "", quality: undefined }),
    );
    expect(illustrate(args(), fakeProvider())).rejects.toThrow(
      "fails the contract",
    );
  });

  test("propagates provider failure and leaves artifact.json untouched", async () => {
    await seed();
    const before = await readFile(jsonPath, "utf8");
    const provider: ImageProvider = async () => {
      throw new Error("gemini image 429: quota");
    };
    expect(illustrate(args(), provider)).rejects.toThrow("gemini image 429");
    expect(await readFile(jsonPath, "utf8")).toBe(before);
    expect(existsSync(join(dir, "hero.png"))).toBe(false);
  });
});

describe("CLI wiring", () => {
  test("exits 2 with usage on bad arguments, without touching the network", () => {
    const proc = Bun.spawnSync({
      cmd: ["bun", SCRIPT],
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(proc.exitCode).toBe(2);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect(stderr).toContain("usage:");
    expect(stderr).toContain("--artifact-dir is required");
  });

  test("exits 1 when the artifact dir has no artifact.json", () => {
    const proc = Bun.spawnSync({
      cmd: [
        "bun", SCRIPT,
        "--artifact-dir", join(tmpdir(), "distillery-definitely-missing"),
        "--prompt", "p",
      ],
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(proc.exitCode).toBe(1);
    expect(new TextDecoder().decode(proc.stderr)).toContain("no artifact.json found");
  });
});
