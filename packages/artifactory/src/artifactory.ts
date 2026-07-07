// Artifactory instance: bundles the seams the CLI needs into a single value.
// Callers can swap any store or the runtime; defaults are the in-memory stubs.

import { createInMemoryCostLedger, type CostLedger } from "./cost-ledger.ts";
import { createInMemoryPublishWriter, type PublishWriter } from "./publish-writer.ts";
import { createInMemoryRunLockStore, type RunLockStore } from "./run-lock.ts";
import { createInMemorySourceLedger, type SourceLedger } from "./source-ledger.ts";
import { createInMemoryDropAudit, type DropAudit } from "./validation.ts";
import {
  createStubArtifactSkillRuntime,
  type ArtifactSkillRuntime,
} from "./runtime-adapter.ts";
import { executeRun, type RunOptions, type RunResult } from "./run.ts";
import { readRunStatus, type RunStatus } from "./status.ts";
import type { ListenResolverFactory } from "./listen-resolver.ts";
import type { WorkflowFixture } from "./workflow.ts";

export type ArtifactoryOptions = {
  runtime?: ArtifactSkillRuntime;
  runLock?: RunLockStore;
  sourceLedger?: SourceLedger;
  costLedger?: CostLedger;
  publishWriter?: PublishWriter;
  dropAudit?: DropAudit;
  listenResolverFactory?: ListenResolverFactory;
};

export type ArtifactoryRunInput = {
  runId: string;
  ownerId: string;
  workflow: WorkflowFixture;
  now?: Date;
  leaseMs?: number;
};

export type ArtifactoryStatusInput = {
  runId: string;
  scope: string;
};

export type Artifactory = {
  runtime: ArtifactSkillRuntime;
  runLock: RunLockStore;
  sourceLedger: SourceLedger;
  costLedger: CostLedger;
  publishWriter: PublishWriter;
  dropAudit: DropAudit;
  run(input: ArtifactoryRunInput): Promise<RunResult>;
  status(input: ArtifactoryStatusInput): Promise<RunStatus>;
};

export function createArtifactory(options: ArtifactoryOptions = {}): Artifactory {
  const runtime = options.runtime ?? createStubArtifactSkillRuntime();
  const runLock = options.runLock ?? createInMemoryRunLockStore();
  const sourceLedger = options.sourceLedger ?? createInMemorySourceLedger();
  const costLedger = options.costLedger ?? createInMemoryCostLedger();
  const publishWriter = options.publishWriter ?? createInMemoryPublishWriter();
  const dropAudit = options.dropAudit ?? createInMemoryDropAudit();
  const listenResolverFactory = options.listenResolverFactory;

  return {
    runtime,
    runLock,
    sourceLedger,
    costLedger,
    publishWriter,
    dropAudit,
    async run(input) {
      const runOptions: RunOptions = {
        runId: input.runId,
        ownerId: input.ownerId,
        workflow: input.workflow,
        now: input.now ?? new Date(),
        leaseMs: input.leaseMs ?? 5 * 60 * 1000,
        runtime,
        runLock,
        sourceLedger,
        costLedger,
        publishWriter,
        dropAudit,
        listenResolverFactory,
      };
      return executeRun(runOptions);
    },
    async status(input) {
      return readRunStatus({
        runId: input.runId,
        scope: input.scope,
        publishWriter,
        sourceLedger,
        costLedger,
        dropAudit,
        runLock,
      });
    },
  };
}
