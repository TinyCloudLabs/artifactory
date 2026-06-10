import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findQuoteTurn, parseTranscript } from "../skills/_shared/lib/transcript.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "skills", "_shared", "scripts", "check-quote.ts");

// Synthetic fixtures only — never real meeting content. The Fireflies-style
// AI summary header phrasing does NOT occur in speech, so it must not match.
const SYNC_ONE = `# Infra Sync Alpha
**Date:** 2026-03-01
**Participants:** ada@example.com, grace@example.com

## Summary
- The team blessed the versioned-cache-key remediation plan.

## Transcript

**Grace Hopper:**
Why is checkout latency spiking again after every deploy?

**Ada Lovelace (00:04:10):**
The cache keys are unversioned, so every deploy invalidates the whole cache.

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
Deploys flush the cache, and versioned cache keys would cut the spike to near zero.
`;

let dir: string;
let pathOne: string;
let pathTwo: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "distillery-check-quote-"));
  pathOne = join(dir, "sync-alpha.md");
  pathTwo = join(dir, "sync-beta.md");
  await writeFile(pathOne, SYNC_ONE);
  await writeFile(pathTwo, SYNC_TWO);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function runCheck(...args: string[]) {
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

describe("findQuoteTurn (shared lib)", () => {
  test("returns the matching turn with speaker and index", () => {
    const t = parseTranscript(SYNC_ONE, "sync-alpha.md");
    const match = findQuoteTurn(t, "every deploy invalidates the   whole cache");
    expect(match).not.toBeNull();
    expect(match!.turn.speaker).toBe("Ada Lovelace");
    expect(match!.index).toBe(1);
  });

  test("returns null for absent quotes and empty needles", () => {
    const t = parseTranscript(SYNC_ONE, "sync-alpha.md");
    expect(findQuoteTurn(t, "totally absent words")).toBeNull();
    expect(findQuoteTurn(t, "   ")).toBeNull();
  });
});

describe("check-quote.ts CLI", () => {
  test("exit 0 when found; prints per-file verdict and the speaker turn", () => {
    const res = runCheck("--quote", "every deploy invalidates the whole cache", pathOne, pathTwo);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`FOUND      ${pathOne}`);
    expect(res.stdout).toContain("Ada Lovelace");
    expect(res.stdout).toContain("(00:04:10)");
    expect(res.stdout).toContain("| The cache keys are unversioned");
    expect(res.stdout).toContain(`not found  ${pathTwo}`);
  });

  test("matching is whitespace-insensitive (verifyQuote semantics)", () => {
    const res = runCheck("--quote", "every   deploy\ninvalidates the whole cache", pathOne);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("FOUND");
  });

  test("exit 1 when the quote is found nowhere", () => {
    const res = runCheck("--quote", "we should rewrite everything in COBOL", pathOne, pathTwo);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain(`not found  ${pathOne}`);
    expect(res.stdout).toContain(`not found  ${pathTwo}`);
    expect(res.stderr).toContain("not found in any of 2 transcript(s)");
  });

  test("AI summary-header text never counts as spoken (speech-segments semantics)", () => {
    const res = runCheck("--quote", "blessed the versioned-cache-key remediation plan", pathOne);
    expect(res.exitCode).toBe(1);
  });

  test("a quote spanning turn boundaries is found but flagged as spanning", () => {
    const res = runCheck(
      "--quote",
      "every deploy invalidates the whole cache. Can you write that down somewhere?",
      pathOne,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("spans multiple speaker turns");
  });

  test("directory input recurses into transcripts", () => {
    const res = runCheck("--quote", "versioned cache keys would cut the spike", dir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(`FOUND      ${pathTwo}`);
  });

  test("usage errors exit 2: missing --quote, missing paths, unknown flags", () => {
    expect(runCheck(pathOne).exitCode).toBe(2);
    expect(runCheck("--quote", "anything").exitCode).toBe(2);
    expect(runCheck("--quote", "anything", "--bogus", pathOne).exitCode).toBe(2);
  });
});
