// Port-binding integration coverage for the vendored Feed Host. The slice-loop
// sandbox does not populate/bind the submodule, so this suite is conditional;
// the architect runs it after `submodules/feed` is updated to current main.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateInsightArtifact } from "./generate.ts";
import {
  FeedHostClient,
  LedgerWriter,
  processRequest,
  WorkerApiError,
  type GenerationRequestWire,
  type WorkerConfig,
} from "./worker.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_SERVER = resolve(HERE, "../../submodules/feed/host/server.ts");
const HOST_STORAGE = resolve(HERE, "../../submodules/feed/host/storage.ts");
const HAS_REAL_HOST = existsSync(HOST_SERVER);
const ACTOR_ID = "did:pkh:eip155:1:0x0000000000000000000000000000000000000abc";
const WORKER_TOKEN = "real-host-worker-token-with-at-least-32-random-bytes";
const TRANSCRIPT = "Alice: The bounded source endpoint keeps transcript authority inside Feed while the worker receives only a fenced batch.";

describe.skipIf(!HAS_REAL_HOST)("feed-v1 worker against vendored real Feed Host", () => {
  test("claim/source/heartbeat/publication/resume/zero/401 and terminal transitions use real routes", async () => {
    const hostModule = await import(pathToFileURL(HOST_SERVER).href);
    const storageModule = await import(pathToFileURL(HOST_STORAGE).href);
    const storage = new IntegrationStorage();
    storage.staleError = () => new storageModule.FeedHostError(
      "generation request lease is stale",
      409,
      "stale_generation_lease",
    );
    const sourceAccess = integrationSourceAccess(20);
    const runtime = hostModule.startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      workerToken: WORKER_TOKEN,
      storage,
      activateDelegation: async ({ serializedDelegation }: { serializedDelegation: string }) => ({
        actorId: ACTOR_ID,
        acceptedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        resources: serializedDelegation.split("|"),
        portableDelegation: {},
        access: sourceAccess,
      }),
    });
    const runDir = await mkdtemp(join(tmpdir(), "feed-worker-real-host-"));
    try {
      await grantRealHost(runtime.url);
      const config = integrationConfig(runtime.url, runDir);
      const client = new FeedHostClient(config);
      expect((await client.claim()).request?.requestId).toBe("real-host-request-1");

      // Put the request back into claimable state so processRequest exercises
      // the complete worker flow. The Host itself owns every HTTP transition.
      storage.releaseForTest();
      const claim = await client.claim();
      await processRequest(claim.request!, claim.committedCursor, client, new LedgerWriter(runDir), config, {
        generate: async (input) => {
          const artifact = await generateInsightArtifact(input);
          await Bun.sleep(25);
          return artifact;
        },
      });
      expect(storage.request).toMatchObject({ status: "consumed", phase: "published" });
      expect(storage.heartbeatCount).toBeGreaterThan(0);
      expect(storage.sourceFenceChecks).toBeGreaterThanOrEqual(2);

      // The immutable Host manifest is replayed without a new artifact body.
      storage.reclaimPublishing();
      let regenerated = false;
      await processRequest(storage.request, storage.request.sourceCursorBefore, client, new LedgerWriter(runDir), config, {
        generate: async (input) => {
          regenerated = true;
          return generateInsightArtifact(input);
        },
      });
      expect(regenerated).toBe(false);
      expect(storage.manifestWrites).toBe(1);

      storage.resetAccepted("real-host-request-zero");
      sourceAccess.empty = true;
      const zeroClaim = await client.claim();
      await processRequest(zeroClaim.request!, zeroClaim.committedCursor, client, new LedgerWriter(runDir), config);
      expect(storage.request).toMatchObject({ status: "consumed", phase: "zero_artifacts", artifactIds: [] });
      expect((await client.claim()).request).toBeNull();

      storage.resetAccepted("real-host-request-expired");
      sourceAccess.empty = false;
      const expiredClaim = await client.claim();
      const writesBeforeExpiry = storage.manifestWrites;
      await processRequest(expiredClaim.request!, expiredClaim.committedCursor, client, new LedgerWriter(runDir), config, {
        generate: async (input) => {
          const artifact = await generateInsightArtifact(input);
          storage.expireLease();
          return artifact;
        },
      });
      expect(storage.manifestWrites).toBe(writesBeforeExpiry);
      expect(JSON.parse(await Bun.file(join(runDir, "real-host-request-expired", "status.json")).text())).toMatchObject({
        state: "lease_lost",
      });

      storage.resetAccepted("real-host-request-cancelled");
      storage.cancelOnPublish = true;
      const cancelledClaim = await client.claim();
      await processRequest(cancelledClaim.request!, cancelledClaim.committedCursor, client, new LedgerWriter(runDir), config);
      expect(storage.request).toMatchObject({ status: "cancelled", phase: "cancelled" });
      storage.cancelOnPublish = false;

      storage.resetAccepted("real-host-request-dead-letter");
      storage.request.maxAttempts = 1;
      const failedClaim = await client.claim();
      await processRequest(failedClaim.request!, failedClaim.committedCursor, client, new LedgerWriter(runDir), config, {
        generate: async () => { throw new Error("provider unavailable"); },
      });
      expect(storage.request).toMatchObject({ status: "dead_letter", phase: "dead_letter" });

      const unauthorized = new FeedHostClient({ ...config, token: "wrong-worker-token-with-at-least-32-bytes" });
      storage.resetAccepted("real-host-request-unauthorized");
      const error = await unauthorized.claim().catch((value) => value as WorkerApiError);
      expect(error).toMatchObject({ status: 401, retryable: false });
      expect(storage.claimCallsAfterReset).toBe(0);
    } finally {
      runtime.stop();
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

function integrationConfig(hostUrl: string, runsDir: string): WorkerConfig {
  return {
    hostUrl,
    actorId: ACTOR_ID,
    token: WORKER_TOKEN,
    insecureTls: false,
    sourceMode: "host",
    sourceBatchLimit: 1,
    transcriptDirs: [],
    pollMs: 10,
    runsDir,
    model: "stub-model",
    generator: "stub",
    maxAttempts: 2,
    workflowId: "artifactory.extract-insights",
    claimOwner: "real-host-worker",
    leaseSeconds: 15,
    heartbeatMs: 5,
    requireHero: true,
    packageVersion: "worker-integration-v1",
    packageDigest: "sha256:worker-integration-package",
    once: true,
  };
}

async function grantRealHost(url: string): Promise<void> {
  const policy = await fetch(`${url}/delegation-policy`).then((response) => response.json()) as {
    resources: Array<{ path: string }>;
  };
  const response = await fetch(`${url}/api/delegations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorId: ACTOR_ID,
      serializedDelegation: policy.resources.map((resource) => resource.path).join("|"),
    }),
  });
  expect(response.ok).toBe(true);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await fetch(`${url}/api/delegations/status`, {
      headers: { "x-feed-actor-id": ACTOR_ID, cookie },
    }).then((item) => item.json()) as { setup?: { state?: string } };
    if (status.setup?.state === "ready") return;
    await Bun.sleep(10);
  }
  throw new Error("real Feed Host did not become ready");
}

function integrationSourceAccess(delayMs: number) {
  const access = {
    empty: false,
    sql: {
      db: (_path: string) => ({
        query: async (sql: string) => {
          if (delayMs > 0) await Bun.sleep(delayMs);
          if (sql.includes("AS transcript_json")) {
            return { ok: true, data: { rows: [{ transcript_json: null, transcript_text: access.empty ? "" : TRANSCRIPT }] } };
          }
          return access.empty
            ? { ok: true, data: { rows: [] } }
            : { ok: true, data: { rows: [{ id: "listen-real-1", title: "Real source", started_at: "2026-07-21T12:00:00.000Z" }] } };
        },
      }),
    },
    kv: {
      get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND", message: "not found" } }),
    },
  };
  return access;
}

class IntegrationStorage {
  request = requestFixture("real-host-request-1");
  heartbeatCount = 0;
  sourceFenceChecks = 0;
  manifestWrites = 0;
  claimCallsAfterReset = 0;
  cancelOnPublish = false;
  forcedExpired = false;
  staleError: (() => Error) | undefined;

  async bootstrapSchema() { return {}; }
  async ensureWorkflowPackages() {}

  async claimGenerationRequest(_actor: unknown, input: Record<string, unknown>) {
    this.claimCallsAfterReset += 1;
    if (this.request.status !== "accepted" && this.request.status !== "retry_wait") return null;
    this.request.status = "pending";
    this.request.runId = this.request.requestId;
    this.request.workflowId = String(input.workflowId);
    this.request.claimOwner = String(input.claimOwner);
    this.request.leaseExpiresAt = String(input.leaseExpiresAt);
    this.request.fencingToken += 1;
    this.request.attemptCount += 1;
    this.request.phase = "running";
    return this.request;
  }

  async assertGenerationRequestFence(_actor: unknown, input: Record<string, unknown>) {
    this.sourceFenceChecks += 1;
    this.assertFence(input);
    return this.request;
  }

  async heartbeatGenerationRequest(_actor: unknown, input: Record<string, unknown>) {
    this.assertFence(input);
    this.heartbeatCount += 1;
    this.request.leaseExpiresAt = String(input.leaseExpiresAt);
    return this.request;
  }

  async updateGenerationRequestPhase(_actor: unknown, input: Record<string, unknown>) {
    this.assertFence(input);
    this.request.phase = String(input.phase);
    const metadata = input.metadata as { sourceCursorAfter?: unknown; sourceRefs?: unknown[] };
    if (Object.hasOwn(metadata, "sourceCursorAfter")) this.request.sourceCursorAfter = metadata.sourceCursorAfter;
    if (metadata.sourceRefs) this.request.sourceRefs = metadata.sourceRefs;
    return this.request;
  }

  async publishGenerationArtifacts(_actor: unknown, input: Record<string, unknown>) {
    this.assertFence(input);
    if (this.cancelOnPublish) {
      this.request.status = "cancelled";
      this.request.phase = "cancelled";
      this.request.leaseExpiresAt = null;
      return {
        outcome: "cancelled",
        request: this.request,
        artifactIds: [],
        publicationKey: null,
      };
    }
    const incoming = input.artifacts as unknown[] | undefined;
    if (incoming && this.request.publicationManifest) {
      if (stable(incoming) !== stable(this.request.publicationManifest)) throw new Error("publication conflict");
    } else if (incoming) {
      this.request.publicationManifest = incoming;
      this.manifestWrites += 1;
    }
    this.request.artifactIds = (this.request.publicationManifest ?? []).map((artifact) =>
      String((artifact as { artifactId: string }).artifactId));
    this.request.publicationKey = String(input.publicationKey ?? this.request.publicationKey);
    this.request.phase = "publishing";
    return {
      outcome: this.request.artifactIds.length > 0 ? "published" : "zero_artifacts",
      request: this.request,
      artifactIds: this.request.artifactIds,
      publicationKey: this.request.publicationKey,
    };
  }

  async reconcileGenerationRequest(_actor: unknown, input: Record<string, unknown>) {
    this.assertFence(input);
    this.request.phase = "reconciling";
    return { request: this.request, feedItemIds: this.request.artifactIds.map((id) => `legacy:${id}`) };
  }

  async completeGenerationRequest(_actor: unknown, input: Record<string, unknown>) {
    this.assertFence(input);
    this.request.status = "consumed";
    this.request.phase = String(input.outcome);
    this.request.leaseExpiresAt = null;
    return this.request;
  }

  async retryGenerationRequest(_actor: unknown, input: Record<string, unknown>) {
    this.assertFence(input);
    this.request.status = input.retryable === false || this.request.attemptCount >= this.request.maxAttempts
      ? "dead_letter"
      : "retry_wait";
    this.request.phase = this.request.status;
    this.request.leaseExpiresAt = null;
    return this.request;
  }

  releaseForTest() {
    this.request.status = "accepted";
    this.request.phase = "queued";
    this.request.leaseExpiresAt = null;
  }

  reclaimPublishing() {
    this.request.status = "pending";
    this.request.phase = "publishing";
    this.request.leaseExpiresAt = new Date(Date.now() + 15_000).toISOString();
    this.request.fencingToken += 1;
  }

  resetAccepted(requestId: string) {
    this.request = requestFixture(requestId);
    this.claimCallsAfterReset = 0;
    this.forcedExpired = false;
  }

  expireLease() {
    this.forcedExpired = true;
    this.request.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
  }

  private assertFence(input: Record<string, unknown>) {
    if (
      this.request.status !== "pending" ||
      input.requestId !== this.request.requestId ||
      input.runId !== this.request.runId ||
      input.claimOwner !== this.request.claimOwner ||
      input.fencingToken !== this.request.fencingToken ||
      this.forcedExpired ||
      !this.request.leaseExpiresAt ||
      this.request.leaseExpiresAt <= String(input.now)
    ) throw this.staleError?.() ?? new Error("stale_generation_lease");
  }
}

function requestFixture(requestId: string): GenerationRequestWire {
  return {
    requestId,
    status: "accepted",
    prompt: "What architectural boundary mattered?",
    scope: {},
    packageId: "artifactory.extract-insights",
    dedupeKey: `sha256:${createHash("sha256").update(requestId).digest("hex")}`,
    runId: null,
    workflowId: null,
    claimOwner: null,
    leaseExpiresAt: null,
    fencingToken: 0,
    attemptCount: 0,
    maxAttempts: 2,
    phase: "queued",
    sourceCursorBefore: null,
    sourceCursorAfter: null,
    sourceRefs: [],
    publicationKey: null,
    artifactIds: [],
    publicationManifest: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
    .join(",")}}`;
}
