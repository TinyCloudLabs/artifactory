import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTranscripts } from "../skills/_shared/lib/transcript.ts";
import { slugify, type Artifact } from "../skills/_shared/lib/artifact.ts";
import {
  buildDigest,
  countWords,
  saveArticle,
  verifyArtifactQuotes,
} from "../skills/write-article/scripts/article.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPTS = join(REPO_ROOT, "skills", "write-article", "scripts");

// Synthetic fixtures only — never real meeting content. Two transcripts
// share a recurring topic ("latency") and a shared speaker (Ada); Ada holds
// asymmetric knowledge (cache internals) that Grace keeps asking about.
const SYNC_ONE = `# Infra Sync Alpha
**Date:** 2026-03-01
**Participants:** ada@example.com, grace@example.com

## Transcript

**Grace Hopper:**
Why is checkout latency spiking again after every deploy?

**Ada Lovelace:**
The cache keys are unversioned, so every deploy invalidates the whole cache and latency spikes until it warms.

**Grace Hopper:**
Can you write that down somewhere? I ask you this every quarter.
`;

const SYNC_TWO = `# Infra Sync Beta
**Date:** 2026-03-08
**Participants:** ada@example.com, linus@example.com

## Transcript

**Linus Pauling:**
Customers complained about latency during the launch window.

**Ada Lovelace:**
Same root cause as last week. Deploys flush the cache, and versioned cache keys would cut the latency spike to near zero.

**Linus Pauling:**
Let's schedule the cache versioning work for next sprint.
`;

let dir: string;
let pathOne: string;
let pathTwo: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "distillery-write-article-"));
  pathOne = join(dir, "sync-alpha.md");
  pathTwo = join(dir, "sync-beta.md");
  await writeFile(pathOne, SYNC_ONE);
  await writeFile(pathTwo, SYNC_TWO);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function articleArtifact(overrides: Partial<Artifact> = {}): Record<string, unknown> {
  const body = [
    "*The cache problem one engineer keeps re-explaining.*",
    "",
    "Twice in two weeks, a latency spike traced back to the same cause: unversioned cache keys.",
    "",
    "> The cache keys are unversioned, so every deploy invalidates the whole cache and latency spikes until it warms. — Ada Lovelace",
  ].join("\n");
  return {
    type: "article",
    headline: "Unversioned cache keys are the team's recurring latency tax",
    body,
    quote: "Can you write that down somewhere? I ask you this every quarter.",
    attribution: "Grace Hopper",
    tags: ["infrastructure", "latency", "asymmetric-knowledge"],
    source_transcripts: [pathOne, pathTwo],
    source_quotes: [
      {
        quote:
          "The cache keys are unversioned, so every deploy invalidates the whole cache and latency spikes until it warms.",
        speaker: "Ada Lovelace",
        transcript: pathOne,
      },
      {
        quote: "Can you write that down somewhere? I ask you this every quarter.",
        speaker: "Grace Hopper",
        transcript: pathOne,
      },
    ],
    generated_at: "2026-06-10T12:00:00.000Z",
    generation_model: "agent-judgment",
    quality: { critic_pass: true, quotes_verified: true, notes: "synthetic test artifact" },
    ...overrides,
  };
}

function runScript(script: string, ...args: string[]) {
  const proc = Bun.spawnSync(["bun", join(SCRIPTS, script), ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("buildDigest — single transcript", () => {
  test("single mode, no crossTranscript, speaker stats and chunks present", async () => {
    const [t] = await loadTranscripts([pathOne]);
    const digest = buildDigest([t!]);
    expect(digest.mode).toBe("single");
    expect(digest.transcriptCount).toBe(1);
    expect(digest.crossTranscript).toBeUndefined();
    expect(digest.transcripts[0]?.title).toBe("Infra Sync Alpha");
    expect(digest.transcripts[0]?.turnCount).toBe(3);
    const speakers = digest.transcripts[0]?.speakers ?? [];
    expect(speakers.find((s) => s.speaker === "Grace Hopper")?.turns).toBe(2);
    expect(speakers.find((s) => s.speaker === "Ada Lovelace")?.turns).toBe(1);
    // Chunks carry the full text for the agent to read.
    const joined = digest.chunks.map((c) => c.text).join("\n\n");
    expect(joined).toContain("unversioned");
  });

  test("digest is deterministic", async () => {
    const transcripts = await loadTranscripts([pathOne, pathTwo]);
    const a = JSON.stringify(buildDigest(transcripts));
    const b = JSON.stringify(buildDigest(transcripts));
    expect(a).toBe(b);
  });
});

describe("buildDigest — collection (multi-transcript)", () => {
  test("collection mode surfaces recurring terms and shared speakers", async () => {
    const transcripts = await loadTranscripts([pathOne, pathTwo]);
    const digest = buildDigest(transcripts);
    expect(digest.mode).toBe("collection");
    expect(digest.transcriptCount).toBe(2);
    const cross = digest.crossTranscript;
    expect(cross).toBeDefined();

    const terms = cross!.recurringTerms.map((t) => t.term);
    expect(terms).toContain("latency");
    expect(terms).toContain("cache");
    // Stopwords and meeting filler never appear as recurring terms.
    expect(terms).not.toContain("every");
    expect(terms).not.toContain("that");

    const latency = cross!.recurringTerms.find((t) => t.term === "latency");
    expect(latency?.transcriptCount).toBe(2);
    expect(latency!.occurrences).toBeGreaterThanOrEqual(4);

    const shared = cross!.sharedSpeakers;
    expect(shared.map((s) => s.speaker)).toEqual(["Ada Lovelace"]);
    expect(shared[0]?.transcripts.sort()).toEqual([pathOne, pathTwo].sort());
  });

  test("directory input loads both transcripts into one collection digest", async () => {
    const transcripts = await loadTranscripts([dir]);
    const digest = buildDigest(transcripts);
    expect(digest.mode).toBe("collection");
    expect(digest.transcripts.map((t) => t.title).sort()).toEqual([
      "Infra Sync Alpha",
      "Infra Sync Beta",
    ]);
  });
});

describe("survey.ts CLI", () => {
  test("emits collection digest JSON on stdout for multiple paths", () => {
    const res = runScript("survey.ts", pathOne, pathTwo);
    expect(res.exitCode).toBe(0);
    const digest = JSON.parse(res.stdout);
    expect(digest.mode).toBe("collection");
    expect(digest.crossTranscript.recurringTerms.map((t: { term: string }) => t.term)).toContain(
      "latency",
    );
  });

  test("exits non-zero without paths", () => {
    expect(runScript("survey.ts").exitCode).toBe(2);
  });
});

describe("verifyArtifactQuotes", () => {
  test("passes verbatim quotes, fails paraphrases and bad paths", async () => {
    const ok = await verifyArtifactQuotes([
      { quote: "deploys flush the cache", transcript: pathTwo },
    ]);
    expect(ok).toEqual([]);

    const bad = await verifyArtifactQuotes([
      { quote: "deployments tend to clear out cached data", transcript: pathTwo },
      { quote: "anything", transcript: join(dir, "missing.md") },
    ]);
    expect(bad).toHaveLength(2);
    expect(bad[0]?.reason).toContain("not found");
    expect(bad[1]?.reason).toContain("could not read");
  });
});

describe("verify-quotes.ts CLI integration", () => {
  test("exits 0 when every source quote is verbatim", async () => {
    const artifactPath = join(dir, "artifact-good.json");
    await writeFile(artifactPath, JSON.stringify(articleArtifact(), null, 2));
    const res = runScript("verify-quotes.ts", artifactPath);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("All 2 quote(s) verified.");
  });

  test("exits 1 on a paraphrased quote", async () => {
    const artifact = articleArtifact();
    (artifact.source_quotes as { quote: string }[])[0]!.quote =
      "the cache keys lack versioning so deploys wipe the cache";
    const artifactPath = join(dir, "artifact-paraphrased.json");
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2));
    const res = runScript("verify-quotes.ts", artifactPath);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("FAIL");
  });

  test("exits 1 when source_quotes is empty — unanchored articles don't ship", async () => {
    const artifactPath = join(dir, "artifact-unanchored.json");
    await writeFile(artifactPath, JSON.stringify(articleArtifact({ source_quotes: [] })));
    const res = runScript("verify-quotes.ts", artifactPath);
    expect(res.exitCode).toBe(1);
  });
});

describe("saveArticle", () => {
  test("writes artifacts/article/<slug>/artifact.json with body.md alongside", async () => {
    const outDir = join(dir, "out-save");
    const artifact = articleArtifact();
    const saved = await saveArticle(artifact, { outDir });
    expect(saved.written.jsonPath).toBe(
      join(outDir, "article", slugify(artifact.headline as string), "artifact.json"),
    );
    const roundTrip = JSON.parse(await readFile(saved.written.jsonPath, "utf8"));
    expect(roundTrip.type).toBe("article");
    expect(roundTrip.quality.quotes_verified).toBe(true);
    const bodyMd = await readFile(join(saved.written.dir, "body.md"), "utf8");
    expect(bodyMd.trimEnd()).toBe((artifact.body as string).trimEnd());
    expect(bodyMd).toContain("— Ada Lovelace");
  });

  test("fills id/generated_at defaults and strips hero_image: null", async () => {
    const outDir = join(dir, "out-defaults");
    const artifact = articleArtifact({ hero_image: null as unknown as string });
    delete artifact.id;
    delete artifact.generated_at;
    const saved = await saveArticle(artifact, { outDir });
    const roundTrip = JSON.parse(await readFile(saved.written.jsonPath, "utf8"));
    expect(typeof roundTrip.id).toBe("string");
    expect(Number.isNaN(Date.parse(roundTrip.generated_at))).toBe(false);
    // hero_image stays absent until the illustrate-card skill adds it.
    expect("hero_image" in roundTrip).toBe(false);
  });

  test("rejects non-article types and missing bodies", async () => {
    const outDir = join(dir, "out-reject");
    expect(saveArticle(articleArtifact({ type: "insight-card" }), { outDir })).rejects.toThrow(
      'only saves type "article"',
    );
    const noBody = articleArtifact();
    delete noBody.body;
    expect(saveArticle(noBody, { outDir })).rejects.toThrow("non-empty markdown body");
  });

  test("warns (non-fatally) when body is outside the 400-900 word target", async () => {
    const outDir = join(dir, "out-warn");
    const saved = await saveArticle(articleArtifact(), { outDir });
    expect(saved.warnings.length).toBe(1);
    expect(saved.warnings[0]).toContain("400-900");

    const inRange = await saveArticle(
      articleArtifact({
        headline: "A properly sized article about cache versioning",
        body: Array(450).fill("word").join(" "),
      }),
      { outDir },
    );
    expect(inRange.wordCount).toBe(450);
    expect(inRange.warnings).toEqual([]);
  });
});

describe("save.ts CLI integration", () => {
  test("end-to-end: artifact JSON in, artifact.json + body.md on disk", async () => {
    const outDir = join(dir, "out-cli");
    await mkdir(outDir, { recursive: true });
    const artifactPath = join(dir, "artifact-cli.json");
    const artifact = articleArtifact();
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2));

    const res = runScript("save.ts", artifactPath, "--out-dir", outDir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Saved:");

    const slug = slugify(artifact.headline as string);
    const json = JSON.parse(await readFile(join(outDir, "article", slug, "artifact.json"), "utf8"));
    expect(json.headline).toBe(artifact.headline);
    const bodyMd = await readFile(join(outDir, "article", slug, "body.md"), "utf8");
    expect(bodyMd).toContain("latency spike");
  });

  test("exits 1 on contract-invalid artifacts", async () => {
    const artifactPath = join(dir, "artifact-invalid.json");
    await writeFile(artifactPath, JSON.stringify(articleArtifact({ tags: undefined })));
    const res = runScript("save.ts", artifactPath, "--out-dir", join(dir, "out-cli-bad"));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("tags");
  });
});

describe("countWords", () => {
  test("counts whitespace-separated words", () => {
    expect(countWords("one two\nthree   four")).toBe(4);
    expect(countWords("  ")).toBe(0);
  });
});
