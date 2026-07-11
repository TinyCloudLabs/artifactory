#!/usr/bin/env bun
// Feed v1 generation worker: consumes `generation_request` rows from a Feed
// Host (written by the Ask Feed UI), runs the ported extract-insights pipeline
// over local transcripts, and publishes the resulting Feed v1 artifact back
// through the host's dev publish endpoint.
//
//   Feed UI "Ask Feed" -> Feed Host generation_request (status=accepted)
//     -> worker claims (status=pending) -> generate -> publish artifact
//     -> status=consumed (or rejected with a scrubbed note)
//
// Backpressure: the host caps accepted+pending requests per actor (429 at
// intake); this worker is single-flight, claims one request at a time, and
// backs off exponentially when the host is unreachable.
//
// Usage:
//   TRANSCRIPT_DIRS=/path/to/transcripts \
//   FEED_HOST_URL=https://feed-host.localhost:1355 FEED_HOST_INSECURE_TLS=1 \
//   bun harness/feed-v1-worker/worker.ts [--once] [--generator claude|stub]
//
// The Feed Host must be started with FEED_HOST_DEV_PUBLISH=1.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { toFeedArtifact } from "../../skills/_shared/lib/feed-v1-convert.ts";
import { generateInsightArtifact, type GeneratorKind } from "./generate.ts";

export type WorkerConfig = {
  hostUrl: string;
  actorId?: string;
  token?: string;
  insecureTls: boolean;
  transcriptDirs: string[];
  pollMs: number;
  runsDir: string;
  model: string;
  generator: GeneratorKind;
  maxAttempts: number;
  once: boolean;
};

export type GenerationRequestWire = {
  requestId: string;
  status: string;
  prompt: string | null;
  scope: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
};

type RunLedger = {
  requestId: string;
  state: "claimed" | "generating" | "publishing" | "done" | "failed";
  attempts: number;
  startedAt: string;
  finishedAt?: string;
  artifactId?: string;
  error?: string;
  log: string[];
};

const MAX_BACKOFF_MS = 60_000;
const MAX_LEDGER_LOG_LINES = 50;

export function configFromEnv(argv: string[] = []): WorkerConfig {
  const transcriptDirs = (process.env.TRANSCRIPT_DIRS ?? "")
    .split(",")
    .map((dir) => dir.trim())
    .filter((dir) => dir !== "");
  const config: WorkerConfig = {
    hostUrl: process.env.FEED_HOST_URL || "http://127.0.0.1:8787",
    actorId: process.env.FEED_ACTOR_ID || undefined,
    token: process.env.FEED_HOST_TOKEN || undefined,
    insecureTls: process.env.FEED_HOST_INSECURE_TLS === "1",
    transcriptDirs,
    pollMs: Number(process.env.FEED_WORKER_POLL_MS ?? "4000"),
    runsDir: process.env.FEED_WORKER_RUNS_DIR || ".feed-v1-worker/runs",
    model: process.env.FEED_WORKER_MODEL || process.env.MEET_GEN_MODEL || "sonnet",
    generator: process.env.FEED_WORKER_GENERATOR === "stub" ? "stub" : "claude",
    maxAttempts: Math.max(1, Number(process.env.FEED_WORKER_MAX_ATTEMPTS ?? "2")),
    once: process.env.FEED_WORKER_ONCE === "1",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--once") config.once = true;
    else if (arg === "--generator") {
      const value = argv[++i];
      if (value !== "claude" && value !== "stub") throw new Error("--generator must be claude or stub");
      config.generator = value;
    } else if (arg === "--host") {
      config.hostUrl = argv[++i] ?? config.hostUrl;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return config;
}

export function logLine(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, source: "feed-v1-worker", ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

// Errors reported back to the host can contain provider/SQL detail; keep the
// note short and drop anything that looks like credential material.
export function scrubErrorNote(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(bearer|token|secret|key|password)[=:\s][^\s,;]*/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function compactId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export class FeedHostClient {
  constructor(private readonly config: WorkerConfig) {}

  private headers(): Headers {
    const headers = new Headers({ "content-type": "application/json" });
    if (this.config.actorId) headers.set("x-feed-actor-id", this.config.actorId);
    if (this.config.token) headers.set("authorization", `Bearer ${this.config.token}`);
    return headers;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(new URL(path, this.config.hostUrl), {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      tls: this.config.insecureTls ? { rejectUnauthorized: false } : undefined,
    });
  }

  async listAccepted(limit = 10): Promise<GenerationRequestWire[]> {
    const response = await this.request("GET", `/admin/dev/generation-requests?status=accepted&limit=${limit}`);
    if (!response.ok) {
      throw new Error(`list generation requests failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
    }
    const body = (await response.json()) as { items: GenerationRequestWire[] };
    return body.items;
  }

  // Returns false when another worker won the claim (409 status_conflict).
  async claim(requestId: string): Promise<boolean> {
    const response = await this.request("POST", `/admin/dev/generation-requests/${encodeURIComponent(requestId)}/status`, {
      status: "pending",
      expectedStatus: "accepted",
      note: "claimed by feed-v1-worker",
    });
    if (response.status === 409) return false;
    if (!response.ok) {
      throw new Error(`claim failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
    }
    return true;
  }

  async complete(requestId: string, status: "consumed" | "rejected" | "accepted", note?: string): Promise<void> {
    const response = await this.request("POST", `/admin/dev/generation-requests/${encodeURIComponent(requestId)}/status`, {
      status,
      note,
    });
    if (!response.ok) {
      throw new Error(`status update to ${status} failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
    }
  }

  async publish(artifact: unknown): Promise<string> {
    const response = await this.request("POST", "/admin/dev/publish-artifact", { artifact });
    if (!response.ok) {
      throw new Error(`publish failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    }
    const body = (await response.json()) as { artifactId: string };
    return body.artifactId;
  }
}

export class LedgerWriter {
  constructor(private readonly runsDir: string) {}

  private ledgers = new Map<string, RunLedger>();

  async event(requestId: string, event: string, fields: Record<string, unknown> = {}): Promise<void> {
    logLine("info", event, { requestId, ...fields });
    await mkdir(this.runsDir, { recursive: true });
    await appendFile(
      join(this.runsDir, "events.jsonl"),
      `${JSON.stringify({ ts: new Date().toISOString(), requestId, event, ...fields })}\n`,
    );
  }

  async update(requestId: string, patch: Partial<RunLedger>, logMessage?: string): Promise<RunLedger> {
    const current: RunLedger = this.ledgers.get(requestId) ?? {
      requestId,
      state: "claimed",
      attempts: 0,
      startedAt: new Date().toISOString(),
      log: [],
    };
    const next: RunLedger = { ...current, ...patch, log: [...current.log] };
    if (logMessage) {
      next.log.push(`${new Date().toISOString()} ${logMessage}`);
      if (next.log.length > MAX_LEDGER_LOG_LINES) next.log = next.log.slice(-MAX_LEDGER_LOG_LINES);
    }
    this.ledgers.set(requestId, next);
    const dir = join(this.runsDir, requestId.replaceAll("/", "_"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "status.json"), JSON.stringify(next, null, 2));
    return next;
  }
}

export async function processRequest(
  request: GenerationRequestWire,
  client: FeedHostClient,
  ledger: LedgerWriter,
  config: WorkerConfig,
): Promise<boolean> {
  const requestId = request.requestId;
  const claimed = await client.claim(requestId);
  if (!claimed) {
    await ledger.event(requestId, "claim_lost");
    return false;
  }
  await ledger.update(requestId, { state: "claimed" }, "claimed");
  await ledger.event(requestId, "claimed", { prompt: request.prompt ?? undefined });

  let lastError: unknown;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      await ledger.update(requestId, { state: "generating", attempts: attempt }, `generation attempt ${attempt}`);
      const startedAt = performance.now();
      const artifact = await generateInsightArtifact({
        requestId,
        prompt: request.prompt,
        transcriptDirs: config.transcriptDirs,
        model: config.model,
        generator: config.generator,
        log: (message, fields) => logLine("info", message, { requestId, ...fields }),
      });
      await ledger.event(requestId, "generated", {
        artifactHeadline: artifact.headline,
        quotesVerified: artifact.quality.quotes_verified,
        ms: Math.round(performance.now() - startedAt),
      });

      await ledger.update(requestId, { state: "publishing" }, "publishing");
      const feedArtifact = await toFeedArtifact(artifact, {
        skill: "extract-insights",
        runId: `run-feed-worker-${compactId(`${requestId}:${attempt}`)}`,
        disclosureCopy: "Generated locally by the Feed v1 worker from your transcripts (extract-insights).",
      });
      const artifactId = await client.publish(feedArtifact);
      await client.complete(requestId, "consumed", `published ${artifactId}`);
      await ledger.update(
        requestId,
        { state: "done", artifactId, finishedAt: new Date().toISOString() },
        `published ${artifactId}`,
      );
      await ledger.event(requestId, "published", { artifactId });
      return true;
    } catch (error) {
      lastError = error;
      await ledger.event(requestId, "attempt_failed", { attempt, error: scrubErrorNote(error) });
    }
  }

  const note = scrubErrorNote(lastError);
  await client.complete(requestId, "rejected", note).catch((error) => {
    logLine("error", "reject_report_failed", { requestId, error: scrubErrorNote(error) });
  });
  await ledger.update(requestId, { state: "failed", error: note, finishedAt: new Date().toISOString() }, `failed: ${note}`);
  await ledger.event(requestId, "failed", { error: note });
  return true;
}

export async function runWorker(config: WorkerConfig): Promise<void> {
  if (config.transcriptDirs.length === 0) {
    throw new Error("TRANSCRIPT_DIRS is required (comma-separated transcript directories)");
  }
  const client = new FeedHostClient(config);
  const ledger = new LedgerWriter(config.runsDir);
  logLine("info", "worker_started", {
    hostUrl: config.hostUrl,
    generator: config.generator,
    model: config.model,
    transcriptDirs: config.transcriptDirs,
    pollMs: config.pollMs,
    once: config.once,
  });

  let backoffMs = config.pollMs;
  while (true) {
    let processed = false;
    try {
      const requests = await client.listAccepted();
      backoffMs = config.pollMs;
      if (requests.length > 0) {
        logLine("info", "queue_observed", { depth: requests.length, oldest: requests[0]!.createdAt });
        processed = await processRequest(requests[0]!, client, ledger, config);
      }
    } catch (error) {
      logLine("error", "poll_failed", { error: scrubErrorNote(error), backoffMs });
      await Bun.sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      continue;
    }
    if (config.once && processed) return;
    if (!processed) await Bun.sleep(config.pollMs);
  }
}

if (import.meta.main) {
  runWorker(configFromEnv(process.argv.slice(2))).catch((error) => {
    logLine("error", "worker_fatal", { error: scrubErrorNote(error) });
    process.exit(1);
  });
}
