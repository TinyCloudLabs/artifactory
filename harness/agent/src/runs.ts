// runs.ts — durable per-run state for GET /agent/run/:id. Each run is a dir
// under config.runsDir/<run_id>/ with a status.json the server rewrites as the
// pipeline advances. Disk-backed so a poll survives a server restart mid-run
// (the run itself is in-process, so a restart marks an unfinished run as error
// on next read — see reconcile()).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import type { RunState } from "./runner.ts";

function runDir(runId: string): string {
  return join(config.runsDir, runId);
}

function statusPath(runId: string): string {
  return join(runDir(runId), "status.json");
}

/** A fresh queued run record + its on-disk home. */
export function createRun(): RunState {
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const state: RunState = {
    run_id: runId,
    status: "queued",
    published: [],
    startedAt: Date.now(),
    log: [],
  };
  mkdirSync(runDir(runId), { recursive: true });
  writeRun(state);
  return state;
}

/** Persist the run's current state (called after every stage). */
export function writeRun(state: RunState): void {
  mkdirSync(runDir(state.run_id), { recursive: true });
  writeFileSync(statusPath(state.run_id), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/** Read a run's state, or null if unknown. */
export function readRun(runId: string): RunState | null {
  const path = statusPath(runId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RunState;
  } catch {
    return null;
  }
}

/** Run ids are server-minted; reject anything that could escape runsDir. */
export function isValidRunId(runId: string): boolean {
  return /^run-\d+-[a-z0-9]{6}$/.test(runId);
}
