import { createHash } from "node:crypto";
import type { FeedArtifact, SkillRunInput } from "../../../skills/_shared/lib/feed-v1.ts";

export type WorkflowRunPhase =
  | "queued"
  | "running"
  | "validating"
  | "publishing"
  | "reconciling"
  | "retry_wait"
  | "published"
  | "zero_artifacts"
  | "cancelled"
  | "dead_letter";

export type WorkflowRunFence = {
  runId: string;
  ownerId: string;
  fencingToken: number;
};

export type WorkflowRunTiming = {
  event: string;
  at: string;
  durationMs?: number;
};

export type DurableWorkflowRun = {
  requestId: string;
  runId: string;
  actorId: string;
  workflowId: string;
  packageId: string;
  phase: WorkflowRunPhase;
  attempt: number;
  maxAttempts: number;
  ownerId?: string;
  fencingToken: number;
  leaseExpiresAt?: string;
  nextAttemptAt?: string;
  cancelRequestedAt?: string;
  sourceCursorBefore?: string;
  sourceCursorAfter?: string;
  sourceRefIds: string[];
  sourceRefs: SkillRunInput["sourcePack"]["refs"];
  publicationKey?: string;
  publishedArtifactIds: string[];
  lastError?: { code: string; message: string };
  timings: WorkflowRunTiming[];
  createdAt: string;
  updatedAt: string;
};

export type WorkflowRunEnqueue = Pick<
  DurableWorkflowRun,
  "requestId" | "runId" | "actorId" | "workflowId" | "packageId" | "maxAttempts"
>;

export type WorkflowRunClaim = {
  run: DurableWorkflowRun;
  fence: WorkflowRunFence;
};

export class StaleWorkflowFenceError extends Error {
  constructor() {
    super("workflow run fence is no longer current");
    this.name = "StaleWorkflowFenceError";
  }
}

export type WorkflowSpineWorkerStore = {
  claimNext(ownerId: string, leaseMs: number, now: Date): Promise<WorkflowRunClaim | null>;
  assertCurrent(fence: WorkflowRunFence, now: Date): Promise<DurableWorkflowRun>;
  renew(fence: WorkflowRunFence, leaseMs: number, now: Date): Promise<DurableWorkflowRun>;
  checkpoint(
    fence: WorkflowRunFence,
    patch: Partial<Pick<DurableWorkflowRun,
      "phase" | "sourceCursorBefore" | "sourceCursorAfter" | "sourceRefIds" |
      "sourceRefs" | "publicationKey" | "publishedArtifactIds" | "lastError">>,
    event: WorkflowRunTiming,
  ): Promise<DurableWorkflowRun>;
  fail(
    fence: WorkflowRunFence,
    failure: { code: string; message: string; retryable: boolean; retryAt?: Date },
    now: Date,
  ): Promise<DurableWorkflowRun>;
  complete(
    fence: WorkflowRunFence,
    input: { phase: "published" | "zero_artifacts"; cursor: string; publishedArtifactIds: string[] },
    now: Date,
  ): Promise<DurableWorkflowRun>;
  committedCursor(actorId: string, workflowId: string): Promise<string | undefined>;
};

// Feed Host owns queue intake and user cancellation. Production workers only
// receive this fenced execution surface; the larger store remains useful for
// deterministic local tests.
export type WorkflowSpineStore = WorkflowSpineWorkerStore & {
  enqueue(input: WorkflowRunEnqueue, now: Date): Promise<DurableWorkflowRun>;
  requestCancel(runId: string, now: Date): Promise<{ accepted: boolean; run: DurableWorkflowRun }>;
  get(runId: string): Promise<DurableWorkflowRun | null>;
};

export type WorkflowSourceSelection = {
  sourcePack: SkillRunInput["sourcePack"];
  cursorBefore: string;
  cursorAfter: string;
};

export type WorkflowSpinePorts = {
  sources: {
    select(input: {
      run: DurableWorkflowRun;
      cursor: string | undefined;
    }): Promise<WorkflowSourceSelection>;
  };
  continuity?: {
    load(input: {
      run: DurableWorkflowRun;
      sourcePack: SkillRunInput["sourcePack"];
    }): Promise<SkillRunInput["priorContext"]>;
  };
  workflow: {
    execute(input: {
      run: DurableWorkflowRun;
      sourcePack: SkillRunInput["sourcePack"];
      publicationKey: string;
      priorContext?: SkillRunInput["priorContext"];
    }): Promise<{ artifacts: FeedArtifact[] }>;
  };
  publisher: {
    // The durable implementation atomically stores the immutable validated
    // publication manifest while crossing the cancellation boundary. It may
    // then expose deterministic document/index writes idempotently.
    publish(input: {
      run: DurableWorkflowRun;
      fence: WorkflowRunFence;
      publicationKey: string;
      artifacts: FeedArtifact[];
    }): Promise<WorkflowPublicationResult>;
    // A reclaimed publishing run resumes the stored manifest rather than
    // rerunning a potentially non-deterministic model call.
    resume(input: {
      run: DurableWorkflowRun;
      fence: WorkflowRunFence;
    }): Promise<WorkflowPublicationResult>;
  };
  feed: {
    // Implementations validate the fence before and after idempotent
    // reconciliation and return the durable run in reconciling phase.
    reconcile(input: {
      run: DurableWorkflowRun;
      fence: WorkflowRunFence;
      artifactIds: string[];
    }): Promise<DurableWorkflowRun>;
  };
};

export type WorkflowPublicationResult =
  | { outcome: "published"; run: DurableWorkflowRun; artifactIds: string[] }
  | { outcome: "cancelled"; run: DurableWorkflowRun; artifactIds: [] };

export type WorkflowSpineResult = {
  run: DurableWorkflowRun;
  processed: boolean;
};

export async function processNextWorkflowRun(input: {
  store: WorkflowSpineWorkerStore;
  ports: WorkflowSpinePorts;
  ownerId: string;
  leaseMs: number;
  now?: () => Date;
  retryDelayMs?: (attempt: number) => number;
}): Promise<WorkflowSpineResult | null> {
  const now = input.now ?? (() => new Date());
  const claimed = await input.store.claimNext(input.ownerId, input.leaseMs, now());
  if (!claimed) return null;
  const { fence } = claimed;
  let run = claimed.run;

  try {
    if (run.phase === "publishing" || run.phase === "reconciling") {
      const resumed = run.phase === "publishing"
        ? await input.ports.publisher.resume({ run, fence })
        : { outcome: "published" as const, run, artifactIds: run.publishedArtifactIds };
      run = resumed.run;
      if (resumed.outcome === "cancelled") return { run, processed: true };
      return await finishPublishedWorkflow({
        store: input.store,
        feed: input.ports.feed,
        fence,
        run,
        artifactIds: resumed.artifactIds,
        now,
      });
    }
    if (run.cancelRequestedAt) {
      run = await input.store.checkpoint(
        fence,
        { phase: "cancelled" },
        { event: "cancelled_before_source_read", at: now().toISOString() },
      );
      return { run, processed: true };
    }
    const cursor = await input.store.committedCursor(run.actorId, run.workflowId);
    const sourceStarted = now();
    const selection = await input.ports.sources.select({ run, cursor });
    const selectedAt = now();
    const publicationKey = workflowPublicationKey(run, selection);
    run = await input.store.checkpoint(
      fence,
      {
        phase: "running",
        sourceCursorBefore: selection.cursorBefore,
        sourceCursorAfter: selection.cursorAfter,
        sourceRefIds: selection.sourcePack.refs.map((ref) => ref.sourceRefId),
        sourceRefs: selection.sourcePack.refs,
        publicationKey,
      },
      timing("sources_selected", selectedAt, sourceStarted),
    );

    run = await input.store.renew(fence, input.leaseMs, now());
    const priorContext = await input.ports.continuity?.load({ run, sourcePack: selection.sourcePack });
    const workflowStarted = now();
    const output = await withLeaseHeartbeat(
      input.store,
      fence,
      input.leaseMs,
      now,
      () => input.ports.workflow.execute({
        run,
        sourcePack: selection.sourcePack,
        publicationKey,
        priorContext,
      }),
    );
    const validatedAt = now();
    run = await input.store.checkpoint(
      fence,
      { phase: "validating" },
      timing("workflow_validated", validatedAt, workflowStarted),
    );

    // Cancellation is honored only before publication starts. Once this
    // checkpoint succeeds, recovery must roll forward through reconciliation
    // and cursor commit so a published source pack is never selected again.
    if (run.cancelRequestedAt) {
      run = await input.store.checkpoint(
        fence,
        { phase: "cancelled" },
        { event: "cancelled_before_publish", at: now().toISOString() },
      );
      return { run, processed: true };
    }

    // From this call onward the worker never schedules a fresh generation
    // attempt. Host either lets cancellation win or durably records the exact
    // validated manifest and all recovery rolls forward from it.
    run = { ...run, phase: "publishing" };
    const publication = await input.ports.publisher.publish({
      run,
      fence,
      publicationKey,
      artifacts: output.artifacts,
    });
    run = publication.run;
    if (publication.outcome === "cancelled") return { run, processed: true };
    return await finishPublishedWorkflow({
      store: input.store,
      feed: input.ports.feed,
      fence,
      run,
      artifactIds: publication.artifactIds,
      now,
    });
  } catch (error) {
    if (error instanceof StaleWorkflowFenceError) throw error;
    if (run.phase === "publishing" || run.phase === "reconciling") throw error;
    const retryable = isRetryableWorkflowError(error);
    const delay = (input.retryDelayMs ?? defaultRetryDelay)(run.attempt);
    run = await input.store.fail(
      fence,
      {
        code: workflowErrorCode(error),
        message: scrubWorkflowError(error),
        retryable,
        retryAt: retryable ? new Date(now().getTime() + delay) : undefined,
      },
      now(),
    );
    return { run, processed: true };
  }
}

async function finishPublishedWorkflow(input: {
  store: WorkflowSpineWorkerStore;
  feed: WorkflowSpinePorts["feed"];
  fence: WorkflowRunFence;
  run: DurableWorkflowRun;
  artifactIds: string[];
  now: () => Date;
}): Promise<WorkflowSpineResult> {
  let run = input.run;
  if (!run.sourceCursorAfter) throw new Error("publishing workflow is missing its durable source cursor");
  const cursor = run.sourceCursorAfter;
  run = await input.feed.reconcile({ run, fence: input.fence, artifactIds: input.artifactIds });
  run = await input.store.complete(
    input.fence,
    {
      phase: input.artifactIds.length > 0 ? "published" : "zero_artifacts",
      cursor,
      publishedArtifactIds: input.artifactIds,
    },
    input.now(),
  );
  return { run, processed: true };
}

export function workflowPublicationKey(
  run: Pick<DurableWorkflowRun, "requestId" | "workflowId">,
  selection: Pick<WorkflowSourceSelection, "cursorBefore" | "cursorAfter" | "sourcePack">,
): string {
  const material = JSON.stringify({
    requestId: run.requestId,
    workflowId: run.workflowId,
    cursorBefore: selection.cursorBefore,
    cursorAfter: selection.cursorAfter,
    sources: selection.sourcePack.refs.map((ref) => ({
      sourceRefId: ref.sourceRefId,
      observedHash: ref.observedHash,
    })),
  });
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

export function createInMemoryWorkflowSpineStore(seed?: {
  runs?: Map<string, DurableWorkflowRun>;
  cursors?: Map<string, string>;
}): WorkflowSpineStore {
  const runs = seed?.runs ?? new Map<string, DurableWorkflowRun>();
  const cursors = seed?.cursors ?? new Map<string, string>();
  const clone = (run: DurableWorkflowRun): DurableWorkflowRun => structuredClone(run);
  const cursorKey = (actorId: string, workflowId: string): string => `${actorId}\n${workflowId}`;

  const current = (fence: WorkflowRunFence, now: Date): DurableWorkflowRun => {
    const run = runs.get(fence.runId);
    if (
      !run || run.ownerId !== fence.ownerId || run.fencingToken !== fence.fencingToken ||
      !run.leaseExpiresAt || run.leaseExpiresAt <= now.toISOString() || isTerminal(run.phase)
    ) {
      throw new StaleWorkflowFenceError();
    }
    return run;
  };

  return {
    async enqueue(value, now) {
      const existing = runs.get(value.runId);
      if (existing) return clone(existing);
      const at = now.toISOString();
      const run: DurableWorkflowRun = {
        ...value,
        phase: "queued",
        attempt: 0,
        fencingToken: 0,
        sourceRefIds: [],
        sourceRefs: [],
        publishedArtifactIds: [],
        timings: [{ event: "queued", at }],
        createdAt: at,
        updatedAt: at,
      };
      runs.set(run.runId, run);
      return clone(run);
    },
    async claimNext(ownerId, leaseMs, now) {
      const nowIso = now.toISOString();
      const candidates = [...runs.values()]
        .filter((run) =>
          run.phase === "queued" ||
          (run.phase === "retry_wait" && (!run.nextAttemptAt || run.nextAttemptAt <= nowIso)) ||
          (["running", "validating", "publishing", "reconciling"].includes(run.phase) &&
            Boolean(run.leaseExpiresAt && run.leaseExpiresAt <= nowIso)))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const run = candidates[0];
      if (!run) return null;
      if (run.phase !== "publishing" && run.phase !== "reconciling") run.phase = "running";
      run.attempt += 1;
      run.ownerId = ownerId;
      run.fencingToken += 1;
      run.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      run.nextAttemptAt = undefined;
      run.updatedAt = nowIso;
      run.timings.push({ event: "claimed", at: nowIso });
      const fence = { runId: run.runId, ownerId, fencingToken: run.fencingToken };
      return { run: clone(run), fence };
    },
    async assertCurrent(fence, now) {
      return clone(current(fence, now));
    },
    async renew(fence, leaseMs, now) {
      const run = current(fence, now);
      run.leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      run.updatedAt = now.toISOString();
      return clone(run);
    },
    async checkpoint(fence, patch, event) {
      const run = current(fence, new Date(event.at));
      Object.assign(run, structuredClone(patch));
      run.timings.push({ ...event });
      run.updatedAt = event.at;
      return clone(run);
    },
    async requestCancel(runId, now) {
      const run = runs.get(runId);
      if (!run) throw new Error(`workflow run not found: ${runId}`);
      if (["publishing", "reconciling", "published", "zero_artifacts"].includes(run.phase)) {
        return { accepted: false, run: clone(run) };
      }
      if (!isTerminal(run.phase)) {
        run.cancelRequestedAt = now.toISOString();
        run.updatedAt = now.toISOString();
        run.timings.push({ event: "cancel_requested", at: now.toISOString() });
      }
      return { accepted: !isTerminal(run.phase), run: clone(run) };
    },
    async fail(fence, failure, now) {
      const run = current(fence, now);
      run.lastError = { code: failure.code, message: failure.message };
      run.ownerId = undefined;
      run.leaseExpiresAt = undefined;
      if (failure.retryable && run.attempt < run.maxAttempts && failure.retryAt) {
        run.phase = "retry_wait";
        run.nextAttemptAt = failure.retryAt.toISOString();
        run.timings.push({ event: "retry_scheduled", at: now.toISOString() });
      } else {
        run.phase = "dead_letter";
        run.nextAttemptAt = undefined;
        run.timings.push({ event: "dead_lettered", at: now.toISOString() });
      }
      run.updatedAt = now.toISOString();
      return clone(run);
    },
    async complete(fence, value, now) {
      const run = current(fence, now);
      run.phase = value.phase;
      run.publishedArtifactIds = [...value.publishedArtifactIds];
      run.ownerId = undefined;
      run.leaseExpiresAt = undefined;
      run.nextAttemptAt = undefined;
      run.updatedAt = now.toISOString();
      run.timings.push({ event: "cursor_committed", at: now.toISOString() });
      cursors.set(cursorKey(run.actorId, run.workflowId), value.cursor);
      return clone(run);
    },
    async get(runId) {
      const run = runs.get(runId);
      return run ? clone(run) : null;
    },
    async committedCursor(actorId, workflowId) {
      return cursors.get(cursorKey(actorId, workflowId));
    },
  };
}

function timing(event: string, finished: Date, started: Date): WorkflowRunTiming {
  return { event, at: finished.toISOString(), durationMs: Math.max(0, finished.getTime() - started.getTime()) };
}

function defaultRetryDelay(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

async function withLeaseHeartbeat<T>(
  store: WorkflowSpineWorkerStore,
  fence: WorkflowRunFence,
  leaseMs: number,
  now: () => Date,
  operation: () => Promise<T>,
): Promise<T> {
  const intervalMs = Math.max(10, Math.min(5000, Math.floor(leaseMs / 3)));
  let renewing = false;
  let renewalError: unknown;
  let renewalInFlight: Promise<void> | undefined;
  const interval = setInterval(() => {
    if (renewing || renewalError) return;
    renewing = true;
    renewalInFlight = store.renew(fence, leaseMs, now())
      .then(() => undefined)
      .catch((error) => { renewalError = error; })
      .finally(() => { renewing = false; });
  }, intervalMs);
  try {
    const result = await operation();
    if (renewalInFlight) await renewalInFlight;
    if (renewalError) throw renewalError;
    return result;
  } finally {
    clearInterval(interval);
  }
}

function isTerminal(phase: WorkflowRunPhase): boolean {
  return ["published", "zero_artifacts", "cancelled", "dead_letter"].includes(phase);
}

function isRetryableWorkflowError(error: unknown): boolean {
  return !(error instanceof Error && error.name === "WorkflowPermanentError");
}

function workflowErrorCode(error: unknown): string {
  return error instanceof Error && error.name === "WorkflowPermanentError" ? "permanent_failure" : "transient_failure";
}

function scrubWorkflowError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(bearer|token|secret|password|private[_-]?key)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-capability]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
