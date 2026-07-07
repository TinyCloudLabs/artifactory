// Publish-writer seam. Persists FeedArtifacts + workflow-run summary rows into
// the Feed v1 storage split (xyz.tinycloud.artifacts + xyz.tinycloud.feed).
// The in-memory backing keeps runs testable; the TinyCloud-backed writer will
// use the seed-row helpers in feed-v1-bootstrap.ts.

import {
  artifactIndexRow,
  workflowRunRow,
  type SqlSeedRow,
} from "../../../skills/_shared/lib/feed-v1-bootstrap.ts";
import type {
  FeedArtifact,
  FeedWorkflowRun,
} from "../../../skills/_shared/lib/feed-v1.ts";

export type PublishWriter = {
  publish(artifact: FeedArtifact): Promise<void>;
  recordRun(run: FeedWorkflowRun): Promise<void>;
  listArtifacts(runId: string): Promise<FeedArtifact[]>;
  seedRows(runId: string): Promise<SqlSeedRow[]>;
};

export function createInMemoryPublishWriter(): PublishWriter {
  const artifactsByRun = new Map<string, FeedArtifact[]>();
  const runs = new Map<string, FeedWorkflowRun>();

  return {
    async publish(artifact) {
      const runId = artifact.producedBy.runId;
      const current = artifactsByRun.get(runId) ?? [];
      current.push({ ...artifact });
      artifactsByRun.set(runId, current);
    },
    async recordRun(run) {
      runs.set(run.runId, { ...run });
    },
    async listArtifacts(runId) {
      return (artifactsByRun.get(runId) ?? []).map((artifact) => ({ ...artifact }));
    },
    async seedRows(runId) {
      const rows: SqlSeedRow[] = [];
      const run = runs.get(runId);
      if (run) rows.push(workflowRunRow(run));
      for (const artifact of artifactsByRun.get(runId) ?? []) {
        rows.push(artifactIndexRow(artifact));
      }
      return rows;
    },
  };
}
