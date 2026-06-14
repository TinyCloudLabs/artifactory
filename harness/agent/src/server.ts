// server.ts — the distillery agent backend (MVP, runs locally; Phala is phase 2).
// Holds a stable agent key (→ did:pkh), accepts a user's delegation, and runs
// the artifact pipeline UNDER that delegation, publishing to the USER's space.
//
// THE CONTRACT (.context/FRONTEND-AGENT-PLAN.md — the front end depends on it):
//   GET  /agent/info            → { did, name, permissions[], challenge? }
//   POST /agent/delegation      { serialized } → { ok, agentDid, delegationCid, spaceId, expiresAt }
//   POST /agent/run             {} → { run_id, status:"queued" }
//   GET  /agent/run/:run_id     → { run_id, status, published?[], error? }
//
// Run from the distillery repo root:  bun harness/agent/src/server.ts
//   AGENT_PORT (4097) AGENT_HOST_BIND (127.0.0.1) TINYCLOUD_HOST AGENT_STATE_DIR
//   AGENT_TC_PROFILE (delegated) AGENT_NAME AGENT_GEN_MODEL (opus)
//   NODE_SDK_DIST (override the built @tinycloud/node-sdk path)
// The spawned pipeline INHERITS this server's env (Gemini key, claude on PATH)
// but with HOME pinned to the sandbox — see runner.ts.

import { config } from "./config.ts";
import { AgentSession, type ActiveDelegation } from "./session.ts";
import { runPipeline, type RunState } from "./runner.ts";
import { createRun, isValidRunId, readRun, writeRun } from "./runs.ts";

// The scopes the user must delegate to the agent (server-info shape, so the
// front end can splice them into the OpenKey manifest before sign-in). Mirrors
// Listen's AGENT_PERMISSIONS but scoped to the two app spaces this agent needs:
// Listen-read (in) + artifacts read/write (out).
const PERMISSIONS = [
  {
    service: "tinycloud.sql",
    path: "xyz.tinycloud.listen/conversations",
    actions: ["read"],
    description: "Read your Listen conversations to distill them into artifacts.",
  },
  {
    service: "tinycloud.kv",
    path: "xyz.tinycloud.listen/",
    actions: ["get", "list", "metadata"],
    description: "Read your Listen transcripts to distill them into artifacts.",
  },
  {
    service: "tinycloud.sql",
    path: "xyz.tinycloud.artifacts/",
    actions: ["read", "write"],
    description: "Publish distilled artifacts to your feed.",
  },
  {
    service: "tinycloud.kv",
    path: "xyz.tinycloud.artifacts/",
    actions: ["get", "put", "list", "metadata"],
    description: "Publish artifact media (hero images, audio) to your space.",
  },
] as const;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "600",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

const session = await AgentSession.bootstrap();

// Serialize runs: the pipeline writes to a per-run scratch dir but shares the
// one delegated tc profile, so one run at a time keeps the session coherent.
let runningRunId: string | null = null;

async function handleInfo(): Promise<Response> {
  return json(200, {
    did: session.agentDid,
    name: config.name,
    permissions: PERMISSIONS,
    // No challenge in the MVP — the front end delegates straight to did:pkh.
  });
}

async function handlePostDelegation(req: Request): Promise<Response> {
  let body: { serialized?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: { code: "invalid_json", message: "Body must be JSON." } });
  }
  const serialized = body?.serialized;
  if (typeof serialized !== "string" || serialized.length === 0) {
    return json(400, {
      error: { code: "invalid_body", message: "Body must be { serialized: string } (non-empty)." },
    });
  }

  try {
    const active = await session.activate(serialized);
    console.log(`[agent] activated delegation cid=${active.delegationCid} space=${active.spaceId}`);
    return json(200, {
      ok: true,
      agentDid: session.agentDid,
      delegationCid: active.delegationCid,
      spaceId: active.spaceId,
      expiresAt: active.expiresAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agent] activation failed:`, err);
    // A malformed/expired delegation is the client's fault (400); a node failure
    // mid-activation is ours (500). We can't always tell — deserialize errors
    // and missing chainId are 400, everything else 500.
    const clientFault = /chainId|JSON|deserialize|invalid/i.test(message);
    return json(clientFault ? 400 : 500, {
      error: { code: clientFault ? "invalid_delegation" : "activation_failed", message },
    });
  }
}

async function handlePostRun(): Promise<Response> {
  const active = session.getActive();
  if (!active) {
    return json(409, {
      error: { code: "no_delegation", message: "No delegation granted yet. POST /agent/delegation first." },
    });
  }
  if (runningRunId) {
    return json(409, {
      error: { code: "run_in_progress", message: `A run is already in progress (${runningRunId}).` },
    });
  }

  const state = createRun();
  runningRunId = state.run_id;

  // Fire-and-forget: the run executes in the background; the client polls
  // GET /agent/run/:id. Errors are captured into the run's status.json.
  void executeRun(state, active);

  return json(202, { run_id: state.run_id, status: "queued" });
}

async function executeRun(state: RunState, active: ActiveDelegation): Promise<void> {
  try {
    await runPipeline(active, state, writeRun);
  } catch (err) {
    state.status = "error";
    state.error = err instanceof Error ? err.message : String(err);
    state.finishedAt = Date.now();
    state.log.push(`${new Date().toISOString()} ERROR: ${state.error}`);
    writeRun(state);
    console.error(`[agent] run ${state.run_id} failed:`, err);
  } finally {
    if (runningRunId === state.run_id) runningRunId = null;
  }
}

function handleGetRun(runId: string): Response {
  if (!isValidRunId(runId)) {
    return json(400, { error: { code: "invalid_run_id", message: "Malformed run_id." } });
  }
  const state = readRun(runId);
  if (!state) {
    return json(404, { error: { code: "not_found", message: `Unknown run ${runId}.` } });
  }
  // The API contract response (drop internal fields: startedAt/log/etc.).
  return json(200, {
    run_id: state.run_id,
    status: state.status,
    published: state.published,
    ...(state.error ? { error: state.error } : {}),
  });
}

Bun.serve({
  port: config.port,
  hostname: config.hostname,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === "/agent/info" && req.method === "GET") {
      return handleInfo();
    }
    if (url.pathname === "/agent/delegation" && req.method === "POST") {
      return handlePostDelegation(req);
    }
    if (url.pathname === "/agent/run" && req.method === "POST") {
      return handlePostRun();
    }
    const runMatch = url.pathname.match(/^\/agent\/run\/([^/]+)$/);
    if (runMatch && req.method === "GET") {
      return handleGetRun(decodeURIComponent(runMatch[1]!));
    }
    return json(404, { error: { code: "not_found", message: `${req.method} ${url.pathname}` } });
  },
});

console.log(`[agent] listening on ${config.hostname}:${config.port}`);
console.log(`[agent] repo root   ${config.repoRoot}`);
console.log(`[agent] tc sandbox  ${config.tcHome}/.tinycloud (profile: ${config.profileName})`);
console.log(`[agent] state dir   ${config.agentStateDir}`);
