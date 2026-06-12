// verify-attribution-cli.test.ts — the shared verify-attribution.ts script that
// wires checkAttribution into the verify step (alongside verify-quotes). Proves
// the CLI: flags an ungrounded person-claim (exit 1, no stamp), stamps a fully
// grounded artifact (exit 0), and handles --stamp/usage like verify-quotes.
//
// Synthetic fixtures only — never real meeting content from the vault.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "skills", "_shared", "scripts", "verify-attribution.ts");

// A source where Cush + Odisea + Guatemala are present, but "Shape Rotator" and
// "cohort" are NOT — mirroring the real incident transcript.
const SOURCE = `# Founders call
## Transcript

**Cush:**
I run Odisea from Guatemala. Take your salary, divide by 200, multiply by 15.

**Sam:**
At Flashbots we'd never coordinate that way.
`;

let dir: string;
let sourcePath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "distillery-verify-attr-"));
  sourcePath = join(dir, "founders.md");
  await writeFile(sourcePath, SOURCE);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "attr-test",
    type: "insight-card",
    headline: "A pricing heuristic from a founders call",
    body: "Cush, an Odisea founder, walked through the salary-to-inference math.",
    tags: ["pricing"],
    source_transcripts: [sourcePath],
    generated_at: "2026-06-12T00:00:00.000Z",
    quality: { critic_pass: true, quotes_verified: true, attributions_grounded: false },
    ...overrides,
  };
}

async function writeArt(name: string, a: Record<string, unknown>): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, JSON.stringify(a, null, 2) + "\n");
  return p;
}

function run(...args: string[]) {
  const proc = Bun.spawnSync(["bun", SCRIPT, ...args], {
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

describe("verify-attribution.ts CLI", () => {
  test("grounded artifact exits 0; without --stamp the file is untouched", async () => {
    const path = await writeArt("grounded.json", artifact());
    const before = await readFile(path, "utf8");
    const res = run(path);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("grounded in source");
    expect(res.stdout).not.toContain("Stamped");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("--stamp on a grounded artifact sets attributions_grounded=true, preserves the rest", async () => {
    const path = await writeArt("grounded-stamp.json", artifact());
    const res = run(path, "--stamp");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Stamped quality.attributions_grounded=true");
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.quality.attributions_grounded).toBe(true);
    expect(after.quality.quotes_verified).toBe(true);
    expect(after.quality.critic_pass).toBe(true);
    expect(after.headline).toBe(artifact().headline);
  });

  test("THE INCIDENT: an ungrounded 'Shape Rotator cohort founder' claim flags + exits 1, no stamp", async () => {
    const path = await writeArt(
      "incident.json",
      artifact({
        body:
          "Odisea's Cush — a Shape Rotator cohort founder running his company from Guatemala — " +
          "laid out the heuristic.",
      }),
    );
    const res = run(path, "--stamp");
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("FLAG");
    expect(res.stderr).toContain("shape rotator");
    expect(res.stderr).toContain("cohort");
    // Guatemala IS in source → must not be flagged.
    expect(res.stderr).not.toContain("guatemala");
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.quality.attributions_grounded).toBe(false);
  });

  test("an org absent from the source ('<Name> — Org-not-in-source') flags + exits 1", async () => {
    const path = await writeArt(
      "absent-org.json",
      artifact({ body: "Cush — a Stripe partner — ran the experiment." }),
    );
    const res = run(path, "--stamp");
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("stripe");
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.quality.attributions_grounded).toBe(false);
  });

  test("missing source_transcripts exits 1", async () => {
    const path = await writeArt("no-source.json", artifact({ source_transcripts: [] }));
    const res = run(path);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("source_transcripts");
  });

  test("unknown flags / missing file exit 2 with usage", () => {
    expect(run("whatever.json", "--bogus").exitCode).toBe(2);
    expect(run().exitCode).toBe(2);
    expect(run("--bogus").stderr).toContain("usage:");
  });
});
