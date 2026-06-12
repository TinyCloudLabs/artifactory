import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPTS = join(REPO_ROOT, "skills", "extract-insights", "scripts");

// Synthetic fixture only — never real meeting content. Includes a
// Fireflies-style AI summary header whose phrasing does NOT occur in speech.
const TRANSCRIPT = `# Synthetic Pricing Sync
**Date:** 2026-06-01
**Participants:** ada@example.com, grace@example.com

## Summary
- Team converged on the flat-rate moonshot pricing experiment.

## Transcript

**Ada Lovelace:**
We should charge a single flat rate and see who screams.

**Grace Hopper:**
Run it for one cohort first and measure churn before rolling wide.
`;

let dir: string;
let transcriptPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "distillery-extract-insights-"));
  transcriptPath = join(dir, "pricing-sync.md");
  await writeFile(transcriptPath, TRANSCRIPT);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function insightArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "test-id",
    type: "insight-card",
    headline: "Flat-rate pricing gets a one-cohort trial before any rollout",
    body: "Ada proposed flat-rate pricing; Grace gated it behind a churn-measured cohort.",
    tags: ["pricing"],
    source_transcripts: [transcriptPath],
    source_quotes: [
      {
        quote: "We should charge a single flat rate and see who screams.",
        speaker: "Ada Lovelace",
        transcript: transcriptPath,
      },
      {
        quote: "measure churn before rolling wide",
        speaker: "Grace Hopper",
        transcript: transcriptPath,
      },
    ],
    generated_at: "2026-06-10T12:00:00.000Z",
    quality: { critic_pass: true, quotes_verified: false, attributions_grounded: false, notes: "synthetic test artifact" },
    ...overrides,
  };
}

async function writeArtifactFile(name: string, artifact: Record<string, unknown>): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(artifact, null, 2) + "\n");
  return path;
}

function runVerify(...args: string[]) {
  const proc = Bun.spawnSync(["bun", join(SCRIPTS, "verify-quotes.ts"), ...args], {
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

describe("verify-quotes.ts CLI — extract-insights", () => {
  test("exits 0 on verbatim quotes; without --stamp the file is untouched", async () => {
    const path = await writeArtifactFile("good-no-stamp.json", insightArtifact());
    const before = await readFile(path, "utf8");
    const res = runVerify(path);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("All 2 quote(s) verified.");
    expect(res.stdout).not.toContain("Stamped");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("--stamp on success sets quality.quotes_verified=true, preserving the rest", async () => {
    const path = await writeArtifactFile("good-stamp.json", insightArtifact());
    const res = runVerify(path, "--stamp");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Stamped quality.quotes_verified=true");
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.quality.quotes_verified).toBe(true);
    expect(after.quality.critic_pass).toBe(true);
    expect(after.quality.notes).toBe("synthetic test artifact");
    expect(after.headline).toBe(insightArtifact().headline);
    expect(after.source_quotes).toHaveLength(2);
  });

  test("--stamp on failure exits 1 and does not flip the flag", async () => {
    const artifact = insightArtifact();
    (artifact.source_quotes as { quote: string }[])[0]!.quote =
      "we ought to bill one flat price and observe reactions";
    const path = await writeArtifactFile("bad-stamp.json", artifact);
    const res = runVerify(path, "--stamp");
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("FAIL");
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.quality.quotes_verified).toBe(false);
  });

  test("regression: a quote lifted from the AI summary header fails verification", async () => {
    const artifact = insightArtifact();
    // Present verbatim in the raw file's ## Summary, never spoken.
    (artifact.source_quotes as { quote: string }[])[0]!.quote =
      "flat-rate moonshot pricing experiment";
    const path = await writeArtifactFile("summary-quote.json", artifact);
    const res = runVerify(path, "--stamp");
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("flat-rate moonshot pricing experiment");
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.quality.quotes_verified).toBe(false);
  });

  test("zero source_quotes exits 0 but --stamp refuses to stamp", async () => {
    const path = await writeArtifactFile(
      "empty-quotes.json",
      insightArtifact({ source_quotes: [] }),
    );
    const res = runVerify(path, "--stamp");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--stamp skipped");
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.quality.quotes_verified).toBe(false);
  });

  test("unknown flags exit 2 with usage", () => {
    const res = runVerify("whatever.json", "--bogus");
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("usage:");
  });
});
