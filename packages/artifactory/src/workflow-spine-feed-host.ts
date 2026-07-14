import type { FeedArtifact } from "../../../skills/_shared/lib/feed-v1.ts";
import {
  StaleWorkflowFenceError,
  type DurableWorkflowRun,
  type WorkflowRunFence,
  type WorkflowRunPhase,
  type WorkflowRunTiming,
  type WorkflowSpinePorts,
  type WorkflowSpineWorkerStore,
} from "./workflow-spine.ts";

type FeedHostRequest = {
  requestId: string;
  actorId: string;
  status: string;
  packageId: string | null;
  scope?: unknown;
  prompt?: string | null;
  runId: string | null;
  workflowId: string | null;
  claimOwner: string | null;
  leaseExpiresAt: string | null;
  fencingToken: number;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  cancellationRequested: boolean;
  phase: string;
  sourceCursorBefore: unknown | null;
  sourceCursorAfter: unknown | null;
  sourceRefs: unknown[];
  publicationKey: string | null;
  artifactIds: string[];
  error: { code: string; message?: string } | null;
  timingEvents: Array<{ name: string; at: string; durationMs?: number }>;
  createdAt: string;
  updatedAt: string;
};

type FeedHostWorkerOptions = {
  baseUrl: string;
  token: string;
  actorId: string;
  workflowId: string;
  packageId: string;
  maxAttempts: number;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

export type FeedHostWorkflowBridge = {
  store: WorkflowSpineWorkerStore;
  publisher: WorkflowSpinePorts["publisher"];
  feed: WorkflowSpinePorts["feed"];
};

/**
 * Connects the generic Artifactory engine to Feed Host without giving the
 * worker a user's parent delegation. Feed Host remains the sole durable run
 * authority and validates the actor, request, run, owner, fence, and lease on
 * every mutation.
 */
export function createFeedHostWorkflowBridge(options: FeedHostWorkerOptions): FeedHostWorkflowBridge {
  if (Buffer.byteLength(options.token, "utf8") < 32) {
    throw new Error("Feed Host worker token must be at least 32 UTF-8 bytes");
  }
  const request = createWorkerRequest(options);
  let committedCursor: string | undefined;
  let latestRun: DurableWorkflowRun | undefined;
  const remember = (wire: FeedHostRequest): DurableWorkflowRun => {
    latestRun = fromFeedHostRequest(wire, options);
    return latestRun;
  };

  const mutate = async (
    action: string,
    fence: WorkflowRunFence,
    body: Record<string, unknown> = {},
  ): Promise<FeedHostRequest> => {
    const response = await request(
      `/api/worker/generation-requests/${encodeURIComponent(fence.runId)}/${action}`,
      { runId: fence.runId, claimOwner: fence.ownerId, fencingToken: fence.fencingToken, ...body },
    );
    return requireRequest(response);
  };

  const store: WorkflowSpineWorkerStore = {
    async claimNext(ownerId, leaseMs) {
      const response = await request("/api/worker/generation-requests/claim", {
        claimOwner: ownerId,
        leaseSeconds: Math.max(15, Math.ceil(leaseMs / 1000)),
        workflowId: options.workflowId,
        maxAttempts: options.maxAttempts,
      });
      if (response.request === null) return null;
      const wire = requireRequest(response);
      committedCursor = cursorString(response.committedCursor ?? wire.sourceCursorBefore);
      const run = remember(wire);
      return {
        run,
        fence: { runId: run.runId, ownerId, fencingToken: run.fencingToken },
      };
    },

    async assertCurrent(fence) {
      return remember(await mutate("assert", fence));
    },

    async renew(fence, leaseMs) {
      return remember(await mutate("heartbeat", fence, {
        leaseSeconds: Math.max(15, Math.ceil(leaseMs / 1000)),
      }));
    },

    async checkpoint(fence, patch, event) {
      if (patch.phase !== "running" && patch.phase !== "validating") {
        throw new Error(`Feed Host phase checkpoint is not worker-mutable: ${String(patch.phase)}`);
      }
      const metadata = {
        ...(patch.sourceCursorAfter === undefined ? {} : { sourceCursorAfter: patch.sourceCursorAfter }),
        ...(patch.sourceRefs === undefined ? {} : { sourceRefs: patch.sourceRefs }),
        timingEvents: [
          ...(latestRun?.timings ?? []).map(toFeedTiming),
          { name: event.event, at: event.at, ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }) },
        ],
      };
      return remember(await mutate("phase", fence, { phase: patch.phase, metadata }));
    },

    async fail(fence, failure) {
      return remember(await mutate("retry", fence, {
        errorCode: failure.code,
        errorMessage: failure.message,
        retryable: failure.retryable,
        retryAfterSeconds: failure.retryAt
          ? Math.max(1, Math.ceil((failure.retryAt.getTime() - Date.parse(latestRun?.updatedAt ?? new Date().toISOString())) / 1000))
          : 1,
        timingEvents: [
          ...(latestRun?.timings ?? []).map(toFeedTiming),
          { name: "workflow_failed", at: new Date().toISOString() },
        ],
      }));
    },

    async complete(fence, input) {
      return remember(await mutate("complete", fence, {
        outcome: input.phase,
        cursor: input.cursor,
        artifactIds: input.publishedArtifactIds,
        timingEvents: [
          ...(latestRun?.timings ?? []).map(toFeedTiming),
          { name: "cursor_committed", at: new Date().toISOString() },
        ],
      }));
    },

    async committedCursor(actorId, workflowId) {
      if (actorId !== options.actorId || workflowId !== options.workflowId) {
        throw new Error("Feed Host cursor requested outside the configured actor/workflow scope");
      }
      return committedCursor;
    },
  };

  return {
    store,
    publisher: {
      async publish({ run, fence, publicationKey, artifacts }) {
        const at = new Date().toISOString();
        const result = await publishOrResume(request, options, fence, {
          publicationKey,
          artifacts,
          timingEvents: [
            ...run.timings.map(toFeedTiming),
            { name: "publish_started", at },
            { name: "artifacts_published", at },
          ],
        });
        latestRun = result.run;
        return result;
      },
      async resume({ run, fence }) {
        const result = await publishOrResume(request, options, fence, {
          timingEvents: run.timings.map(toFeedTiming),
        });
        latestRun = result.run;
        return result;
      },
    },
    feed: {
      async reconcile({ fence, artifactIds }) {
        return remember(await mutate("reconcile", fence, { artifactIds }));
      },
    },
  };
}

async function publishOrResume(
  request: (path: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>,
  options: FeedHostWorkerOptions,
  fence: WorkflowRunFence,
  body: {
    publicationKey?: string;
    artifacts?: FeedArtifact[];
    timingEvents?: Array<{ name: string; at: string; durationMs?: number }>;
  },
) {
  const response = await request(
    `/api/worker/generation-requests/${encodeURIComponent(fence.runId)}/artifacts`,
    {
      runId: fence.runId,
      claimOwner: fence.ownerId,
      fencingToken: fence.fencingToken,
      ...body,
    },
  );
  const run = fromFeedHostRequest(requireRequest(response), options);
  if (response.outcome === "cancelled" || run.phase === "cancelled") {
    return { outcome: "cancelled" as const, run, artifactIds: [] as [] };
  }
  return { outcome: "published" as const, run, artifactIds: stringArray(response.artifactIds) };
}

function createWorkerRequest(options: FeedHostWorkerOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  return async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ actorId: options.actorId, ...body }),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = object(payload.error);
      const code = optionalString(error?.code);
      if (response.status === 409 || code === "generation_lease_conflict" || code === "stale_workflow_fence") {
        throw new StaleWorkflowFenceError();
      }
      throw new Error(`Feed Host worker request failed (${response.status}${code ? ` ${code}` : ""})`);
    }
    return payload;
  };
}

function requireRequest(payload: Record<string, unknown>): FeedHostRequest {
  const value = object(payload.request);
  if (!value) throw new Error("Feed Host worker response did not include a request");
  return value as FeedHostRequest;
}

function fromFeedHostRequest(value: FeedHostRequest, options: FeedHostWorkerOptions): DurableWorkflowRun {
  if (!value.runId || !value.claimOwner || !value.workflowId) {
    throw new Error("Feed Host returned an unclaimed workflow request");
  }
  if (value.actorId !== options.actorId || value.workflowId !== options.workflowId) {
    throw new Error("Feed Host returned a workflow request outside the configured scope");
  }
  if (value.packageId && value.packageId !== options.packageId) {
    throw new Error("Feed Host returned a workflow request for a different package");
  }
  return {
    requestId: value.requestId,
    runId: value.runId,
    actorId: value.actorId,
    workflowId: value.workflowId,
    packageId: value.packageId ?? options.packageId,
    requestContext: feedRequestContext(value.scope, value.prompt),
    phase: workflowPhase(value.phase),
    attempt: value.attemptCount,
    maxAttempts: value.maxAttempts,
    ownerId: value.claimOwner,
    fencingToken: value.fencingToken,
    leaseExpiresAt: value.leaseExpiresAt ?? undefined,
    nextAttemptAt: value.nextRetryAt ?? undefined,
    cancelRequestedAt: value.cancellationRequested ? value.updatedAt : undefined,
    sourceCursorBefore: cursorString(value.sourceCursorBefore),
    sourceCursorAfter: cursorString(value.sourceCursorAfter),
    sourceRefIds: sourceRefIds(value.sourceRefs),
    sourceRefs: Array.isArray(value.sourceRefs)
      ? value.sourceRefs as DurableWorkflowRun["sourceRefs"]
      : [],
    publicationKey: value.publicationKey ?? undefined,
    publishedArtifactIds: stringArray(value.artifactIds),
    lastError: value.error
      ? { code: value.error.code, message: value.error.message ?? value.error.code }
      : undefined,
    timings: Array.isArray(value.timingEvents)
      ? value.timingEvents.map((event) => ({ event: event.name, at: event.at, durationMs: event.durationMs }))
      : [],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function feedRequestContext(
  scopeValue: unknown,
  promptValue: unknown,
): DurableWorkflowRun["requestContext"] {
  const source = object(scopeValue);
  if (!source) return undefined;
  const scope = {
    ...(optionalString(source.artifactType) ? { artifactType: optionalString(source.artifactType) } : {}),
    ...(optionalString(source.packageId) ? { packageId: optionalString(source.packageId) } : {}),
    ...(optionalString(source.sourceRefId) ? { sourceRefId: optionalString(source.sourceRefId) } : {}),
  };
  return {
    scope,
    ...(optionalString(promptValue) ? { prompt: optionalString(promptValue) } : {}),
  };
}

function workflowPhase(value: string): WorkflowRunPhase {
  const phases: WorkflowRunPhase[] = [
    "queued", "running", "validating", "publishing", "reconciling",
    "retry_wait", "published", "zero_artifacts", "cancelled", "dead_letter",
  ];
  if (!phases.includes(value as WorkflowRunPhase)) throw new Error(`Feed Host returned unsupported workflow phase: ${value}`);
  return value as WorkflowRunPhase;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function sourceRefIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const ref = object(entry);
    return typeof ref?.sourceRefId === "string" ? [ref.sourceRefId] : [];
  });
}

function cursorString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function toFeedTiming(value: WorkflowRunTiming): { name: string; at: string; durationMs?: number } {
  return { name: value.event, at: value.at, ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }) };
}
