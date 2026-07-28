import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact } from "../../skills/_shared/lib/artifact.ts";
import { validateFeedArtifact } from "../../skills/_shared/lib/feed-v1.ts";
import {
  ArtifactQualityRejectedError,
  attachHeroImage,
  claudeCommand,
  criticCommand,
  generateInsightArtifact,
  HeroGenerationError,
  markdownWordCount,
  parseDraft,
  resizeHeroImage,
  STUB_HERO_DATA_URI,
  type DraftCard,
} from "./generate.ts";
import {
  FeedHostClient,
  configFromEnv,
  LedgerWriter,
  nextIdlePollMs,
  PublicationConflictError,
  processRequest,
  runWorker,
  scrubErrorNote,
  WorkerApiError,
  type ListenSourceItem,
  type GenerationRequestWire,
  type WorkerConfig,
} from "./worker.ts";

const TRANSCRIPT = `# Weekly sync

Alice (00:01): We decided to move the artifact pipeline to the new Feed Host because the legacy path cannot enforce budgets atomically.
Bob (00:02): The interesting part is that nobody else has noticed the projection reconciliation cost grows with every artifact we publish.
Alice (00:03): Right, so the worker needs backpressure from day one or the queue will silently grow forever.
`;

function sourceItem(
  conversationId: string,
  startedAt: string,
  transcript: string,
  observedPath?: ListenSourceItem["observedPath"],
): ListenSourceItem {
  return {
    conversationId,
    title: `Source ${conversationId}`,
    startedAt,
    transcript,
    transcriptBytes: Buffer.byteLength(transcript, "utf8"),
    transcriptSha256: `sha256:${createHash("sha256").update(transcript).digest("hex")}`,
    truncated: false,
    ...(observedPath ? { observedPath } : {}),
  };
}

type ApiCall = {
  action: string;
  path: string;
  authorization: string | null;
  body: Record<string, unknown>;
};

type MockWorkerHost = {
  calls: ApiCall[];
  artifacts: unknown[];
  logs: Array<{ event: string; resultCode?: unknown }>;
  request: GenerationRequestWire;
  fetch: typeof fetch;
};

function generationRequest(requestId = "req-worker-1"): GenerationRequestWire {
  return {
    requestId,
    status: "pending",
    prompt: "What changed this week?",
    scope: {},
    packageId: "artifactory.extract-insights",
    dedupeKey: "sha256:request-dedupe",
    runId: requestId,
    workflowId: "artifactory.extract-insights",
    claimOwner: "worker-test",
    leaseExpiresAt: "2026-07-17T12:02:00.000Z",
    fencingToken: 1,
    attemptCount: 1,
    maxAttempts: 2,
    phase: "running",
    sourceCursorBefore: null,
    sourceCursorAfter: null,
    sourceRefs: [],
    publicationKey: null,
    artifactIds: [],
    publicationManifest: null,
    createdAt: "2026-07-17T12:00:00.000Z",
    expiresAt: "2026-07-18T12:00:00.000Z",
  };
}

function mockWorkerHost(options: {
  emptyClaims?: number;
  unauthorized?: boolean;
  staleHeartbeat?: boolean;
  staleSources?: boolean;
  emptySources?: boolean;
  sourceDelayMs?: number;
  completeDelayMs?: number;
  cancelOnPublish?: boolean;
  sourceItems?: ListenSourceItem[];
} = {}): MockWorkerHost {
  const calls: ApiCall[] = [];
  const artifacts: unknown[] = [];
  const logs: Array<{ event: string; resultCode?: unknown }> = [];
  const request = generationRequest();
  let emptyClaims = options.emptyClaims ?? 0;

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const action = url.pathname.split("/").at(-1) ?? "";
    calls.push({ action, path: url.pathname, authorization: headers.get("authorization"), body });
    if (options.unauthorized) {
      return Response.json({ error: { code: "unauthorized", message: "missing or invalid worker bearer token" } }, { status: 401 });
    }
    if (action === "claim") {
      if (emptyClaims > 0) {
        emptyClaims -= 1;
        return Response.json({ request: null, committedCursor: null });
      }
      return Response.json({ request, committedCursor: null });
    }
    if (action === "heartbeat") {
      if (options.staleHeartbeat) {
        return Response.json({ error: { code: "stale_generation_lease", message: "generation request lease is stale" } }, { status: 409 });
      }
      request.leaseExpiresAt = "2026-07-17T12:04:00.000Z";
      return Response.json({ request });
    }
    if (action === "sources") {
      if (options.sourceDelayMs) await Bun.sleep(options.sourceDelayMs);
      if (options.staleSources) {
        return Response.json({ error: { code: "stale_generation_lease", message: "generation request lease is stale" } }, { status: 409 });
      }
      const items = options.emptySources
        ? []
        : options.sourceItems ?? [{
            conversationId: "listen-conversation-1",
            title: "Weekly sync",
            startedAt: "2026-07-17T12:00:00.000Z",
            transcript: TRANSCRIPT,
            transcriptBytes: Buffer.byteLength(TRANSCRIPT, "utf8"),
            transcriptSha256: `sha256:${createHash("sha256").update(TRANSCRIPT).digest("hex")}`,
            truncated: false,
          }];
      const lastItem = items.at(-1);
      const batch = {
        items,
        nextCursor: lastItem
          ? { startedAt: lastItem.startedAt, conversationId: lastItem.conversationId }
          : null,
        count: items.length,
        bytes: 0,
      };
      for (let iteration = 0; iteration < 8; iteration += 1) {
        const measured = Buffer.byteLength(JSON.stringify(batch), "utf8");
        if (measured === batch.bytes) break;
        batch.bytes = measured;
      }
      return Response.json(batch);
    }
    if (action === "phase") {
      request.phase = String(body.phase);
      const metadata = body.metadata as { sourceCursorAfter?: unknown; sourceRefs?: unknown[] } | undefined;
      if (metadata && Object.hasOwn(metadata, "sourceCursorAfter")) request.sourceCursorAfter = metadata.sourceCursorAfter;
      if (metadata?.sourceRefs) request.sourceRefs = metadata.sourceRefs;
      return Response.json({ request });
    }
    if (action === "artifacts") {
      if (options.cancelOnPublish) {
        request.status = "cancelled";
        request.phase = "cancelled";
        request.leaseExpiresAt = null;
        return Response.json({
          outcome: "cancelled",
          request,
          artifactIds: [],
          publicationKey: null,
        });
      }
      const submitted = body.artifacts as Array<{ artifactId: string }> | undefined;
      if (submitted) artifacts.push(...submitted);
      request.artifactIds = submitted?.map((artifact) => artifact.artifactId) ?? request.artifactIds;
      if (submitted) request.publicationManifest = submitted;
      request.publicationKey = typeof body.publicationKey === "string" ? body.publicationKey : request.publicationKey;
      request.phase = "publishing";
      return Response.json({
        outcome: request.artifactIds.length > 0 ? "published" : "zero_artifacts",
        request,
        artifactIds: request.artifactIds,
        publicationKey: request.publicationKey,
      });
    }
    if (action === "reconcile") {
      request.phase = "reconciling";
      return Response.json({ request, feedItemIds: request.artifactIds.map((id) => `legacy:${id}`) });
    }
    if (action === "complete") {
      if (options.completeDelayMs) await Bun.sleep(options.completeDelayMs);
      request.status = "consumed";
      request.phase = String(body.outcome);
      request.leaseExpiresAt = null;
      return Response.json({ request });
    }
    if (action === "retry") {
      const retryable = body.retryable !== false;
      request.status = retryable && request.attemptCount < request.maxAttempts ? "retry_wait" : "dead_letter";
      request.phase = request.status;
      request.leaseExpiresAt = null;
      return Response.json({ request });
    }
    return Response.json({ error: { code: "not_found", message: url.pathname } }, { status: 404 });
  };

  return { calls, artifacts, logs, request, fetch: fetchImpl as typeof fetch };
}

let cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function makeTranscriptDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "feed-v1-worker-test-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "transcripts"), { recursive: true });
  await writeFile(join(dir, "transcripts", "weekly-sync.md"), TRANSCRIPT);
  return dir;
}

function workerConfig(baseDir: string): WorkerConfig {
  return {
    hostUrl: "https://feed.test.invalid",
    actorId: "did:pkh:eip155:1:0x0000000000000000000000000000000000000abc",
    token: "worker-control-token-with-at-least-32-random-like-bytes",
    insecureTls: false,
    sourceMode: "host",
    sourceBatchLimit: 5,
    transcriptDirs: [join(baseDir, "transcripts")],
    pollMs: 10,
    idlePollMsMax: 60_000,
    runsDir: join(baseDir, "runs"),
    model: "stub-model",
    generator: "stub",
    maxAttempts: 2,
    workflowId: "artifactory.extract-insights",
    claimOwner: "worker-test",
    leaseSeconds: 15,
    heartbeatMs: 5,
    ffmpegPath: Bun.which("ffmpeg") || "ffmpeg",
    packageVersion: "worker-test-v1",
    packageDigest: "sha256:worker-test-package",
    once: true,
  };
}

function clientFor(host: MockWorkerHost, config: WorkerConfig): FeedHostClient {
  return new FeedHostClient(config, host.fetch, (_level, event, fields) => {
    host.logs.push({ event, resultCode: fields?.resultCode });
  });
}

function heroFixture(): Artifact {
  return {
    id: "hero-fixture",
    type: "insight-card",
    headline: "Reconciliation is the hidden scaling cost",
    body: "The projection boundary deserves explicit attention.",
    tags: ["reconciliation", "feed"],
    source_transcripts: ["/tmp/transcript.md"],
    generated_at: "2026-07-17T12:00:00.000Z",
    quality: { critic_pass: false, quotes_verified: true },
  };
}

const EXACT_SOURCE_QUOTE = "The interesting part is that nobody else has noticed the projection reconciliation cost grows with every artifact we publish.";
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function webpBytes(size = 12): Uint8Array {
  const bytes = new Uint8Array(Math.max(12, size));
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  return bytes;
}

function floorBody(): string {
  return Array.from({ length: 160 }, (_, index) => `grounded${index + 1}`).join(" ");
}

function aboveFloorDraft(overrides: Partial<DraftCard> = {}): DraftCard {
  return {
    headline: "Reconciliation becomes the hidden scaling boundary",
    body: floorBody(),
    quote: EXACT_SOURCE_QUOTE,
    attribution: "Bob",
    tags: ["reconciliation", "operations"],
    source_quotes: [{ transcript: "listen:listen-conversation-1", quote: EXACT_SOURCE_QUOTE }],
    ...overrides,
  };
}

describe("feed-v1 worker hero policy", () => {
  test("stub generation meets the floor with a deterministic critic and compressed WebP hero", async () => {
    const dir = await makeTranscriptDir();
    const artifact = await generateInsightArtifact({
      requestId: "req-gen-1",
      prompt: "What changed this week?",
      transcriptDirs: [join(dir, "transcripts")],
      model: "stub-model",
      generator: "stub",
    });
    expect(artifact.quality.quotes_verified).toBe(true);
    expect(artifact.quality.critic_pass).toBe(true);
    expect(markdownWordCount(artifact.body!)).toBeGreaterThanOrEqual(150);
    expect(markdownWordCount(artifact.body!)).toBeLessThanOrEqual(300);
    expect(artifact.tags).toHaveLength(2);
    expect(artifact.hero_image).toBe(STUB_HERO_DATA_URI);
    expect(Buffer.from(artifact.hero_image!.split(",", 2)[1]!, "base64").subarray(0, 4).toString()).toBe("RIFF");
  });

  test("an unverifiable pull quote triggers one feedback regeneration and typed quality rejection", async () => {
    const calls: Array<{ attempt: number; feedback: string[] }> = [];
    const generation = generateInsightArtifact({
      requestId: "req-unverified-pull-quote",
      prompt: null,
      transcriptDirs: [],
      sources: [{
        sourceId: "listen-conversation-1",
        title: "Weekly sync",
        startedAt: "2026-07-17T12:00:00.000Z",
        transcript: TRANSCRIPT,
        transcriptSha256: `sha256:${createHash("sha256").update(TRANSCRIPT).digest("hex")}`,
        truncated: false,
      }],
      model: "test-model",
      generator: "stub",
      draftGenerator: async ({ attempt, feedback }) => {
        calls.push({ attempt, feedback });
        return aboveFloorDraft({
          quote: "This sentence does not occur in the source.",
          attribution: undefined,
          source_quotes: [],
        });
      },
    });
    await expect(generation).rejects.toBeInstanceOf(ArtifactQualityRejectedError);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ attempt: 1, feedback: [] });
    expect(calls[1]!.feedback.join(" ")).toContain("pull quote");
  });

  test("required hero failures are typed, while opt-out logs a warning and returns text-only", async () => {
    const failingSource = async () => {
      throw new Error("provider unavailable");
    };
    await expect(attachHeroImage(heroFixture(), { requireHero: true, generate: failingSource })).rejects.toMatchObject({
      name: "HeroGenerationError",
      code: "provider_error",
      reason: "provider_error",
    } satisfies Partial<HeroGenerationError>);

    const warnings: Array<{ event: string; level?: string }> = [];
    const degraded = await attachHeroImage(heroFixture(), {
      requireHero: false,
      generate: failingSource,
      log: (event, _fields, level) => warnings.push({ event, level }),
    });
    expect(degraded.hero_image).toBeUndefined();
    expect(warnings).toContainEqual({ event: "hero_image_degraded_text_only", level: "warn" });
  });

  test("an over-cap image is retried once with a smaller request", async () => {
    const prompts: string[] = [];
    const profiles: Array<{ width: number; quality: number }> = [];
    const artifact = heroFixture();
    await attachHeroImage(artifact, {
      requireHero: true,
      generate: async ({ prompt }) => {
        prompts.push(prompt);
        return { mimeType: "image/png", bytes: PNG_SIGNATURE };
      },
      process: async ({ width, quality }) => {
        profiles.push({ width, quality });
        return profiles.length === 1
          ? { mimeType: "image/webp", bytes: webpBytes(800_000) }
          : { mimeType: "image/webp", bytes: webpBytes() };
      },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("local downscaling");
    expect(profiles).toEqual([{ width: 768, quality: 82 }, { width: 512, quality: 68 }]);
    expect(artifact.hero_image).toStartWith("data:image/webp;base64,");
  });

  test("claude receives no transcript content in argv and disables persistence, tools, and MCP", () => {
    const args = claudeCommand("sonnet");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--mcp-config");
    expect(args).toContain("--tools");
    expect(args.join(" ")).not.toContain("transcript");
    expect(criticCommand()).toContain("sonnet");
  });

  test("an above-floor card obeys a separately spawned Sonnet critic mocked at the process boundary", async () => {
    const processCalls: Array<{ command: string[]; stdin: string; operation: string }> = [];
    const draftFeedback: string[][] = [];

    const artifact = await generateInsightArtifact({
      requestId: "real-critic-boundary",
      prompt: null,
      transcriptDirs: [],
      sources: [{
        sourceId: "listen-conversation-1",
        title: "Weekly sync",
        startedAt: "2026-07-17T12:00:00.000Z",
        transcript: TRANSCRIPT,
        transcriptSha256: `sha256:${createHash("sha256").update(TRANSCRIPT).digest("hex")}`,
        truncated: false,
      }],
      model: "generator-model",
      generator: "claude",
      draftGenerator: async ({ feedback }) => {
        draftFeedback.push(feedback);
        return aboveFloorDraft();
      },
      criticProcessRunner: async (command, stdin, operation) => {
        processCalls.push({ command, stdin, operation });
        return processCalls.length === 1
          ? '{"verdict":"reject","feedback":["make the editorial angle sharper"],"notes":"needs focus"}'
          : '{"verdict":"pass","feedback":[],"notes":"grounded and sharp"}';
      },
      heroImageGenerator: async () => ({ mimeType: "image/png", bytes: PNG_SIGNATURE }),
      heroImageProcessor: async () => ({ mimeType: "image/webp", bytes: webpBytes() }),
    });
    expect(artifact.quality).toMatchObject({ critic_pass: true, quotes_verified: true });
    expect(artifact.hero_image).toStartWith("data:image/webp;base64,");
    expect(processCalls).toHaveLength(2);
    expect(draftFeedback).toHaveLength(2);
    expect(draftFeedback[1]).toEqual(["make the editorial angle sharper"]);
    expect(processCalls[0]!.operation).toBe("critic");
    expect(processCalls[0]!.command.join(" ")).toContain("--model sonnet");
    expect(processCalls[0]!.command.join(" ")).not.toContain("projection reconciliation cost");
    expect(processCalls[0]!.stdin).toContain("projection reconciliation cost");
  });

  test("hero failures expose bounded distinct reasons and logged details", async () => {
    const invalidLogs: Array<Record<string, unknown>> = [];
    await expect(attachHeroImage(heroFixture(), {
      requireHero: true,
      generate: async () => ({ mimeType: "application/octet-stream", bytes: new Uint8Array([1]) }),
      log: (_event, fields) => invalidLogs.push(fields ?? {}),
    })).rejects.toMatchObject({ reason: "invalid_image", code: "invalid_image" });
    expect(invalidLogs.at(-1)).toMatchObject({ reason: "invalid_image", detail: expect.any(String) });

    const oversizeLogs: Array<Record<string, unknown>> = [];
    await expect(attachHeroImage(heroFixture(), {
      requireHero: true,
      generate: async () => ({ mimeType: "image/png", bytes: PNG_SIGNATURE }),
      process: async () => ({ mimeType: "image/webp", bytes: webpBytes(600_000) }),
      log: (_event, fields) => oversizeLogs.push(fields ?? {}),
    })).rejects.toMatchObject({ reason: "media_too_large", code: "media_too_large" });
    const failure = oversizeLogs.at(-1)!;
    expect(failure).toMatchObject({ reason: "media_too_large", detail: expect.any(String) });
    expect(String(failure.detail).length).toBeLessThanOrEqual(300);
  });
});

describe("Feed Host worker API client", () => {
  test("local transcript directories are used only when the source mode explicitly selects them", () => {
    const priorSource = process.env.FEED_WORKER_SOURCE;
    const priorDirs = process.env.TRANSCRIPT_DIRS;
    const priorPackageVersion = process.env.FEED_WORKER_PACKAGE_VERSION;
    const priorPackageDigest = process.env.FEED_WORKER_PACKAGE_DIGEST;
    cleanup.push(() => {
      if (priorSource === undefined) delete process.env.FEED_WORKER_SOURCE;
      else process.env.FEED_WORKER_SOURCE = priorSource;
      if (priorDirs === undefined) delete process.env.TRANSCRIPT_DIRS;
      else process.env.TRANSCRIPT_DIRS = priorDirs;
      if (priorPackageVersion === undefined) delete process.env.FEED_WORKER_PACKAGE_VERSION;
      else process.env.FEED_WORKER_PACKAGE_VERSION = priorPackageVersion;
      if (priorPackageDigest === undefined) delete process.env.FEED_WORKER_PACKAGE_DIGEST;
      else process.env.FEED_WORKER_PACKAGE_DIGEST = priorPackageDigest;
    });
    process.env.FEED_WORKER_PACKAGE_VERSION = "worker-env-test-v1";
    process.env.FEED_WORKER_PACKAGE_DIGEST = "sha256:worker-env-test-package";
    delete process.env.FEED_WORKER_SOURCE;
    process.env.TRANSCRIPT_DIRS = "/private/local-transcripts";
    expect(configFromEnv().sourceMode).toBe("host");
    process.env.FEED_WORKER_SOURCE = "local";
    expect(configFromEnv()).toMatchObject({
      sourceMode: "local",
      transcriptDirs: ["/private/local-transcripts"],
    });
  });

  test("startup refuses to fabricate package provenance", () => {
    const priorVersion = process.env.FEED_WORKER_PACKAGE_VERSION;
    const priorDigest = process.env.FEED_WORKER_PACKAGE_DIGEST;
    cleanup.push(() => {
      if (priorVersion === undefined) delete process.env.FEED_WORKER_PACKAGE_VERSION;
      else process.env.FEED_WORKER_PACKAGE_VERSION = priorVersion;
      if (priorDigest === undefined) delete process.env.FEED_WORKER_PACKAGE_DIGEST;
      else process.env.FEED_WORKER_PACKAGE_DIGEST = priorDigest;
    });
    delete process.env.FEED_WORKER_PACKAGE_VERSION;
    delete process.env.FEED_WORKER_PACKAGE_DIGEST;
    expect(() => configFromEnv()).toThrow("FEED_WORKER_PACKAGE_VERSION is required");
    process.env.FEED_WORKER_PACKAGE_VERSION = "reviewed-v1";
    expect(() => configFromEnv()).toThrow("FEED_WORKER_PACKAGE_DIGEST is required");
  });

  test("idle claim polling doubles from pollMs to the cap and never drops below pollMs", () => {
    const config = { pollMs: 4_000, idlePollMsMax: 60_000 };
    const delays: number[] = [];
    let idleMs = config.pollMs;
    for (let i = 0; i < 7; i++) {
      delays.push(idleMs);
      idleMs = nextIdlePollMs(idleMs, config);
    }
    expect(delays).toEqual([4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    // A cap configured below the active cadence must not speed idle polling up.
    expect(nextIdlePollMs(500, { pollMs: 4_000, idlePollMsMax: 1_000 })).toBe(4_000);
  });

  test("idle poll cap reads FEED_WORKER_IDLE_POLL_MS_MAX with a 60s default", () => {
    const priorCap = process.env.FEED_WORKER_IDLE_POLL_MS_MAX;
    const priorPackageVersion = process.env.FEED_WORKER_PACKAGE_VERSION;
    const priorPackageDigest = process.env.FEED_WORKER_PACKAGE_DIGEST;
    cleanup.push(() => {
      if (priorCap === undefined) delete process.env.FEED_WORKER_IDLE_POLL_MS_MAX;
      else process.env.FEED_WORKER_IDLE_POLL_MS_MAX = priorCap;
      if (priorPackageVersion === undefined) delete process.env.FEED_WORKER_PACKAGE_VERSION;
      else process.env.FEED_WORKER_PACKAGE_VERSION = priorPackageVersion;
      if (priorPackageDigest === undefined) delete process.env.FEED_WORKER_PACKAGE_DIGEST;
      else process.env.FEED_WORKER_PACKAGE_DIGEST = priorPackageDigest;
    });
    process.env.FEED_WORKER_PACKAGE_VERSION = "worker-env-test-v1";
    process.env.FEED_WORKER_PACKAGE_DIGEST = "sha256:worker-env-test-package";
    delete process.env.FEED_WORKER_IDLE_POLL_MS_MAX;
    expect(configFromEnv().idlePollMsMax).toBe(60_000);
    process.env.FEED_WORKER_IDLE_POLL_MS_MAX = "120000";
    expect(configFromEnv().idlePollMsMax).toBe(120_000);
    process.env.FEED_WORKER_IDLE_POLL_MS_MAX = "not-a-number";
    expect(configFromEnv().idlePollMsMax).toBe(60_000);
  });

  test("claim handles empty and claimed responses with bearer auth and the exact worker body", async () => {
    const dir = await makeTranscriptDir();
    const config = workerConfig(dir);
    const host = mockWorkerHost({ emptyClaims: 1 });
    const client = clientFor(host, config);
    expect((await client.claim()).request).toBeNull();
    expect((await client.claim()).request?.requestId).toBe("req-worker-1");
    expect(host.calls[0]).toMatchObject({
      path: "/api/worker/generation-requests/claim",
      authorization: `Bearer ${config.token}`,
      body: {
        actorId: config.actorId,
        workflowId: config.workflowId,
        claimOwner: config.claimOwner,
        leaseSeconds: config.leaseSeconds,
        maxAttempts: config.maxAttempts,
      },
    });
    expect(host.logs.map((entry) => entry.resultCode)).toEqual(["empty", "claimed"]);
  });

  test("source batches carry the exact claim fence, limit, and continuation cursor", async () => {
    const dir = await makeTranscriptDir();
    const config = workerConfig(dir);
    const host = mockWorkerHost();
    const client = clientFor(host, config);
    const request = (await client.claim()).request!;
    const cursor = { startedAt: "2026-07-17T13:00:00.000Z", conversationId: "newer" };
    const batch = await client.sources(request, cursor, 3);
    expect(batch.count).toBe(1);
    expect(host.calls.at(-1)).toMatchObject({
      path: `/api/worker/generation-requests/${request.requestId}/sources`,
      body: {
        actorId: config.actorId,
        runId: request.runId,
        claimOwner: request.claimOwner,
        fencingToken: request.fencingToken,
        cursor,
        limit: 3,
      },
    });
  });

  test("401 is a clear non-retryable worker error and makes only one API call", async () => {
    const dir = await makeTranscriptDir();
    const config = workerConfig(dir);
    const host = mockWorkerHost({ unauthorized: true });
    const client = clientFor(host, config);
    const result = await client.claim().catch((value: unknown) => value);
    if (!(result instanceof WorkerApiError)) throw new Error("expected claim to fail with WorkerApiError");
    const error = result;
    expect(error).toBeInstanceOf(WorkerApiError);
    expect(error).toMatchObject({ status: 401, code: "unauthorized", retryable: false });
    expect(error.message).toContain("missing or invalid worker bearer token");
    expect(error.message).not.toContain(config.token!);
    expect(host.calls).toHaveLength(1);
  });
});

describe("feed-v1 worker flow", () => {
  test("heartbeats, checkpoints a hero-bearing artifact, reconciles, and completes", async () => {
    const dir = await makeTranscriptDir();
    const config = workerConfig(dir);
    const host = mockWorkerHost();
    const client = clientFor(host, config);
    const claim = await client.claim();
    const ledger = new LedgerWriter(config.runsDir);
    const processed = await processRequest(claim.request!, claim.committedCursor, client, ledger, config, {
      generate: async (input) => {
        const artifact = await generateInsightArtifact(input);
        await Bun.sleep(20);
        return artifact;
      },
    });
    expect(processed).toBe(true);
    expect(host.calls.some((call) => call.action === "heartbeat")).toBe(true);
    expect(host.calls.filter((call) => call.action === "phase").map((call) => call.body.phase)).toEqual([
      "running",
      "validating",
    ]);
    expect(host.artifacts).toHaveLength(1);
    const published = validateFeedArtifact(host.artifacts[0]);
    expect(published.ok).toBe(true);
    if (published.ok) {
      expect(published.value.producedBy.runId).toBe(host.request.requestId);
      expect(published.value.producedBy).toMatchObject({
        packageId: "artifactory.extract-insights",
        packageVersion: "worker-test-v1",
        packageDigest: "sha256:worker-test-package",
        runtimeClass: "stub",
        providerClass: "none",
      });
      expect(published.value.sourceRefs[0]).toMatchObject({
        sourceId: "listen-conversation-1",
        observedPath: "host_source_api",
        observedHash: `sha256:${createHash("sha256").update(TRANSCRIPT).digest("hex")}`,
      });
      expect((published.value.body as Record<string, unknown>).quality).toEqual({
        critic_pass: true,
        quotes_verified: true,
        notes: expect.stringContaining("critic passed"),
      });
      expect((published.value.body as Record<string, unknown>).hero_image).toBe(STUB_HERO_DATA_URI);
    }
    expect(host.calls.some((call) => call.action === "sources")).toBe(true);
    const artifactCall = host.calls.find((call) => call.action === "artifacts")!;
    expect(artifactCall.body).toMatchObject({
      actorId: config.actorId,
      runId: host.request.requestId,
      claimOwner: config.claimOwner,
      fencingToken: 1,
    });
    expect(host.calls.slice(-2).map((call) => call.action)).toEqual(["reconcile", "complete"]);
    expect(host.calls.at(-1)?.body.cursor).toEqual({
      startedAt: "2026-07-17T12:00:00.000Z",
      conversationId: "listen-conversation-1",
    });
    expect(host.request).toMatchObject({ status: "consumed", phase: "published", leaseExpiresAt: null });

    const ledgerRaw = JSON.parse(await readFile(join(config.runsDir, host.request.requestId, "status.json"), "utf8")) as {
      state: string;
      artifactId?: string;
    };
    expect(ledgerRaw.state).toBe("done");
    expect(ledgerRaw.artifactId).toBeDefined();
    const runMetadata = [
      await readFile(join(config.runsDir, "events.jsonl"), "utf8"),
      await readFile(join(config.runsDir, host.request.requestId, "status.json"), "utf8"),
      await readFile(join(config.runsDir, host.request.requestId, "publication.checkpoint.json"), "utf8"),
    ].join("\n");
    expect(runMetadata).not.toContain("listen-conversation-1");
    expect(runMetadata).not.toContain("projection reconciliation cost");
  });

  test("generation failure reports retry/dead-letter state and releases the lease", async () => {
    const dir = await makeTranscriptDir();
    await rm(join(dir, "transcripts", "weekly-sync.md"));
    const config = workerConfig(dir);
    config.sourceMode = "local";
    const host = mockWorkerHost();
    const client = clientFor(host, config);
    const claim = await client.claim();
    await processRequest(claim.request!, claim.committedCursor, client, new LedgerWriter(config.runsDir), config);
    expect(host.calls.some((call) => call.action === "artifacts")).toBe(false);
    expect(host.calls.at(-1)?.action).toBe("retry");
    expect(host.calls.at(-1)?.body).toMatchObject({ errorCode: "generation_failed", retryable: true });
    expect(host.request).toMatchObject({ status: "retry_wait", phase: "retry_wait", leaseExpiresAt: null });
  });

  test("a final failed attempt reaches dead-letter instead of retrying forever", async () => {
    const dir = await makeTranscriptDir();
    const config = workerConfig(dir);
    const host = mockWorkerHost();
    host.request.attemptCount = host.request.maxAttempts;
    const client = clientFor(host, config);
    const claim = await client.claim();
    await processRequest(claim.request!, claim.committedCursor, client, new LedgerWriter(config.runsDir), config, {
      generate: async () => { throw new Error("provider failed"); },
    });
    expect(host.calls.filter((call) => call.action === "retry")).toHaveLength(1);
    expect(host.calls.find((call) => call.action === "retry")?.body.retryable).toBe(false);
    expect(host.request).toMatchObject({ status: "dead_letter", phase: "dead_letter", leaseExpiresAt: null });
  });

  test("two below-floor drafts complete as terminal zero_artifacts with regeneration feedback", async () => {
    const dir = await makeTranscriptDir();
    const config = workerConfig(dir);
    const host = mockWorkerHost();
    const client = clientFor(host, config);
    const claim = await client.claim();
    const draftCalls: Array<{ attempt: number; feedback: string[] }> = [];
    await processRequest(claim.request!, claim.committedCursor, client, new LedgerWriter(config.runsDir), config, {
      generate: (input) => generateInsightArtifact({
        ...input,
        draftGenerator: async ({ attempt, feedback }) => {
          draftCalls.push({ attempt, feedback });
          return aboveFloorDraft({ quote: undefined, attribution: undefined, source_quotes: [] });
        },
      }),
    });

    expect(draftCalls).toHaveLength(2);
    expect(draftCalls[0]!.feedback).toEqual([]);
    expect(draftCalls[1]!.feedback.join(" ")).toContain("source quote");
    expect(host.calls.some((call) => call.action === "retry")).toBe(false);
    expect(host.calls.find((call) => call.action === "artifacts")?.body.artifacts).toEqual([]);
    expect(host.calls.find((call) => call.action === "complete")?.body.outcome).toBe("zero_artifacts");
    expect(host.request).toMatchObject({ status: "consumed", phase: "zero_artifacts", artifactIds: [] });
    const events = await readFile(join(config.runsDir, "events.jsonl"), "utf8");
    expect(events).toContain('"event":"quality_zero_artifacts"');
  });

  test("a dead ffmpeg stdin is typed, bounded, and completes the attempt lifecycle without crashing", async () => {
    const dir = await makeTranscriptDir();
    const fakeFfmpeg = join(dir, "ffmpeg-exits-now");
    await writeFile(fakeFfmpeg, "#!/bin/sh\necho 'fake ffmpeg closed input' >&2\nexit 17\n");
    await chmod(fakeFfmpeg, 0o755);
    const config = workerConfig(dir);
    config.ffmpegPath = fakeFfmpeg;
    const host = mockWorkerHost();
    const client = clientFor(host, config);
    const claim = await client.claim();

    const processed = await processRequest(
      claim.request!,
      claim.committedCursor,
      client,
      new LedgerWriter(config.runsDir),
      config,
      {
        generate: async () => {
          await resizeHeroImage({
            image: { mimeType: "image/png", bytes: new Uint8Array(8 * 1024 * 1024) },
            width: 768,
            quality: 82,
            executable: fakeFfmpeg,
          });
          throw new Error("unreachable");
        },
      },
    );

    expect(processed).toBe(true);
    expect(host.calls.find((call) => call.action === "retry")?.body).toMatchObject({
      errorCode: "image_processing_failed",
      retryable: false,
    });
    expect(host.request).toMatchObject({ status: "dead_letter", phase: "dead_letter" });
    const events = await readFile(join(config.runsDir, "events.jsonl"), "utf8");
    expect(events).toContain('"errorCode":"image_processing_failed"');
    expect(events).toContain('"detail":"fake ffmpeg closed input"');
    expect(events).not.toContain("89504e47");
  });

  test("worker startup fails before polling when the named ffmpeg binary is missing", async () => {
    const dir = await makeTranscriptDir();
    const config = workerConfig(dir);
    config.ffmpegPath = join(dir, "missing-ffmpeg-binary");
    await expect(runWorker(config)).rejects.toThrow(`ffmpeg preflight failed for binary ${config.ffmpegPath}`);
  });

  test("cancellation at the publication boundary stops without reconciliation or completion", async () => {
    const dir = await makeTranscriptDir();
    const config = workerConfig(dir);
    const host = mockWorkerHost({ cancelOnPublish: true });
    const client = clientFor(host, config);
    const claim = await client.claim();
    await processRequest(claim.request!, claim.committedCursor, client, new LedgerWriter(config.runsDir), config);
    expect(host.calls.some((call) => call.action === "reconcile")).toBe(false);
    expect(host.calls.some((call) => call.action === "complete")).toBe(false);
    const state = JSON.parse(await readFile(join(config.runsDir, host.request.requestId, "status.json"), "utf8"));
    expect(state.state).toBe("cancelled");
  });

  test("a stale heartbeat fences the worker before artifact submission", async () => {
    const dir = await makeTranscriptDir();
    const config = workerConfig(dir);
    const host = mockWorkerHost({ staleHeartbeat: true });
    const client = clientFor(host, config);
    const claim = await client.claim();
    await processRequest(claim.request!, claim.committedCursor, client, new LedgerWriter(config.runsDir), config, {
      generate: async (input) => {
        const artifact = await generateInsightArtifact(input);
        await Bun.sleep(20);
        return artifact;
      },
    });
    expect(host.calls.some((call) => call.action === "heartbeat")).toBe(true);
    expect(host.calls.some((call) => call.action === "artifacts")).toBe(false);
    expect(host.calls.some((call) => call.action === "retry")).toBe(false);
    const ledgerRaw = JSON.parse(await readFile(join(config.runsDir, host.request.requestId, "status.json"), "utf8")) as {
      state: string;
    };
    expect(ledgerRaw.state).toBe("lease_lost");
  });

  test("heartbeats continue while a slow fenced source batch is being read", async () => {
    const dir = await makeTranscriptDir();
    const config = workerConfig(dir);
    const host = mockWorkerHost({ sourceDelayMs: 25 });
    const client = clientFor(host, config);
    const claim = await client.claim();
    await processRequest(claim.request!, claim.committedCursor, client, new LedgerWriter(config.runsDir), config);
    const sourceIndex = host.calls.findIndex((call) => call.action === "sources");
    const heartbeatIndex = host.calls.findIndex((call) => call.action === "heartbeat");
    expect(sourceIndex).toBeGreaterThan(-1);
    expect(heartbeatIndex).toBeGreaterThan(sourceIndex);
    expect(host.calls.some((call) => call.action === "artifacts")).toBe(true);
  });

  test("heartbeats continue through a slow terminal completion request", async () => {
    const dir = await makeTranscriptDir();
    const config = workerConfig(dir);
    const host = mockWorkerHost({ completeDelayMs: 25 });
    const client = clientFor(host, config);
    const claim = await client.claim();
    await processRequest(claim.request!, claim.committedCursor, client, new LedgerWriter(config.runsDir), config);
    const completeIndex = host.calls.findIndex((call) => call.action === "complete");
    expect(completeIndex).toBeGreaterThan(-1);
    expect(host.calls.findIndex((call, index) => index > completeIndex && call.action === "heartbeat")).toBeGreaterThan(completeIndex);
  });

  test("completion commits only through the last source actually used by the corpus", async () => {
    const dir = await makeTranscriptDir();
    const config = workerConfig(dir);
    const first = sourceItem("listen-conversation-1", "2026-07-17T12:00:00.000Z", TRANSCRIPT);
    const second = sourceItem(
      "listen-conversation-2",
      "2026-07-17T11:00:00.000Z",
      TRANSCRIPT.replaceAll("Alice", "Carol").replaceAll("Bob", "Dave"),
    );
    const host = mockWorkerHost({ sourceItems: [first, second] });
    const client = clientFor(host, config);
    const claim = await client.claim();
    await processRequest(claim.request!, claim.committedCursor, client, new LedgerWriter(config.runsDir), config, {
      generate: (input) => generateInsightArtifact({ ...input, maxCorpusChars: 100 }),
    });
    expect(host.calls.find((call) => call.action === "complete")?.body.cursor).toEqual({
      startedAt: first.startedAt,
      conversationId: first.conversationId,
    });
  });

  test("lease expiry during source fetch stops before generation or publication", async () => {
    const dir = await makeTranscriptDir();
    const config = workerConfig(dir);
    const host = mockWorkerHost({ staleSources: true });
    const client = clientFor(host, config);
    const claim = await client.claim();
    let generated = false;
    await processRequest(claim.request!, claim.committedCursor, client, new LedgerWriter(config.runsDir), config, {
      generate: async (input) => {
        generated = true;
        return generateInsightArtifact(input);
      },
    });
    expect(generated).toBe(false);
    expect(host.calls.some((call) => call.action === "artifacts")).toBe(false);
    expect(host.calls.some((call) => call.action === "retry")).toBe(false);
  });

  test("an empty production source batch completes with an immutable zero-artifact manifest", async () => {
    const dir = await makeTranscriptDir();
    const config = workerConfig(dir);
    config.transcriptDirs = [];
    const host = mockWorkerHost({ emptySources: true });
    const client = clientFor(host, config);
    const claim = await client.claim();
    await processRequest(claim.request!, claim.committedCursor, client, new LedgerWriter(config.runsDir), config);
    const artifacts = host.calls.find((call) => call.action === "artifacts")!;
    expect(artifacts.body.artifacts).toEqual([]);
    expect(host.request).toMatchObject({ status: "consumed", phase: "zero_artifacts", artifactIds: [] });
  });

  test("publishing-phase reclamation replays the Host manifest without regenerating or sending new bytes", async () => {
    const dir = await makeTranscriptDir();
    const config = workerConfig(dir);
    const firstHost = mockWorkerHost();
    const firstClient = clientFor(firstHost, config);
    const firstClaim = await firstClient.claim();
    await processRequest(firstClaim.request!, firstClaim.committedCursor, firstClient, new LedgerWriter(config.runsDir), config);
    const manifest = firstHost.artifacts as GenerationRequestWire["publicationManifest"];

    const resumedHost = mockWorkerHost();
    resumedHost.request.phase = "publishing";
    resumedHost.request.publicationKey = firstHost.request.publicationKey;
    resumedHost.request.publicationManifest = manifest;
    resumedHost.request.artifactIds = firstHost.request.artifactIds;
    const resumedClient = clientFor(resumedHost, config);
    let regenerated = false;
    await processRequest(resumedHost.request, null, resumedClient, new LedgerWriter(config.runsDir), config, {
      generate: async (input) => {
        regenerated = true;
        return generateInsightArtifact(input);
      },
    });
    expect(regenerated).toBe(false);
    const replay = resumedHost.calls.find((call) => call.action === "artifacts")!;
    expect(replay.body.artifacts).toBeUndefined();
  });

  test("local publication checkpoints allow same-hash replay and reject changed bytes", async () => {
    const dir = await makeTranscriptDir();
    const config = workerConfig(dir);
    const host = mockWorkerHost();
    const client = clientFor(host, config);
    const claim = await client.claim();
    const ledger = new LedgerWriter(config.runsDir);
    await processRequest(claim.request!, claim.committedCursor, client, ledger, config);
    const artifact = host.artifacts[0] as Parameters<LedgerWriter["checkpointPublication"]>[2][number];
    const key = host.request.publicationKey!;
    await ledger.checkpointPublication(host.request.requestId, key, [artifact]);
    await expect(ledger.checkpointPublication(host.request.requestId, key, [{ ...artifact, title: "changed bytes" }]))
      .rejects.toBeInstanceOf(PublicationConflictError);
  });

  test("parseDraft handles noisy JSON and scrubErrorNote removes credential material", () => {
    const draft = parseDraft('Here you go:\n{"headline": "H", "body": "B", "tags": ["x"], "source_quotes": []}\nthanks');
    expect(draft.headline).toBe("H");
    const privateOutput = "no json here: private transcript phrase";
    expect(() => parseDraft(privateOutput)).toThrow("generator output contained no JSON object");
    try {
      parseDraft(privateOutput);
    } catch (error) {
      expect(String(error)).not.toContain("private transcript phrase");
    }
    const note = scrubErrorNote(new Error("publish failed: token=abc123 secret:hunter2 at row 5"));
    expect(note).not.toContain("abc123");
    expect(note).not.toContain("hunter2");
  });
});
