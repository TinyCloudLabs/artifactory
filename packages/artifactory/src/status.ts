// Status readout for a run: what artifacts published, what dropped, what the
// lock table looks like, and what the cost ledger recorded.

import type { CostLedger, CostTotals } from "./cost-ledger.ts";
import type { PublishWriter } from "./publish-writer.ts";
import type { RunLockStore } from "./run-lock.ts";
import type { SourceLedger } from "./source-ledger.ts";
import type { DropAudit } from "./validation.ts";
import type { FeedArtifact, TranscriptSourceRef } from "../../../skills/_shared/lib/feed-v1.ts";
import type { DroppedCandidate } from "./validation.ts";

export type RunStatus = {
  runId: string;
  publishedArtifacts: FeedArtifact[];
  dropped: DroppedCandidate[];
  sourceRefs: TranscriptSourceRef[];
  costTotals: CostTotals[];
  lock: null | {
    scope: string;
    ownerId: string;
    runId: string;
    leaseExpiresAt: string;
    fencingToken: string;
  };
};

export async function readRunStatus(input: {
  runId: string;
  scope: string;
  publishWriter: PublishWriter;
  sourceLedger: SourceLedger;
  costLedger: CostLedger;
  dropAudit: DropAudit;
  runLock: RunLockStore;
}): Promise<RunStatus> {
  const [publishedArtifacts, sourceRefs, costTotals, lock] = await Promise.all([
    input.publishWriter.listArtifacts(input.runId),
    input.sourceLedger.list(input.runId),
    input.costLedger.totals({ runId: input.runId }),
    input.runLock.peek(input.scope),
  ]);
  return {
    runId: input.runId,
    publishedArtifacts,
    dropped: input.dropAudit.list(input.runId),
    sourceRefs,
    costTotals,
    lock: lock
      ? {
          scope: lock.scope,
          ownerId: lock.ownerId,
          runId: lock.runId,
          leaseExpiresAt: lock.leaseExpiresAt,
          fencingToken: lock.fencingToken,
        }
      : null,
  };
}
