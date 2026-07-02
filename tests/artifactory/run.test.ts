import { describe, expect, test } from "bun:test";
import { createArtifactory } from "../../packages/artifactory/src/artifactory.ts";
import { loadWorkflowFile } from "../../packages/artifactory/src/workflow.ts";
import type {
  ArtifactSkillRuntime,
  ArtifactSkillRuntimeInput,
  ArtifactSkillRuntimeOutput,
} from "../../packages/artifactory/src/runtime-adapter.ts";
import { RUN_ARTIFACT_SKILL } from "../../packages/artifactory/src/runtime-adapter.ts";
import type { CandidateArtifactEnvelope } from "../../skills/_shared/lib/feed-v1.ts";

const FIXTURE = new URL("./fixtures/noop.workflow.json", import.meta.url).pathname;

describe("artifactory run", () => {
  test("no-op workflow publishes zero artifacts and releases the lock", async () => {
    const artifactory = createArtifactory();
    const workflow = await loadWorkflowFile(FIXTURE);
    const now = new Date("2026-07-02T00:00:00.000Z");
    const result = await artifactory.run({
      runId: "run-noop",
      ownerId: "test-owner",
      workflow,
      now,
      leaseMs: 60_000,
    });

    expect(result.status).toBe("zero_artifacts");
    expect(result.workflowRun.status).toBe("zero_artifacts");
    expect(result.publishedArtifacts).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(await artifactory.runLock.peek(workflow.packageId)).toBeNull();
  });

  test("candidates that pass validation become FeedArtifacts, dropped ones are audited", async () => {
    const candidate: CandidateArtifactEnvelope = {
      schemaVersion: "feed.candidate_artifact.v1",
      localCandidateId: "c-1",
      artifactType: "noop",
      renderShape: "short_form",
      title: "hello",
      body: { text: "hello" },
      sourceRefs: [
        {
          sourceRefId: "src-noop",
          sourceKind: "listen_conversation",
          sourceId: "listen-noop",
          observedPath: "sql_transcript_text",
          observedHash: "sha256:src",
          observedAt: "2026-07-02T00:00:00.000Z",
        },
      ],
      quality: { criticPass: true, quotesVerified: true },
      idempotency: {
        sourceFingerprint: "sha256:src",
        artifactFingerprint: "sha256:c-1",
        dedupeKey: "noop:sha256:src",
      },
      storage: { docKey: "artifacts/c-1.json" },
    };
    const runtime: ArtifactSkillRuntime = {
      tool: RUN_ARTIFACT_SKILL,
      async run(_input: ArtifactSkillRuntimeInput): Promise<ArtifactSkillRuntimeOutput> {
        return {
          candidates: [{ not: "valid" } as unknown as CandidateArtifactEnvelope, candidate],
          trace: {
            procedureVersion: "test.v1",
            modelCalls: 0,
            toolCalls: [],
            stageTrace: [],
            droppedCandidates: [{ reason: "runtime_probe", title: "probe" }],
          },
        };
      },
    };

    const artifactory = createArtifactory({ runtime });
    const workflow = await loadWorkflowFile(FIXTURE);
    const now = new Date("2026-07-02T00:00:00.000Z");
    const result = await artifactory.run({
      runId: "run-happy",
      ownerId: "test-owner",
      workflow,
      now,
      leaseMs: 60_000,
    });

    expect(result.status).toBe("published");
    expect(result.publishedArtifacts.length).toBe(1);
    expect(result.publishedArtifacts[0]!.artifactId).toBe("run-happy:c-1");
    expect(result.publishedArtifacts[0]!.producedBy.packageId).toBe(workflow.packageId);
    const dropReasons = result.dropped.map((entry) => entry.reason);
    expect(dropReasons).toContain("runtime_probe");
    expect(dropReasons.some((reason) => reason.startsWith("validation:"))).toBe(true);

    const status = await artifactory.status({ runId: "run-happy", scope: workflow.packageId });
    expect(status.publishedArtifacts.length).toBe(1);
    expect(status.sourceRefs.length).toBe(1);
    expect(status.dropped.length).toBeGreaterThanOrEqual(1);
    expect(status.lock).toBeNull();
  });

  test("blocks when the lock is already held", async () => {
    const artifactory = createArtifactory();
    const workflow = await loadWorkflowFile(FIXTURE);
    await artifactory.runLock.acquire({
      scope: workflow.packageId,
      ownerId: "someone-else",
      runId: "run-existing",
      leaseMs: 60_000,
      now: new Date("2026-07-02T00:00:00.000Z"),
    });
    const result = await artifactory.run({
      runId: "run-blocked",
      ownerId: "test-owner",
      workflow,
      now: new Date("2026-07-02T00:00:10.000Z"),
      leaseMs: 60_000,
    });
    expect(result.status).toBe("blocked_authority");
    expect(result.workflowRun.error?.code).toBe("run_lock_conflict");
  });
});
