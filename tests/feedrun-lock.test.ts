// feedrun-lock.test.ts — the wrapper's ATOMIC concurrency lock (review High #2).
//
// The old acquire was check-then-write (`[[ -f $LOCK ]]` … `printf > $LOCK`):
// two wrappers (button + cron, or two clicks) could both pass the `-f` test
// before either wrote → two `claude -p` runs → double Gemini spend. The fix is
// an atomic `mkdir` lockdir. These tests drive the REAL ops/launchd/feedrun.sh
// via its FEEDRUN_LOCK_HOLD test seam (acquire the lock, hold, exit — no claude /
// no bun generation), proving:
//   1. concurrent acquire → exactly ONE wins (exit 0), the other 409s (exit 75);
//   2. a STALE lock (dead pid) is reclaimed by the next wrapper.
//
// No real generation, no claude, no spend anywhere in this file.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const WRAPPER = join(import.meta.dir, "..", "ops", "launchd", "feedrun.sh");

let repo: string;
let binDir: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "feedrun-lock-"));
  // The wrapper resolves REPO from its own path ($SCRIPT_DIR/../..), so we copy
  // it into a temp repo layout: <repo>/ops/launchd/feedrun.sh.
  await mkdir(join(repo, "ops", "launchd"), { recursive: true });
  await mkdir(join(repo, "index"), { recursive: true });
  binDir = join(repo, "bin");
  await mkdir(binDir, { recursive: true });

  // A stub `bun` so the wrapper's `command -v bun` prereq passes (the dry-run
  // path never actually calls it before the FEEDRUN_LOCK_HOLD seam exits).
  const bun = join(binDir, "bun");
  await writeFile(bun, "#!/bin/bash\nexit 0\n");
  await chmod(bun, 0o755);

  // feedrun.env: put the stub bin first on PATH.
  await writeFile(
    join(repo, "ops", "launchd", "feedrun.env"),
    `export PATH="${binDir}:$PATH"\n`,
  );

  const wrapperSrc = await Bun.file(WRAPPER).text();
  const wrapperDst = join(repo, "ops", "launchd", "feedrun.sh");
  await writeFile(wrapperDst, wrapperSrc);
  await chmod(wrapperDst, 0o755);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** Run the temp-repo wrapper to completion; resolves with its exit code. */
function runWrapper(env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", [join(repo, "ops", "launchd", "feedrun.sh")], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...env },
      stdio: "ignore",
    });
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

describe("feedrun.sh atomic lock", () => {
  test("two concurrent wrappers → exactly one wins (exit 0), the other 409s (exit 75)", async () => {
    // Both fire at once; the winner holds the lock ~1.5s, long enough for the
    // loser to hit the held lock and abort with 75.
    const base = { FEEDRUN_DRY_RUN: "1", FEEDRUN_LOCK_HOLD: "1.5" };
    const [a, b] = await Promise.all([runWrapper(base), runWrapper(base)]);
    const sorted = [a, b].sort((x, y) => x - y);
    expect(sorted).toEqual([0, 75]); // exactly one winner, one EX_TEMPFAIL (→ HTTP 409)
    // The lock is cleaned up after the winner exits.
    expect(existsSync(join(repo, "index", ".run.lock.d"))).toBe(false);
  });

  test("a STALE lock (dead pid) is reclaimed by the next wrapper", async () => {
    // Plant a lockdir owned by a dead pid (the state a SIGKILL'd run leaves).
    const lockDir = join(repo, "index", ".run.lock.d");
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "pid"), "999999\n2026-06-11T07:00:00Z\n");

    const code = await runWrapper({ FEEDRUN_DRY_RUN: "1", FEEDRUN_LOCK_HOLD: "0" });
    expect(code).toBe(0); // reclaimed the stale lock and ran, not blocked
    expect(existsSync(lockDir)).toBe(false); // cleaned up on exit
  });
});
