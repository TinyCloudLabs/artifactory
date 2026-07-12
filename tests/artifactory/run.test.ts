import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createArtifactory } from "../../packages/artifactory/src/artifactory.ts";
import { loadWorkflowFile, parseWorkflow } from "../../packages/artifactory/src/workflow.ts";
import type {
  ArtifactSkillRuntime,
  ArtifactSkillRuntimeInput,
  ArtifactSkillRuntimeOutput,
} from "../../packages/artifactory/src/runtime-adapter.ts";
import { RUN_ARTIFACT_SKILL } from "../../packages/artifactory/src/runtime-adapter.ts";
import { PackageAdmissionError } from "../../packages/artifactory/src/package-policy.ts";
import { artifactPackObservedHash } from "../../packages/artifactory/src/artifact-pack.ts";
import type { WorkflowFixture } from "../../packages/artifactory/src/workflow.ts";
import type { CandidateArtifactEnvelope } from "../../skills/_shared/lib/feed-v1.ts";

const FIXTURE = new URL("./fixtures/noop.workflow.json", import.meta.url).pathname;
const PACKAGE_FIXTURE = new URL("./fixtures/default-reviewed-bundle.workflow.json", import.meta.url).pathname;

async function readWorkflowFixture(path: string) {
  return parseWorkflow(JSON.parse(await readFile(path, "utf8")));
}

async function expectArtifactPackRejected(
  workflow: WorkflowFixture,
  runId: string,
  message: RegExp,
): Promise<void> {
  let runtimeCalled = false;
  const artifactory = createArtifactory({
    runtime: {
      tool: RUN_ARTIFACT_SKILL,
      async run() {
        runtimeCalled = true;
        throw new Error("runtime must not receive an untrusted artifactPack");
      },
    },
  });
  let error: unknown;
  try {
    await artifactory.run({
      runId,
      ownerId: "test-owner",
      workflow,
      now: new Date("2026-07-02T00:00:00.000Z"),
      leaseMs: 60_000,
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PackageAdmissionError);
  if (error instanceof PackageAdmissionError) {
    expect(error.reasons.some((reason) => message.test(reason))).toBe(true);
  }
  expect(runtimeCalled).toBe(false);
  expect(await artifactory.publishWriter.listArtifacts(runId)).toEqual([]);
}

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
      body: { body: "hello" },
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
      feedSurface: { mode: "posts" },
      posts: [{
        kind: "quote",
        body: "hello",
        evidence: [{
          kind: "verified_quote",
          evidenceId: "quote-hello",
          sourceRefId: "src-noop",
          quote: "  hello  ",
        }],
      }],
      quality: { criticPass: true, quotesVerified: true, reasons: ["clean noop candidate"], warnings: [] },
      idempotencyBasis: {
        sourceFingerprintMaterial: ["listen-noop", "sha256:src"],
        artifactFingerprintMaterial: { body: "hello" },
      },
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
    // The Worker seam, not the skill, assigns durable idempotency + storage.
    const idempotency = result.publishedArtifacts[0]!.idempotency;
    expect(idempotency.sourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(idempotency.artifactFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(idempotency.dedupeKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.publishedArtifacts[0]!.storage.docKey).toBe("runs/run-happy/c-1.json");
    expect(result.publishedArtifacts[0]!.posts?.[0]?.evidence[0]).toMatchObject({
      verification: { method: "worker_source_quote_match", sourceObservedHash: "sha256:src" },
    });
    const dropReasons = result.dropped.map((entry) => entry.reason);
    expect(dropReasons).toContain("runtime_probe");
    expect(dropReasons.some((reason) => reason.startsWith("validation:"))).toBe(true);

    const status = await artifactory.status({ runId: "run-happy", scope: workflow.packageId });
    expect(status.publishedArtifacts.length).toBe(1);
    expect(status.sourceRefs.length).toBe(1);
    expect(status.dropped.length).toBeGreaterThanOrEqual(1);
    expect(status.lock).toBeNull();
  });

  test("candidates with same sourceRefId but forged provenance metadata are dropped as audited violations", async () => {
    const candidate: CandidateArtifactEnvelope = {
      schemaVersion: "feed.candidate_artifact.v1",
      localCandidateId: "c-forged",
      artifactType: "noop",
      renderShape: "short_form",
      title: "forged provenance",
      body: { body: "reuses an admitted sourceRefId but forges the metadata" },
      sourceRefs: [
        {
          sourceRefId: "src-noop",
          sourceKind: "listen_conversation",
          sourceId: "listen-forged",
          observedPath: "sql_transcript_text",
          observedHash: "sha256:forged",
          observedAt: "2026-07-02T00:00:00.000Z",
        },
      ],
      feedSurface: { mode: "artifact_preview" },
      quality: { criticPass: true, quotesVerified: true, reasons: [], warnings: [] },
      idempotencyBasis: {
        sourceFingerprintMaterial: ["listen-forged", "sha256:forged"],
        artifactFingerprintMaterial: { body: "reuses an admitted sourceRefId but forges the metadata" },
      },
    };
    const runtime: ArtifactSkillRuntime = {
      tool: RUN_ARTIFACT_SKILL,
      async run(_input: ArtifactSkillRuntimeInput): Promise<ArtifactSkillRuntimeOutput> {
        return {
          candidates: [candidate],
          trace: {
            procedureVersion: "test.v1",
            modelCalls: 0,
            toolCalls: [],
            stageTrace: [],
            droppedCandidates: [],
          },
        };
      },
    };

    const artifactory = createArtifactory({ runtime });
    const workflow = await loadWorkflowFile(FIXTURE);
    const result = await artifactory.run({
      runId: "run-provenance",
      ownerId: "test-owner",
      workflow,
      now: new Date("2026-07-02T00:00:00.000Z"),
      leaseMs: 60_000,
    });

    expect(result.status).toBe("zero_artifacts");
    expect(result.publishedArtifacts).toEqual([]);
    expect(result.workflowRun.publishedArtifactIds).toEqual([]);
    expect(result.dropped).toEqual([
      {
        reason: "provenance:source_ref_not_in_source_pack:src-noop",
        localCandidateId: "c-forged",
        title: "forged provenance",
      },
    ]);
    expect(artifactory.dropAudit.list("run-provenance")).toEqual(result.dropped);
  });

  test("new workflow execution drops postless candidates that omit feedSurface", async () => {
    const workflow = await loadWorkflowFile(FIXTURE);
    const candidate: CandidateArtifactEnvelope = {
      schemaVersion: "feed.candidate_artifact.v1",
      localCandidateId: "c-omitted-surface",
      artifactType: "noop",
      renderShape: "short_form",
      title: "Omitted surface",
      body: {},
      sourceRefs: workflow.sourcePack.refs,
      quality: { criticPass: true, quotesVerified: true, reasons: [], warnings: [] },
      idempotencyBasis: { sourceFingerprintMaterial: ["src-noop"], artifactFingerprintMaterial: {} },
    };
    const artifactory = createArtifactory({
      runtime: {
        tool: RUN_ARTIFACT_SKILL,
        async run() {
          return {
            candidates: [candidate],
            trace: { procedureVersion: "test.v1", modelCalls: 0, toolCalls: [], stageTrace: [], droppedCandidates: [] },
          };
        },
      },
    });
    const result = await artifactory.run({
      runId: "run-omitted-surface",
      ownerId: "test-owner",
      workflow,
      now: new Date("2026-07-02T00:00:00.000Z"),
      leaseMs: 60_000,
    });
    expect(result.status).toBe("zero_artifacts");
    expect(result.dropped[0]?.reason).toContain("feedSurface: required for new workflow execution");
  });

  test("drops a candidate that weakens trusted source authority with otherwise identical provenance", async () => {
    const workflow = await loadWorkflowFile(FIXTURE);
    workflow.sourcePack.refs[0]!.authority = {
      lineageId: "cid:private-source",
      releasePolicy: "private",
      audienceDids: ["did:example:reader"],
    };
    const candidate: CandidateArtifactEnvelope = {
      schemaVersion: "feed.candidate_artifact.v1",
      localCandidateId: "c-authority-swap",
      artifactType: "noop",
      renderShape: "short_form",
      title: "Authority swap",
      body: {},
      sourceRefs: [{
        ...workflow.sourcePack.refs[0]!,
        authority: { lineageId: "cid:private-source", releasePolicy: "public" },
      }],
      feedSurface: { mode: "artifact_preview" },
      quality: { criticPass: true, quotesVerified: true, reasons: [], warnings: [] },
      idempotencyBasis: { sourceFingerprintMaterial: ["src-noop"], artifactFingerprintMaterial: {} },
    };
    const artifactory = createArtifactory({
      runtime: {
        tool: RUN_ARTIFACT_SKILL,
        async run() {
          return {
            candidates: [candidate],
            trace: { procedureVersion: "test.v1", modelCalls: 0, toolCalls: [], stageTrace: [], droppedCandidates: [] },
          };
        },
      },
    });
    const result = await artifactory.run({
      runId: "run-authority-swap",
      ownerId: "test-owner",
      workflow,
      now: new Date("2026-07-02T00:00:00.000Z"),
      leaseMs: 60_000,
    });
    expect(result.status).toBe("zero_artifacts");
    expect(result.dropped[0]?.reason).toBe("provenance:source_ref_not_in_source_pack:src-noop");
  });

  test("carries trusted artifactPack access into a restricted parent synthesis", async () => {
    const workflow = await loadWorkflowFile(PACKAGE_FIXTURE);
    workflow.sourcePack.refs[0]!.authority = { lineageId: "cid:public-source", releasePolicy: "public" };
    const parentAccess = workflow.artifactPack!.artifacts[0]!.derivedAccess;
    const parentRef = workflow.artifactPack!.refs[0]!;
    const candidate: CandidateArtifactEnvelope = {
      schemaVersion: "feed.candidate_artifact.v1",
      localCandidateId: "c-parent-synthesis",
      artifactType: "noop",
      renderShape: "short_form",
      title: "Restricted synthesis",
      body: {},
      sourceRefs: workflow.sourcePack.refs,
      parentArtifactRefs: [parentRef],
      feedSurface: { mode: "artifact_preview" },
      quality: { criticPass: true, quotesVerified: true, reasons: [], warnings: [] },
      idempotencyBasis: { sourceFingerprintMaterial: ["src-noop", "parent-restricted"], artifactFingerprintMaterial: {} },
    };
    const artifactory = createArtifactory({
      runtime: {
        tool: RUN_ARTIFACT_SKILL,
        async run(input) {
          expect(input.artifactPack?.artifacts[0]?.derivedAccess).toEqual(parentAccess);
          return {
            candidates: [candidate],
            trace: { procedureVersion: "test.v1", modelCalls: 0, toolCalls: [], stageTrace: [], droppedCandidates: [] },
          };
        },
      },
    });
    const result = await artifactory.run({
      runId: "run-parent-synthesis",
      ownerId: "test-owner",
      workflow,
      now: new Date("2026-07-02T00:00:00.000Z"),
      leaseMs: 60_000,
    });
    expect(result.status).toBe("published");
    expect(result.publishedArtifacts[0]?.derivedAccess).toMatchObject({
      releasePolicy: "delegated",
      audienceDids: ["did:example:reader"],
      expiresAt: "2026-07-03T00:00:00.000Z",
    });
    expect(result.publishedArtifacts[0]?.parentArtifactRefs?.[0]?.derivedAccess).toEqual(parentAccess);
  });

  test("rejects an artifactPack fixture that relaxes restricted parent access without updating its binding", async () => {
    const workflow = await loadWorkflowFile(PACKAGE_FIXTURE);
    workflow.artifactPack!.artifacts[0]!.derivedAccess.releasePolicy = "public";
    workflow.artifactPack!.refs[0]!.observedHash = artifactPackObservedHash(workflow.artifactPack!.artifacts[0]!);
    await expectArtifactPackRejected(workflow, "run-parent-relaxed", /digest mismatch against reviewed package material/);
  });

  test("rejects omitted or malformed parent access before runtime and publication", async () => {
    const omitted = await loadWorkflowFile(PACKAGE_FIXTURE);
    delete (omitted.artifactPack!.artifacts[0] as unknown as { derivedAccess?: unknown }).derivedAccess;
    await expectArtifactPackRejected(omitted, "run-parent-access-omitted", /derivedAccess: required object/);

    const malformed = await loadWorkflowFile(PACKAGE_FIXTURE);
    malformed.artifactPack!.artifacts[0]!.derivedAccess = {
      releasePolicy: "public",
    } as unknown as NonNullable<WorkflowFixture["artifactPack"]>["artifacts"][number]["derivedAccess"];
    await expectArtifactPackRejected(malformed, "run-parent-access-malformed", /derivedAccess.lineage: required array/);
  });

  test("rejects mismatched artifactPack refs and content before runtime and publication", async () => {
    const workflow = await loadWorkflowFile(PACKAGE_FIXTURE);
    workflow.artifactPack!.refs[0]!.artifactType = "forged_report";
    await expectArtifactPackRejected(workflow, "run-parent-ref-mismatch", /artifactType mismatch/);
  });

  test("drops verified quote claims absent from trusted sourcePack excerpts even when candidate fields agree", async () => {
    const candidate: CandidateArtifactEnvelope = {
      schemaVersion: "feed.candidate_artifact.v1",
      localCandidateId: "c-fabricated-quote",
      artifactType: "noop",
      renderShape: "short_form",
      title: "Fabricated quote",
      body: { body: "Candidate claims its own quote is verified." },
      sourceRefs: [{
        sourceRefId: "src-noop",
        sourceKind: "listen_conversation",
        sourceId: "listen-noop",
        observedPath: "sql_transcript_text",
        observedHash: "sha256:src",
        observedAt: "2026-07-02T00:00:00.000Z",
      }],
      feedSurface: { mode: "posts" },
      posts: [{
        kind: "quote",
        body: "This sentence never appeared in the trusted excerpt.",
        evidence: [{
          kind: "verified_quote",
          evidenceId: "quote-fabricated",
          sourceRefId: "src-noop",
          quote: "This sentence never appeared in the trusted excerpt.",
        }],
      }],
      sourceQuotes: [{
        sourceRefId: "src-noop",
        quote: "This sentence never appeared in the trusted excerpt.",
      }],
      quality: { criticPass: true, quotesVerified: true, reasons: ["candidate says verified"], warnings: [] },
      idempotencyBasis: {
        sourceFingerprintMaterial: ["listen-noop", "sha256:src"],
        artifactFingerprintMaterial: { body: "fabricated" },
      },
    };
    const runtime: ArtifactSkillRuntime = {
      tool: RUN_ARTIFACT_SKILL,
      async run(): Promise<ArtifactSkillRuntimeOutput> {
        return {
          candidates: [candidate],
          trace: { procedureVersion: "test.v1", modelCalls: 0, toolCalls: [], stageTrace: [], droppedCandidates: [] },
        };
      },
    };
    const artifactory = createArtifactory({ runtime });
    const workflow = await loadWorkflowFile(FIXTURE);
    const result = await artifactory.run({
      runId: "run-fabricated-quote",
      ownerId: "test-owner",
      workflow,
      now: new Date("2026-07-02T00:00:00.000Z"),
      leaseMs: 60_000,
    });

    expect(result.status).toBe("zero_artifacts");
    expect(result.publishedArtifacts).toEqual([]);
    expect(result.dropped[0]?.reason).toBe(
      "provenance:verified_quote_not_in_source_pack:quote-fabricated",
    );
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

  test("rejects inline workflows that are not reviewed at execution time", async () => {
    const artifactory = createArtifactory();
    const workflow = await readWorkflowFixture(FIXTURE);
    workflow.skillManifest.admissionState = "candidate";

    let error: unknown;
    try {
      await artifactory.run({
        runId: "run-inline-candidate",
        ownerId: "test-owner",
        workflow,
        now: new Date("2026-07-02T00:00:00.000Z"),
        leaseMs: 60_000,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(PackageAdmissionError);
    if (error instanceof PackageAdmissionError) {
      expect(error.reasons.some((reason) => reason.includes("admissionState=candidate"))).toBe(true);
    }
  });

  test("rejects package-backed workflows that are not reviewed at execution time", async () => {
    const artifactory = createArtifactory();
    const workflow = await readWorkflowFixture(PACKAGE_FIXTURE);
    workflow.skillManifest.admissionState = "candidate";

    let error: unknown;
    try {
      await artifactory.run({
        runId: "run-package-candidate",
        ownerId: "test-owner",
        workflow,
        now: new Date("2026-07-02T00:00:00.000Z"),
        leaseMs: 60_000,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(PackageAdmissionError);
    if (error instanceof PackageAdmissionError) {
      expect(error.reasons.some((reason) => reason.includes("admissionState=candidate"))).toBe(true);
    }
  });
});
