// runs.ts — durable per-run state for GET /agent/run/:id. Each run is a dir
// under config.runsDir/<run_id>/ with a status.json the server rewrites as the
// pipeline advances. Disk-backed so a poll survives a server restart mid-run
// (the run itself is in-process, so a restart marks an unfinished run as error
// on next read — see reconcile()).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import type { RunState, RunStatus, PublishedRef } from "./runner.ts";

/** A light per-run summary for GET /agent/runs (drops the heavy `log` array). */
export interface RunSummary {
  run_id: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  published?: PublishedRef[];
  error?: string;
}

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
  mkdirSync(runDir(runId), { recursive: true, mode: 0o700 });
  writeRun(state);
  return state;
}

/** Persist the run's current state (called after every stage). */
export function writeRun(state: RunState): void {
  mkdirSync(runDir(state.run_id), { recursive: true, mode: 0o700 });
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

/**
 * Recent runs (newest first, capped) for GET /agent/runs — so a client can
 * detect an in-progress build. Each entry drops the heavy `log` to keep the
 * list light. RESILIENT: a run dir with a missing/corrupt status.json is
 * skipped (readRun returns null), never throwing the whole list. If runsDir
 * doesn't exist yet (no run has ever started), returns [].
 *
 * STALENESS: a "running"/"queued" summary can be stale after a server restart
 * (the run is in-process, so a restart leaves its last-written status frozen).
 * There's no reconcile() here yet — the front end's poll on GET /agent/run/:id
 * is what resolves a stalled run for the user.
 */
export function listRuns(limit = 25): RunSummary[] {
  if (!existsSync(config.runsDir)) return [];
  const summaries: RunSummary[] = [];
  for (const entry of readdirSync(config.runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
    const state = readRun(entry.name);
    if (!state) continue; // missing/corrupt status.json — skip, don't throw the list
    summaries.push({
      run_id: state.run_id,
      status: state.status,
      startedAt: state.startedAt,
      ...(state.finishedAt !== undefined ? { finishedAt: state.finishedAt } : {}),
      ...(state.published.length > 0 ? { published: state.published } : {}),
      ...(state.error ? { error: state.error } : {}),
    });
  }
  summaries.sort((a, b) => b.startedAt - a.startedAt);
  return summaries.slice(0, limit);
}
