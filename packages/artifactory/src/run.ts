// Deterministic pipeline for a single workflow run.
// This is the "artifactory smithers.sh" — the CLI holds this logic; the agent
// (eliza-service) invokes it via RUN_ARTIFACT_SKILL. Everything downstream of
// the runtime call is deterministic (validation → dedupe → publish).

import { candidateToArtifact } from "../../../skills/_shared/lib/feed-v1-bootstrap.ts";
import type {
  FeedArtifact,
  FeedWorkflowRun,
  SkillRunInput,
} from "../../../skills/_shared/lib/feed-v1.ts";
import type { CostLedger } from "./cost-ledger.ts";
import type { PublishWriter } from "./publish-writer.ts";
import type { RunLockStore } from "./run-lock.ts";
import type { ArtifactSkillRuntime } from "./runtime-adapter.ts";
import type { SourceLedger } from "./source-ledger.ts";
import { validateCandidates, type DropAudit, type DroppedCandidate } from "./validation.ts";
import type { WorkflowFixture } from "./workflow.ts";

export type RunOptions = {
  runId: string;
  ownerId: string;
  workflow: WorkflowFixture;
  now: Date;
  leaseMs: number;
  runtime: ArtifactSkillRuntime;
  runLock: RunLockStore;
  sourceLedger: SourceLedger;
  costLedger: CostLedger;
  publishWriter: PublishWriter;
  dropAudit: DropAudit;
};

export type RunResult = {
  status: FeedWorkflowRun["status"];
  workflowRun: FeedWorkflowRun;
  publishedArtifacts: FeedArtifact[];
  dropped: DroppedCandidate[];
};

export async function executeRun(options: RunOptions): Promise<RunResult> {
  const { runId, ownerId, workflow, now, leaseMs, runtime } = options;
  const nowIso = now.toISOString();

  const acquired = await options.runLock.acquire({
    scope: workflow.packageId,
    ownerId,
    runId,
    leaseMs,
    now,
  });
  if (!acquired.ok) {
    const workflowRun: FeedWorkflowRun = {
      schemaVersion: "feed.workflow_run.v1",
      runId,
      packageId: workflow.packageId,
      packageDigest: workflow.digest,
      status: "blocked_authority",
      sourceRefs: workflow.sourcePack.refs,
      publishedArtifactIds: [],
      droppedCandidates: [
        { reason: `run_lock_held_by:${acquired.heldBy.ownerId}` },
      ],
      spend: { budgetId: workflow.runtimePolicy.budgetId },
      error: {
        code: "run_lock_conflict",
        message: `scope ${workflow.packageId} held by ${acquired.heldBy.ownerId}`,
      },
      startedAt: nowIso,
      finishedAt: nowIso,
    };
    await options.publishWriter.recordRun(workflowRun);
    return { status: "blocked_authority", workflowRun, publishedArtifacts: [], dropped: [] };
  }

  try {
    for (const ref of workflow.sourcePack.refs) {
      await options.sourceLedger.observe({ runId, ref });
    }

    const skillInput: SkillRunInput = {
      runId,
      skillManifest: workflow.skillManifest,
      sourcePack: workflow.sourcePack,
      settings: workflow.settings,
      runtimePolicy: workflow.runtimePolicy,
    };

    const runtimeOutput = await runtime.run(skillInput);
    const outcome = validateCandidates(runtimeOutput.candidates, {
      runId,
      audit: options.dropAudit,
      maxAccepted: workflow.maxAcceptedArtifacts,
    });

    const producedBy = {
      packageId: workflow.packageId,
      packageVersion: workflow.version,
      packageDigest: workflow.digest,
      runId,
      runtimeClass: workflow.runtimePolicy.runtimeClass,
      providerClass: workflow.runtimePolicy.providerClass,
      credentialOwner: workflow.runtimePolicy.credentialMode,
      egressClass: workflow.runtimePolicy.egressClass,
      disclosure: workflow.skillManifest.disclosure,
    };

    const published: FeedArtifact[] = [];
    for (const candidate of outcome.accepted) {
      const artifact = candidateToArtifact(candidate, producedBy, nowIso);
      await options.publishWriter.publish(artifact);
      published.push(artifact);
    }

    const droppedFromRuntime = runtimeOutput.trace.droppedCandidates;
    for (const drop of droppedFromRuntime) {
      options.dropAudit.record(runId, drop);
    }
    const allDropped = [...droppedFromRuntime, ...outcome.dropped];

    const status: FeedWorkflowRun["status"] =
      published.length > 0 ? "published" : "zero_artifacts";

    const workflowRun: FeedWorkflowRun = {
      schemaVersion: "feed.workflow_run.v1",
      runId,
      packageId: workflow.packageId,
      packageDigest: workflow.digest,
      status,
      sourceRefs: workflow.sourcePack.refs,
      publishedArtifactIds: published.map((artifact) => artifact.artifactId),
      droppedCandidates: allDropped,
      spend: { budgetId: workflow.runtimePolicy.budgetId, amount: 0, currency: "USD" },
      startedAt: nowIso,
      finishedAt: new Date(now.getTime() + 1).toISOString(),
    };
    await options.publishWriter.recordRun(workflowRun);

    await options.costLedger.record({
      ledgerId: `${runId}:none`,
      userId: ownerId,
      budgetId: workflow.runtimePolicy.budgetId ?? "m0",
      windowStart: nowIso,
      spendClass: "none",
      amount: 0,
      currency: "USD",
      runId,
      recordedAt: nowIso,
    });

    return { status, workflowRun, publishedArtifacts: published, dropped: allDropped };
  } finally {
    await options.runLock.release(acquired.row.lockId, ownerId);
  }
}
