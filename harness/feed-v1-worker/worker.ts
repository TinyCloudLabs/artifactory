#!/usr/bin/env bun
// Feed v1 generation worker: claims generation requests through the Feed
// Host's production worker API, maintains a fenced lease while generating,
// checkpoints artifacts, reconciles projections, and reports one terminal
// outcome. The worker is deliberately single-flight per process.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toFeedArtifact } from "../../skills/_shared/lib/feed-v1-convert.ts";
import type { FeedArtifact, TranscriptSourceRef } from "../../skills/_shared/lib/feed-v1.ts";
import { REVIEWED_STARTER_PACKAGES } from "../../skills/_shared/lib/starter-packages.ts";
import {
  ArtifactQualityRejectedError,
  generateInsightArtifact,
  HeroGenerationError,
  preflightFfmpeg,
  sourceTranscriptPath,
  type GenerationInput,
  type GenerationSource,
  type GeneratorKind,
} from "./generate.ts";
import {
  DEFAULT_WORKFLOW_ID,
  executePackageProfile,
  loadPackageExecutionProfile,
  PackageExecutionProfileError,
} from "./package-execution.ts";

export type WorkerConfig = {
  hostUrl: string;
  actorId?: string;
  token?: string;
  insecureTls: boolean;
  sourceMode: "host" | "local";
  sourceBatchLimit: number;
  transcriptDirs: string[];
  pollMs: number;
  idlePollMsMax: number;
  runsDir: string;
  model: string;
  generator: GeneratorKind;
  maxAttempts: number;
  workflowId: string;
  claimOwner: string;
  leaseSeconds: number;
  heartbeatMs: number;
  ffmpegPath: string;
  packageVersion: string;
  packageDigest?: string;
  once: boolean;
};

export type GenerationRequestWire = {
  requestId: string;
  status: string;
  prompt: string | null;
  scope: Record<string, unknown>;
  packageId: string | null;
  dedupeKey: string | null;
  runId: string | null;
  workflowId: string | null;
  claimOwner: string | null;
  leaseExpiresAt: string | null;
  fencingToken: number;
  attemptCount: number;
  maxAttempts: number;
  phase: string;
  sourceCursorBefore: unknown | null;
  sourceCursorAfter: unknown | null;
  sourceRefs: unknown[];
  publicationKey: string | null;
  artifactIds: string[];
  publicationManifest: unknown[] | null;
  createdAt: string;
  expiresAt: string;
};

export type ClaimResult = {
  request: GenerationRequestWire | null;
  committedCursor: unknown | null;
};

export type ListenSourceCursor = {
  startedAt: string | null;
  conversationId: string;
};

export type ListenSourceItem = {
  conversationId: string;
  title: string;
  startedAt: string | null;
  transcript: string;
  transcriptBytes: number;
  transcriptSha256: string;
  truncated: boolean;
  observedPath?: Exclude<TranscriptSourceRef["observedPath"], "host_source_api">;
};

export type ListenSourceBatch = {
  items: ListenSourceItem[];
  nextCursor: ListenSourceCursor | null;
  count: number;
  bytes: number;
};

type RunLedger = {
  requestId: string;
  state:
    | "claimed"
    | "generating"
    | "publishing"
    | "done"
    | "retry_wait"
    | "dead_letter"
    | "cancelled"
    | "lease_lost"
    | "failed";
  attempts: number;
  startedAt: string;
  finishedAt?: string;
  artifactId?: string;
  error?: string;
  publicationKey?: string;
  publicationDigest?: string;
  log: string[];
};

type WorkerErrorBody = {
  error?: { code?: unknown; message?: unknown };
};

type WorkerFetch = typeof fetch;
type WorkerLog = (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
type MutationResponse = { request: GenerationRequestWire };
type PublicationResponse = {
  outcome: "published" | "zero_artifacts" | "cancelled";
  request: GenerationRequestWire;
  artifactIds: string[];
  publicationKey: string | null;
};

const MAX_BACKOFF_MS = 60_000;
const MAX_LEDGER_LOG_LINES = 50;
const DEFAULT_LEASE_SECONDS = 120;
const MIN_LEASE_SECONDS = 15;
const MAX_LEASE_SECONDS = 900;
const MAX_LISTEN_SOURCE_LIMIT = 10;
const MAX_LISTEN_SOURCE_ITEM_BYTES = 128 * 1024;
const MAX_LISTEN_SOURCE_BATCH_BYTES = 384 * 1024;
const MAX_ARTIFACT_POST_BYTES = 900 * 1024;

export class WorkerApiError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`worker API ${operation} failed (${status || "network"}, ${code}): ${message}`, options);
    this.name = "WorkerApiError";
    this.retryable = status === 0 || status === 408 || status === 429 || status >= 500;
  }
}

export class PublicationConflictError extends Error {
  readonly code = "publication_conflict";
  readonly retryable = false;

  constructor(message = "publication checkpoint conflicts with the immutable manifest") {
    super(message);
    this.name = "PublicationConflictError";
  }
}

export class ArtifactPayloadError extends Error {
  readonly code = "artifact_payload_too_large";
  readonly retryable = false;

  constructor() {
    super("artifact publication exceeds the worker transport budget");
    this.name = "ArtifactPayloadError";
  }
}

function boundedIntegerEnv(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

function requiredEnv(name: "FEED_WORKER_PACKAGE_VERSION" | "FEED_WORKER_PACKAGE_DIGEST"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required so published artifacts identify the reviewed worker package`);
  return value;
}

export function configFromEnv(argv: string[] = []): WorkerConfig {
  const sourceSetting = process.env.FEED_WORKER_SOURCE ?? "host";
  if (sourceSetting !== "host" && sourceSetting !== "local") {
    throw new Error("FEED_WORKER_SOURCE must be host or local");
  }
  const transcriptDirs = (process.env.TRANSCRIPT_DIRS ?? "")
    .split(",")
    .map((dir) => dir.trim())
    .filter((dir) => dir !== "");
  const leaseSeconds = boundedIntegerEnv(
    process.env.FEED_WORKER_LEASE_SECONDS,
    DEFAULT_LEASE_SECONDS,
    MIN_LEASE_SECONDS,
    MAX_LEASE_SECONDS,
  );
  const defaultHeartbeatMs = Math.max(1_000, Math.floor((leaseSeconds * 1_000) / 3));
  const config: WorkerConfig = {
    hostUrl: process.env.FEED_HOST_URL || "http://127.0.0.1:8787",
    actorId: process.env.FEED_ACTOR_ID || undefined,
    token: process.env.FEED_HOST_TOKEN || undefined,
    insecureTls: process.env.FEED_HOST_INSECURE_TLS === "1",
    sourceMode: sourceSetting,
    sourceBatchLimit: boundedIntegerEnv(
      process.env.FEED_WORKER_SOURCE_BATCH_LIMIT,
      5,
      1,
      MAX_LISTEN_SOURCE_LIMIT,
    ),
    transcriptDirs,
    pollMs: boundedIntegerEnv(process.env.FEED_WORKER_POLL_MS, 4_000, 1, MAX_BACKOFF_MS),
    idlePollMsMax: boundedIntegerEnv(process.env.FEED_WORKER_IDLE_POLL_MS_MAX, MAX_BACKOFF_MS, 1, 600_000),
    runsDir: process.env.FEED_WORKER_RUNS_DIR || ".feed-v1-worker/runs",
    model: process.env.FEED_WORKER_MODEL || process.env.MEET_GEN_MODEL || "sonnet",
    generator: process.env.FEED_WORKER_GENERATOR === "stub" ? "stub" : "claude",
    maxAttempts: boundedIntegerEnv(process.env.FEED_WORKER_MAX_ATTEMPTS, 2, 1, 10),
    workflowId: process.env.FEED_WORKER_WORKFLOW_ID || DEFAULT_WORKFLOW_ID,
    claimOwner: process.env.FEED_WORKER_CLAIM_OWNER || `feed-v1-worker-${process.pid}`,
    leaseSeconds,
    heartbeatMs: boundedIntegerEnv(
      process.env.FEED_WORKER_HEARTBEAT_MS,
      defaultHeartbeatMs,
      1,
      Math.max(1, leaseSeconds * 1_000 - 1),
    ),
    ffmpegPath: process.env.FEED_WORKER_FFMPEG_PATH?.trim() || Bun.which("ffmpeg") || "ffmpeg",
    packageVersion: requiredEnv("FEED_WORKER_PACKAGE_VERSION"),
    packageDigest: requiredEnv("FEED_WORKER_PACKAGE_DIGEST"),
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
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// Errors sent to the Host can contain provider detail. Keep the message short
// and remove common credential forms before it crosses the API boundary.
export function scrubErrorNote(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(bearer|token|secret|key|password)[=:\s][^\s,;]*/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s?]+\?[^\s]*/gi, "[redacted-url]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function compactId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export class FeedHostClient {
  constructor(
    private readonly config: WorkerConfig,
    private readonly fetchImpl: WorkerFetch = fetch,
    private readonly log: WorkerLog = logLine,
  ) {}

  private headers(): Headers {
    const headers = new Headers({ "content-type": "application/json" });
    if (this.config.token) headers.set("authorization", `Bearer ${this.config.token}`);
    return headers;
  }

  private actorId(): string {
    if (!this.config.actorId) throw new Error("FEED_ACTOR_ID is required for the Feed Host worker API");
    return this.config.actorId;
  }

  private identity(request: GenerationRequestWire): Record<string, unknown> {
    if (!request.runId || !request.claimOwner || request.fencingToken < 1) {
      throw new Error(`claimed request ${request.requestId} is missing its worker lease identity`);
    }
    return {
      actorId: this.actorId(),
      runId: request.runId,
      claimOwner: request.claimOwner,
      fencingToken: request.fencingToken,
    };
  }

  private async post<T>(
    operation: string,
    path: string,
    body: Record<string, unknown>,
    resultCode: (value: T) => string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.config.hostUrl), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        tls: this.config.insecureTls ? { rejectUnauthorized: false } : undefined,
      });
    } catch (error) {
      this.log("error", "worker_api_call", { operation, path, resultCode: "error:network_error" });
      throw new WorkerApiError(operation, 0, "network_error", "request could not reach the Feed Host", { cause: error });
    }

    const value = await response.json().catch(() => null) as T | WorkerErrorBody | null;
    if (!response.ok) {
      const errorBody = value as WorkerErrorBody | null;
      const code = typeof errorBody?.error?.code === "string" ? errorBody.error.code : `http_${response.status}`;
      const message = typeof errorBody?.error?.message === "string" ? errorBody.error.message : "Feed Host rejected the request";
      this.log(response.status >= 500 ? "error" : "warn", "worker_api_call", {
        operation,
        path,
        status: response.status,
        resultCode: `error:${code}`,
      });
      throw new WorkerApiError(operation, response.status, code, message);
    }
    if (!value || typeof value !== "object") {
      this.log("error", "worker_api_call", { operation, path, status: response.status, resultCode: "error:invalid_response" });
      throw new WorkerApiError(operation, response.status, "invalid_response", "Feed Host returned a non-JSON response");
    }
    const code = resultCode(value as T);
    this.log("info", "worker_api_call", { operation, path, status: response.status, resultCode: code });
    return value as T;
  }

  async claim(workflowId = this.config.workflowId): Promise<ClaimResult> {
    return this.post<ClaimResult>(
      "claim",
      "/api/worker/generation-requests/claim",
      {
        actorId: this.actorId(),
        workflowId,
        claimOwner: this.config.claimOwner,
        leaseSeconds: this.config.leaseSeconds,
        maxAttempts: this.config.maxAttempts,
      },
      (value) => value.request ? "claimed" : "empty",
    );
  }

  async heartbeat(request: GenerationRequestWire): Promise<GenerationRequestWire> {
    const response = await this.post<MutationResponse>(
      "heartbeat",
      this.requestPath(request, "heartbeat"),
      { ...this.identity(request), leaseSeconds: this.config.leaseSeconds },
      () => "extended",
    );
    return response.request;
  }

  async sources(
    request: GenerationRequestWire,
    cursor: unknown | null,
    limit: number,
  ): Promise<ListenSourceBatch> {
    const response = await this.post<ListenSourceBatch>(
      "sources",
      this.requestPath(request, "sources"),
      {
        ...this.identity(request),
        limit,
        ...(cursor === null ? {} : { cursor }),
      },
      (value) => `batch:${value.count}:${value.nextCursor ? "continued" : "complete"}`,
    );
    return validateSourceBatch(response, limit);
  }

  async phase(
    request: GenerationRequestWire,
    phase: "running" | "validating",
    metadata?: { sourceCursorAfter?: unknown; sourceRefs?: unknown[] },
  ): Promise<GenerationRequestWire> {
    const response = await this.post<MutationResponse>(
      "phase",
      this.requestPath(request, "phase"),
      { ...this.identity(request), phase, ...(metadata ? { metadata } : {}) },
      () => phase,
    );
    return response.request;
  }

  async submitArtifacts(
    request: GenerationRequestWire,
    options: { publicationKey?: string; artifacts?: FeedArtifact[] } = {},
  ): Promise<PublicationResponse> {
    const body = { ...this.identity(request), ...options };
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_ARTIFACT_POST_BYTES) {
      throw new ArtifactPayloadError();
    }
    return this.post<PublicationResponse>(
      "artifacts",
      this.requestPath(request, "artifacts"),
      body,
      (value) => value.outcome,
    );
  }

  async reconcile(request: GenerationRequestWire): Promise<{ request: GenerationRequestWire; feedItemIds: string[] }> {
    return this.post(
      "reconcile",
      this.requestPath(request, "reconcile"),
      this.identity(request),
      () => "reconciled",
    );
  }

  async complete(
    request: GenerationRequestWire,
    outcome: "published" | "zero_artifacts",
    cursor: unknown,
    artifactIds: string[],
  ): Promise<GenerationRequestWire> {
    const response = await this.post<MutationResponse>(
      "complete",
      this.requestPath(request, "complete"),
      { ...this.identity(request), outcome, cursor, artifactIds },
      (value) => `${value.request.status}:${value.request.phase}`,
    );
    return response.request;
  }

  async retry(
    request: GenerationRequestWire,
    options: { errorCode: string; errorMessage: string; retryable: boolean; retryAfterSeconds: number },
  ): Promise<GenerationRequestWire> {
    const response = await this.post<MutationResponse>(
      "retry",
      this.requestPath(request, "retry"),
      { ...this.identity(request), ...options },
      (value) => value.request.status,
    );
    return response.request;
  }

  private requestPath(request: GenerationRequestWire, action: string): string {
    return `/api/worker/generation-requests/${encodeURIComponent(request.requestId)}/${action}`;
  }
}

class LeaseHeartbeat {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;
  private failure: unknown;

  constructor(
    private readonly request: GenerationRequestWire,
    private readonly client: FeedHostClient,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.schedule();
  }

  throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }

  async stop(): Promise<unknown | undefined> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
    return this.failure;
  }

  private schedule(): void {
    if (this.stopped || this.failure) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.client.heartbeat(this.request)
        .then(() => undefined)
        .catch((error) => {
          this.failure = error;
        })
        .finally(() => {
          this.inFlight = undefined;
          this.schedule();
        });
    }, this.intervalMs);
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
    const current: RunLedger = await this.current(requestId);
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

  /**
   * Write-once, content-free publication evidence. The Host owns the complete
   * append-only manifest; this local checkpoint stores only ids and hashes so
   * generated copy or transcript material never enters run metadata.
   */
  async checkpointPublication(
    requestId: string,
    publicationKey: string,
    artifacts: FeedArtifact[],
  ): Promise<{ publicationKey: string; publicationDigest: string }> {
    const manifest = artifacts
      .map((artifact) => ({
        artifactId: artifact.artifactId,
        sha256: `sha256:${createHash("sha256").update(stableJson(jsonRoundTrip(artifact))).digest("hex")}`,
      }))
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    const publicationDigest = `sha256:${createHash("sha256").update(stableJson(manifest)).digest("hex")}`;
    const checkpoint = { publicationKey, publicationDigest, artifactIds: manifest.map((entry) => entry.artifactId) };
    const dir = join(this.runsDir, requestId.replaceAll("/", "_"));
    const path = join(dir, "publication.checkpoint.json");
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(path, JSON.stringify(checkpoint, null, 2), { flag: "wx" });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = JSON.parse(await readFile(path, "utf8")) as typeof checkpoint;
      if (stableJson(existing) !== stableJson(checkpoint)) throw new PublicationConflictError();
    }
    await this.update(requestId, { publicationKey, publicationDigest }, "publication manifest checkpointed");
    return { publicationKey, publicationDigest };
  }

  private async current(requestId: string): Promise<RunLedger> {
    const cached = this.ledgers.get(requestId);
    if (cached) return cached;
    try {
      const raw = await readFile(join(this.runsDir, requestId.replaceAll("/", "_"), "status.json"), "utf8");
      const parsed = JSON.parse(raw) as RunLedger;
      if (parsed.requestId === requestId && Array.isArray(parsed.log)) {
        this.ledgers.set(requestId, parsed);
        return parsed;
      }
    } catch {
      // No prior local run state is normal on a reclaimed worker.
    }
    return {
      requestId,
      state: "claimed",
      attempts: 0,
      startedAt: new Date().toISOString(),
      log: [],
    };
  }
}

type ProcessDependencies = {
  generate?: (input: GenerationInput) => ReturnType<typeof generateInsightArtifact>;
};

export async function processRequest(
  request: GenerationRequestWire,
  committedCursor: unknown | null,
  client: FeedHostClient,
  ledger: LedgerWriter,
  config: WorkerConfig,
  dependencies: ProcessDependencies = {},
): Promise<boolean> {
  const requestId = request.requestId;
  const generate = dependencies.generate ?? generateInsightArtifact;
  const heartbeat = new LeaseHeartbeat(request, client, config.heartbeatMs);
  let heartbeatStopped = false;

  await ledger.update(requestId, { state: "claimed", attempts: request.attemptCount }, "claimed");
  await ledger.event(requestId, "claimed", { attempt: request.attemptCount, phase: request.phase });
  heartbeat.start();

  try {
    let publication: PublicationResponse;
    let cursorAfter = request.sourceCursorAfter ?? committedCursor;

    if (request.phase === "publishing") {
      await ledger.update(requestId, { state: "publishing" }, "resuming publication");
      const manifest = feedArtifactsFromManifest(request.publicationManifest);
      if (manifest) {
        await ledger.checkpointPublication(
          requestId,
          requirePublicationKey(request),
          manifest,
        );
      }
      publication = await client.submitArtifacts(request);
    } else if (request.phase === "reconciling") {
      await ledger.update(requestId, { state: "publishing" }, "resuming reconciliation");
      const manifest = feedArtifactsFromManifest(request.publicationManifest);
      if (manifest) {
        await ledger.checkpointPublication(
          requestId,
          requirePublicationKey(request),
          manifest,
        );
      }
      publication = {
        outcome: request.artifactIds.length > 0 ? "published" : "zero_artifacts",
        request,
        artifactIds: request.artifactIds,
        publicationKey: request.publicationKey,
      };
    } else {
      await client.phase(request, "running");
      heartbeat.throwIfFailed();
      await ledger.update(requestId, { state: "generating" }, `generation attempt ${request.attemptCount}`);
      let sources: ListenSourceBatch | undefined;
      let generationSources: GenerationSource[] | undefined;
      if (config.sourceMode === "host") {
        sources = await client.sources(
          request,
          request.sourceCursorBefore ?? committedCursor,
          config.sourceBatchLimit,
        );
        if (sources.items.length === 0) cursorAfter = sources.nextCursor;
        generationSources = sources.items.map((source) => ({
          sourceId: source.conversationId,
          title: source.title,
          startedAt: source.startedAt,
          transcript: source.transcript,
          transcriptSha256: source.transcriptSha256,
          truncated: source.truncated,
        }));
        await ledger.event(requestId, "source_batch", {
          count: sources.count,
          bytes: sources.bytes,
          continuation: sources.nextCursor !== null,
        });
      }
      heartbeat.throwIfFailed();

      const feedArtifacts: FeedArtifact[] = [];
      if (config.sourceMode === "local" || (generationSources?.length ?? 0) > 0) {
        const startedAt = performance.now();
        try {
          if (!request.runId) throw new Error(`claimed request ${requestId} has no runId`);
          const claimedWorkflowId = request.workflowId ?? config.workflowId;
          if (request.packageId && request.packageId !== claimedWorkflowId) {
            throw new PackageExecutionProfileError(
              `claimed packageId=${request.packageId} does not match workflowId=${claimedWorkflowId}`,
            );
          }
          const log = (message: string, fields?: Record<string, unknown>, level: "info" | "warn" | "error" = "info") =>
            logLine(level, message, { requestId, ...fields });
          const producer = config.generator === "stub"
            ? {
                runtimeClass: "stub" as const,
                providerClass: "none" as const,
                credentialOwner: "none" as const,
                egressClass: "none" as const,
              }
            : {
                runtimeClass: config.sourceMode === "host" ? "hosted_private" as const : "local" as const,
                providerClass: "user_byok" as const,
                credentialOwner: workerCredentialMode(),
                egressClass: "media_provider" as const,
              };
          let artifact: Awaited<ReturnType<typeof generateInsightArtifact>>;
          let feedArtifact: FeedArtifact;
          if (claimedWorkflowId === DEFAULT_WORKFLOW_ID) {
            artifact = await generate({
              requestId,
              prompt: request.prompt,
              transcriptDirs: config.transcriptDirs,
              sources: generationSources,
              model: config.model,
              generator: config.generator,
              ffmpegPath: config.ffmpegPath,
              log,
            });
            const sourceRefs = sources ? sourceRefsForBatch(sources, artifact, request.createdAt) : undefined;
            feedArtifact = await toFeedArtifact(artifact, {
              skill: "extract-insights",
              runId: request.runId,
              sourceRefs,
              packageId: request.packageId ?? config.workflowId,
              packageVersion: config.packageVersion,
              packageDigest: config.packageDigest,
              producer,
              model: artifact.generation_model ?? config.model,
              disclosureCopy: config.sourceMode === "host"
                ? "Generated privately by the Feed worker from delegated Listen sources using configured model providers."
                : "Generated by the explicitly selected local transcript fallback.",
            });
          } else {
            const profile = await loadPackageExecutionProfile(claimedWorkflowId);
            const executed = await executePackageProfile({
              profile,
              requestId,
              runId: request.runId,
              prompt: request.prompt,
              settings: requestSettings(request.scope),
              transcriptDirs: config.transcriptDirs,
              sources: generationSources,
              resolveSourceRefs: sources
                ? (generated) => sourceRefsForBatch(sources, generated, request.createdAt)
                : undefined,
              model: config.model,
              generator: config.generator,
              producer,
              ffmpegPath: config.ffmpegPath,
              log,
            });
            artifact = executed.legacyArtifact;
            feedArtifact = executed.feedArtifact;
          }
          heartbeat.throwIfFailed();
          await ledger.event(requestId, "generated", {
            packageId: feedArtifact.producedBy.packageId,
            quotesVerified: artifact.quality.quotes_verified,
            criticPass: artifact.quality.critic_pass,
            heroAttached: Boolean(artifact.hero_image),
            ms: Math.round(performance.now() - startedAt),
          });

          if (sources) cursorAfter = committedCursorForArtifact(sources, artifact);
          feedArtifacts.push(feedArtifact);
          if (config.sourceMode === "local") {
            cursorAfter = { completedRequestId: requestId, generatedAt: artifact.generated_at, source: "local" };
          }
        } catch (error) {
          if (!(error instanceof ArtifactQualityRejectedError)) throw error;
          // A twice-rejected card is a valid typed completion, not an
          // operational failure. Consume the fenced batch so a later request
          // does not loop over the same below-floor generation indefinitely.
          cursorAfter = sources
            ? committedCursorForSourcePaths(sources, error.sourceTranscripts)
            : {
                completedRequestId: requestId,
                generatedAt: new Date().toISOString(),
                source: "local",
              };
          await ledger.event(requestId, "quality_zero_artifacts", {
            attempts: 2,
            issueCount: error.issues.length,
            detail: "quality_attempts_exhausted",
            ms: Math.round(performance.now() - startedAt),
          });
        }
      }
      await client.phase(request, "validating", {
        sourceCursorAfter: cursorAfter,
        sourceRefs: feedArtifacts.flatMap((artifact) => artifact.sourceRefs),
      });
      heartbeat.throwIfFailed();
      await ledger.update(requestId, { state: "publishing" }, "checkpointing artifacts");
      const publicationKey = `feed-v1-worker:${compactId(requestId)}`;
      publication = await client.submitArtifacts(request, {
        publicationKey,
        artifacts: feedArtifacts,
      });
      // The Host commit is the authoritative append-only boundary. Record the
      // content-free local digest only after that checkpoint succeeds; if the
      // response is lost, a reclaimed claim exposes the Host manifest and the
      // publishing/reconciling branches verify it before replay.
      if (publication.outcome !== "cancelled") {
        await ledger.checkpointPublication(
          requestId,
          publicationKey,
          feedArtifactsFromManifest(publication.request.publicationManifest) ?? feedArtifacts,
        );
      }
    }

    heartbeat.throwIfFailed();
    if (publication.outcome === "cancelled") {
      await heartbeat.stop();
      heartbeatStopped = true;
      await ledger.update(
        requestId,
        { state: "cancelled", finishedAt: new Date().toISOString() },
        "cancelled before publication boundary",
      );
      await ledger.event(requestId, "cancelled");
      return true;
    }

    await client.reconcile(request);
    heartbeat.throwIfFailed();
    const completed = await client.complete(request, publication.outcome, cursorAfter, publication.artifactIds);
    // Keep extending the lease through the terminal completion request. A
    // successful completion is authoritative even if a heartbeat that was
    // already in flight observes the newly consumed request as stale.
    await heartbeat.stop();
    heartbeatStopped = true;
    const artifactId = publication.artifactIds[0];
    await ledger.update(
      requestId,
      { state: "done", artifactId, finishedAt: new Date().toISOString() },
      `completed ${completed.phase}`,
    );
    await ledger.event(requestId, "published", { artifactId, outcome: publication.outcome });
    return true;
  } catch (error) {
    const heartbeatFailure = heartbeatStopped ? undefined : await heartbeat.stop();
    heartbeatStopped = true;
    const failure = heartbeatFailure ?? error;
    const note = scrubErrorNote(failure);

    if (isLeaseLost(failure)) {
      await ledger.update(
        requestId,
        { state: "lease_lost", error: note, finishedAt: new Date().toISOString() },
        `lease lost: ${note}`,
      );
      await ledger.event(requestId, "lease_lost", { errorCode: "stale_generation_lease" });
      return true;
    }
    if (failure instanceof WorkerApiError && failure.status === 401) {
      await ledger.update(
        requestId,
        { state: "failed", error: note, finishedAt: new Date().toISOString() },
        `worker authorization failed: ${note}`,
      );
      throw failure;
    }
    if (isPublicationConflict(failure)) {
      await ledger.update(
        requestId,
        { state: "failed", error: note, finishedAt: new Date().toISOString() },
        `immutable publication conflict: ${note}`,
      );
      await ledger.event(requestId, "publication_failed", { errorCode: "publication_conflict" });
      throw failure;
    }

    const failureInfo = classifyFailure(failure);
    const finalAttempt = request.attemptCount >= request.maxAttempts;
    try {
      const terminal = await client.retry(request, {
        errorCode: failureInfo.code,
        errorMessage: note,
        // Never rely on the Host to infer exhaustion from a claim it already
        // handed out. The last attempt explicitly requests dead-lettering so
        // dedupe can release the terminal request.
        retryable: finalAttempt ? false : failureInfo.retryable,
        retryAfterSeconds: Math.max(1, Math.ceil(config.pollMs / 1_000)),
      });
      const state = terminal.status === "dead_letter" ? "dead_letter" : terminal.status === "cancelled" ? "cancelled" : "retry_wait";
      await ledger.update(
        requestId,
        { state, error: note, finishedAt: state === "retry_wait" ? undefined : new Date().toISOString() },
        `${state}: ${note}`,
      );
      await ledger.event(requestId, "attempt_failed", {
        attempt: request.attemptCount,
        errorCode: failureInfo.code,
        detail: failureInfo.detail,
        terminalStatus: terminal.status,
      });
      return true;
    } catch (reportError) {
      if (isLeaseLost(reportError)) {
        await ledger.update(
          requestId,
          { state: "lease_lost", error: note, finishedAt: new Date().toISOString() },
          `failure could not be reported after lease loss: ${note}`,
        );
        return true;
      }
      throw reportError;
    }
  }
}

function validateSourceBatch(value: ListenSourceBatch, limit: number): ListenSourceBatch {
  if (
    !value ||
    !Array.isArray(value.items) ||
    value.items.length > limit ||
    value.count !== value.items.length ||
    !Number.isInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > MAX_LISTEN_SOURCE_BATCH_BYTES ||
    Buffer.byteLength(JSON.stringify(value), "utf8") !== value.bytes ||
    !isListenSourceCursor(value.nextCursor)
  ) {
    throw new WorkerApiError("sources", 200, "invalid_source_batch", "Feed Host returned an invalid source batch");
  }
  for (const item of value.items) {
    if (
      !item ||
      typeof item.conversationId !== "string" ||
      item.conversationId.length === 0 ||
      item.conversationId.length > 512 ||
      typeof item.title !== "string" ||
      (item.startedAt !== null && !isRfc3339(item.startedAt)) ||
      typeof item.transcript !== "string" ||
      !Number.isInteger(item.transcriptBytes) ||
      item.transcriptBytes < 0 ||
      item.transcriptBytes > MAX_LISTEN_SOURCE_ITEM_BYTES ||
      typeof item.transcriptSha256 !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(item.transcriptSha256) ||
      typeof item.truncated !== "boolean" ||
      (item.observedPath !== undefined &&
        !["kv_transcript", "sql_transcript_json", "sql_transcript_text"].includes(item.observedPath))
    ) {
      throw new WorkerApiError("sources", 200, "invalid_source_batch", "Feed Host returned an invalid source item");
    }
    if (Buffer.byteLength(item.transcript, "utf8") !== item.transcriptBytes) {
      throw new WorkerApiError("sources", 200, "invalid_source_batch", "Feed Host returned inconsistent source bytes");
    }
    const actualHash = `sha256:${createHash("sha256").update(item.transcript).digest("hex")}`;
    // A truncated item's hash intentionally identifies the complete source,
    // which the bounded worker response does not possess and cannot recompute.
    if (!item.truncated && item.transcriptSha256 !== actualHash) {
      throw new WorkerApiError("sources", 200, "invalid_source_batch", "Feed Host returned an inconsistent source hash");
    }
  }
  return value;
}

function isListenSourceCursor(value: unknown): value is ListenSourceCursor | null {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  return Object.keys(cursor).every((key) => key === "startedAt" || key === "conversationId") &&
    typeof cursor.conversationId === "string" &&
    cursor.conversationId.length > 0 &&
    cursor.conversationId.length <= 512 &&
    (cursor.startedAt === null || isRfc3339(cursor.startedAt));
}

function isRfc3339(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function committedCursorForArtifact(
  batch: ListenSourceBatch,
  artifact: Awaited<ReturnType<typeof generateInsightArtifact>>,
): ListenSourceCursor | null {
  return committedCursorForSourcePaths(batch, artifact.source_transcripts);
}

function committedCursorForSourcePaths(
  batch: ListenSourceBatch,
  sourcePaths: string[],
): ListenSourceCursor | null {
  const usedPaths = new Set(sourcePaths);
  let lastUsedIndex = -1;
  for (const [index, source] of batch.items.entries()) {
    if (usedPaths.has(sourceTranscriptPath(source.conversationId))) lastUsedIndex = index;
  }
  if (lastUsedIndex < 0) {
    throw new WorkerApiError(
      "sources",
      200,
      "invalid_generation_provenance",
      "generated artifact does not reference any source from its fenced batch",
    );
  }
  if (lastUsedIndex === batch.items.length - 1) return batch.nextCursor;
  const source = batch.items[lastUsedIndex]!;
  return { startedAt: source.startedAt, conversationId: source.conversationId };
}

function sourceRefsForBatch(
  batch: ListenSourceBatch,
  artifact: Awaited<ReturnType<typeof generateInsightArtifact>>,
  fallbackObservedAt: string,
): TranscriptSourceRef[] {
  const usedPaths = new Set(artifact.source_transcripts);
  return batch.items.filter((source) => usedPaths.has(sourceTranscriptPath(source.conversationId))).map((source) => {
    const transcriptPath = sourceTranscriptPath(source.conversationId);
    const observedAt = source.startedAt && !Number.isNaN(Date.parse(source.startedAt))
      ? source.startedAt
      : fallbackObservedAt;
    return {
      sourceRefId: `listen-conversation:${compactId(source.conversationId)}`,
      sourceKind: "listen_conversation",
      sourceId: source.conversationId,
      // The Host currently abstracts whether it obtained the transcript from
      // Listen KV or an authorized SQL fallback. Record that truthful API
      // boundary unless a newer Host supplies the exact storage path.
      observedPath: source.observedPath ?? "host_source_api",
      observedHash: source.transcriptSha256,
      observedAt,
      quoteLineRefs: artifact.source_quotes
        ?.filter((quote) => quote.transcript === transcriptPath)
        .map((quote) => quote.timestamp ?? `quote:${compactId(quote.quote)}`),
    };
  });
}

function workerCredentialMode(): "user_byok_api_key" | "user_oauth_token" {
  if (
    !process.env.ANTHROPIC_API_KEY &&
    process.env.CLAUDE_CODE_OAUTH_TOKEN &&
    !process.env.GOOGLE_AI_API_KEY &&
    !process.env.GEMINI_API_KEY &&
    !process.env.GOOGLE_API_KEY
  ) {
    return "user_oauth_token";
  }
  return "user_byok_api_key";
}

function feedArtifactsFromManifest(value: unknown[] | null): FeedArtifact[] | undefined {
  if (value === null) return undefined;
  if (!Array.isArray(value)) throw new PublicationConflictError("publication manifest has an invalid shape");
  return value as FeedArtifact[];
}

function requirePublicationKey(request: GenerationRequestWire): string {
  if (!request.publicationKey) throw new PublicationConflictError("publication manifest is missing its immutable key");
  return request.publicationKey;
}

function isPublicationConflict(error: unknown): boolean {
  return error instanceof PublicationConflictError ||
    (error instanceof WorkerApiError && error.code === "publication_conflict");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isLeaseLost(error: unknown): boolean {
  return error instanceof WorkerApiError && error.status === 409 && error.code === "stale_generation_lease";
}

function classifyFailure(error: unknown): { code: string; retryable: boolean; detail: string } {
  if (error instanceof PackageExecutionProfileError) {
    return { code: error.code, retryable: error.retryable, detail: scrubErrorNote(error) };
  }
  if (error instanceof HeroGenerationError) {
    return { code: error.code, retryable: error.retryable, detail: error.detail };
  }
  if (error instanceof PublicationConflictError || error instanceof ArtifactPayloadError) {
    return { code: error.code, retryable: error.retryable, detail: scrubErrorNote(error) };
  }
  if (error instanceof WorkerApiError) {
    return {
      code: error.code.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 100),
      retryable: error.retryable,
      detail: scrubErrorNote(error),
    };
  }
  return { code: "generation_failed", retryable: true, detail: scrubErrorNote(error) };
}

function requestSettings(scope: Record<string, unknown>): Record<string, unknown> {
  const settings = scope.settings;
  return settings !== null && typeof settings === "object" && !Array.isArray(settings)
    ? settings as Record<string, unknown>
    : {};
}

// Every claim poll costs the Host one signed tinycloud.sql/read against the
// production node, so an empty queue must not be polled at the active cadence
// (TC-315). Doubles per empty claim up to the cap; the loop resets to pollMs
// the moment a claim returns work. The cap never drops below pollMs so a
// misconfigured FEED_WORKER_IDLE_POLL_MS_MAX cannot speed polling up.
export function nextIdlePollMs(
  currentMs: number,
  config: Pick<WorkerConfig, "pollMs" | "idlePollMsMax">,
): number {
  const cap = Math.max(config.pollMs, config.idlePollMsMax);
  return Math.min(Math.max(currentMs, config.pollMs) * 2, cap);
}

/**
 * The Host claim API is deliberately workflow-scoped. In the normal deployed
 * configuration one worker therefore has to visit every reviewed queue; a
 * non-default FEED_WORKER_WORKFLOW_ID remains a single-queue operational
 * override for targeted workers and local debugging.
 */
export function claimWorkflowIds(configuredWorkflowId: string): string[] {
  if (configuredWorkflowId !== DEFAULT_WORKFLOW_ID) return [configuredWorkflowId];
  return [
    DEFAULT_WORKFLOW_ID,
    ...REVIEWED_STARTER_PACKAGES.map((pkg) => pkg.packageId),
  ];
}

export async function claimNextAvailableWorkflow(
  client: Pick<FeedHostClient, "claim">,
  workflowIds: string[],
): Promise<ClaimResult | undefined> {
  if (workflowIds.length === 0) throw new Error("worker must have at least one workflow queue to claim");
  for (const workflowId of workflowIds) {
    const candidate = await client.claim(workflowId);
    if (candidate.request) return candidate;
  }
  return undefined;
}

export async function runWorker(config: WorkerConfig): Promise<void> {
  if (config.sourceMode === "local" && config.transcriptDirs.length === 0) {
    throw new Error("TRANSCRIPT_DIRS is required when FEED_WORKER_SOURCE=local");
  }
  if (!config.actorId) throw new Error("FEED_ACTOR_ID is required for the Feed Host worker API");
  if (!config.token) throw new Error("FEED_HOST_TOKEN is required for the Feed Host worker API");
  await preflightFfmpeg(config.ffmpegPath);

  const client = new FeedHostClient(config);
  const ledger = new LedgerWriter(config.runsDir);
  logLine("info", "worker_started", {
    hostUrl: config.hostUrl,
    workflowId: config.workflowId,
    claimWorkflowIds: claimWorkflowIds(config.workflowId),
    claimOwner: config.claimOwner,
    generator: config.generator,
    model: config.model,
    sourceMode: config.sourceMode,
    sourceBatchLimit: config.sourceBatchLimit,
    ...(config.sourceMode === "local" ? { transcriptDirCount: config.transcriptDirs.length } : {}),
    pollMs: config.pollMs,
    idlePollMsMax: config.idlePollMsMax,
    leaseSeconds: config.leaseSeconds,
    ffmpegPath: config.ffmpegPath,
    once: config.once,
  });

  let backoffMs = config.pollMs;
  let idleMs = config.pollMs;
  const workflowIds = claimWorkflowIds(config.workflowId);
  while (true) {
    try {
      // Keep the legacy queue first. The current Host also allows a
      // workflow-scoped claim to bind an older unscoped request, so visiting
      // the default queue before starter queues preserves the deployed
      // extract-insights fallback for all requests already waiting at scan
      // start.
      const claim = await claimNextAvailableWorkflow(client, workflowIds);
      backoffMs = config.pollMs;
      if (claim?.request) {
        idleMs = config.pollMs;
        await processRequest(claim.request, claim.committedCursor, client, ledger, config);
        if (config.once) return;
        continue;
      }
      await Bun.sleep(idleMs);
      idleMs = nextIdlePollMs(idleMs, config);
    } catch (error) {
      if (
        (error instanceof WorkerApiError || error instanceof PublicationConflictError || error instanceof ArtifactPayloadError) &&
        !error.retryable
      ) throw error;
      logLine("error", "poll_failed", { error: scrubErrorNote(error), backoffMs });
      await Bun.sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }
}

if (import.meta.main) {
  runWorker(configFromEnv(process.argv.slice(2))).catch((error) => {
    logLine("error", "worker_fatal", { error: scrubErrorNote(error) });
    process.exit(1);
  });
}
