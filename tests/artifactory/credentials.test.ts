import { describe, expect, test } from "bun:test";
import { createArtifactory } from "../../packages/artifactory/src/artifactory.ts";
import { loadWorkflowFile } from "../../packages/artifactory/src/workflow.ts";
import {
  RUN_ARTIFACT_SKILL,
  type ArtifactSkillRuntime,
  type ArtifactSkillRuntimeInput,
  type ArtifactSkillRuntimeOutput,
} from "../../packages/artifactory/src/runtime-adapter.ts";
import type { CandidateArtifactEnvelope } from "../../skills/_shared/lib/feed-v1.ts";

const FIXTURE = new URL("./fixtures/noop.workflow.json", import.meta.url).pathname;
const BYOK_SECRET_REF = "vault/secrets/scoped/feed/ANTHROPIC_API_KEY";
const FEED_HOSTED_SECRET_REF = "vault/secrets/scoped/feed/OPENAI_API_KEY";

function makeCandidate(overrides: Partial<CandidateArtifactEnvelope> = {}): CandidateArtifactEnvelope {
  return {
    schemaVersion: "feed.candidate_artifact.v1",
    localCandidateId: "candidate-1",
    artifactType: "noop",
    renderShape: "short_form",
    title: "result",
    body: { text: "result" },
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
    quality: { criticPass: true, quotesVerified: true, reasons: [], warnings: [] },
    idempotencyBasis: {
      sourceFingerprintMaterial: ["listen-noop", "sha256:src"],
      artifactFingerprintMaterial: { text: "result" },
    },
    storage: { docKey: "artifacts/candidate-1.json" },
    ...overrides,
  };
}

function makeRuntime(
  output: ArtifactSkillRuntimeOutput,
  seen: { input?: ArtifactSkillRuntimeInput } = {},
): ArtifactSkillRuntime {
  return {
    tool: RUN_ARTIFACT_SKILL,
    async run(input) {
      seen.input = input;
      return output;
    },
  };
}

describe("artifactory credential and budget gates", () => {
  test("feed-hosted runs inject exact secret refs and record the real budget amount", async () => {
    const seen: { input?: ArtifactSkillRuntimeInput } = {};
    const runtime = makeRuntime(
      {
        candidates: [],
        trace: {
          procedureVersion: "feed-hosted.v1",
          modelCalls: 0,
          toolCalls: [],
          stageTrace: [],
          droppedCandidates: [],
        },
      },
      seen,
    );
    const artifactory = createArtifactory({ runtime });
    const workflow = await loadWorkflowFile(FIXTURE);
    workflow.runtimePolicy = {
      ...workflow.runtimePolicy,
      credentialMode: "feed_hosted",
      providerClass: "first_party",
      budgetId: "m0-feed-hosted",
    };
    workflow.skillManifest = {
      ...workflow.skillManifest,
      disclosure: {
        ...workflow.skillManifest.disclosure,
        credentialOwner: "feed_hosted",
      },
    };
    workflow.settings = {
      credentials: {
        credentialMode: "feed_hosted",
        providerId: "openai",
      },
      budget: {
        budgetId: "m0-feed-hosted",
        amount: 1.5,
        limit: 5,
        currency: "USD",
        spendClass: "model",
      },
    };

    const result = await artifactory.run({
      runId: "run-feed-hosted",
      ownerId: "test-owner",
      workflow,
      now: new Date("2026-07-02T00:00:00.000Z"),
      leaseMs: 60_000,
    });

    expect(result.status).toBe("zero_artifacts");
    expect(seen.input?.secretEnv).toEqual([
      {
        name: "OPENAI_API_KEY",
        secretRef: FEED_HOSTED_SECRET_REF,
        injection: "env",
        stageId: workflow.skillManifest.stageCapabilities[0]?.stageId ?? "run",
        source: "worker_injected",
      },
    ]);
    expect(result.workflowRun.spend).toEqual({
      budgetId: "m0-feed-hosted",
      amount: 1.5,
      currency: "USD",
    });
    const totals = await artifactory.costLedger.totals({ runId: "run-feed-hosted" });
    expect(totals).toEqual([{ amount: 1.5, currency: "USD", entries: 1 }]);
  });

  test("BYOK runs redact secret refs from output, artifacts, and traces", async () => {
    const secretRef = BYOK_SECRET_REF;
    const runtime = makeRuntime({
      candidates: [
        makeCandidate({
          title: `candidate uses ${secretRef}`,
          summary: `summary ${secretRef}`,
          body: {
            text: `body ${secretRef}`,
            nested: { token: `${secretRef} raw-secret` },
          },
        }),
      ],
      trace: {
        procedureVersion: "byok.v1",
        modelCalls: 1,
        toolCalls: [{ name: "demo", purpose: `call ${secretRef} api_key=sk-test` }],
        stageTrace: [
          {
            stageId: "stub",
            declaredCapabilities: [],
            grantedCapabilities: [],
            authorityUsed: false,
            deniedReasons: [`Bearer ${secretRef}`],
          },
        ],
        droppedCandidates: [{ reason: `secret-ref ${secretRef}` }],
      },
    });
    const artifactory = createArtifactory({ runtime });
    const workflow = await loadWorkflowFile(FIXTURE);
    workflow.runtimePolicy = {
      ...workflow.runtimePolicy,
      credentialMode: "user_byok_api_key",
      providerClass: "user_byok",
      budgetId: "m0-byok",
    };
    workflow.skillManifest = {
      ...workflow.skillManifest,
      disclosure: {
        ...workflow.skillManifest.disclosure,
        credentialOwner: "user_byok_api_key",
      },
    };
    workflow.settings = {
      credentials: {
        credentialMode: "user_byok_api_key",
        secretRef,
      },
      budget: {
        budgetId: "m0-byok",
        amount: 0,
        limit: 10,
        currency: "USD",
      },
    };

    const result = await artifactory.run({
      runId: "run-byok",
      ownerId: "test-owner",
      workflow,
      now: new Date("2026-07-02T00:00:00.000Z"),
      leaseMs: 60_000,
    });

    expect(result.status).toBe("published");
    expect(JSON.stringify(result.runtimeOutput)).not.toContain(secretRef);
    expect(result.runtimeOutput.trace.toolCalls[0]?.purpose).toContain("[REDACTED]");
    expect(result.runtimeOutput.trace.stageTrace[0]?.deniedReasons[0]).toContain("[REDACTED]");
    expect(result.runtimeOutput.trace.droppedCandidates[0]?.reason).toContain("[REDACTED]");
    expect(result.publishedArtifacts[0]?.title).toContain("[REDACTED]");
    expect(JSON.stringify(result.publishedArtifacts[0])).not.toContain(secretRef);
  });

  test("budget exhaustion blocks before lock acquisition and runtime dispatch even if settings spent is lowered", async () => {
    const artifactory = createArtifactory({
      runtime: {
        tool: RUN_ARTIFACT_SKILL,
        async run() {
          throw new Error("runtime must not run when budget is exhausted");
        },
      },
    });
    const workflow = await loadWorkflowFile(FIXTURE);
    workflow.runtimePolicy = {
      ...workflow.runtimePolicy,
      credentialMode: "none",
      budgetId: "m0-budget",
    };
    workflow.settings = {
      budget: {
        budgetId: "m0-budget",
        limit: 1,
        amount: 1,
        currency: "USD",
        spent: 0,
      },
    };
    await artifactory.costLedger.record({
      ledgerId: "seed-budget-spend",
      userId: "test-owner",
      budgetId: "m0-budget",
      windowStart: "2026-07-02T00:00:00.000Z",
      spendClass: "model",
      amount: 1,
      currency: "USD",
      runId: "seeded-run",
      recordedAt: "2026-07-02T00:00:00.000Z",
    });

    const result = await artifactory.run({
      runId: "run-budget-blocked",
      ownerId: "test-owner",
      workflow,
      now: new Date("2026-07-02T00:00:00.000Z"),
      leaseMs: 60_000,
    });

    expect(result.status).toBe("blocked_budget");
    expect(result.workflowRun.error).toEqual({
      code: "budget_exhausted",
      message: "budget m0-budget exhausted",
    });
    expect(await artifactory.runLock.peek(workflow.packageId)).toBeNull();
    expect(await artifactory.costLedger.list({ runId: "run-budget-blocked" })).toEqual([]);
  });

  test("kill switches and missing secrets block before dispatch with distinct audited states", async () => {
    const artifactory = createArtifactory({
      runtime: {
        tool: RUN_ARTIFACT_SKILL,
        async run() {
          throw new Error("runtime must not run when a gate blocks");
        },
      },
    });
    const workflow = await loadWorkflowFile(FIXTURE);
    workflow.runtimePolicy = {
      ...workflow.runtimePolicy,
      credentialMode: "user_oauth_token",
      budgetId: "m0-controls",
    };
    workflow.skillManifest = {
      ...workflow.skillManifest,
      disclosure: {
        ...workflow.skillManifest.disclosure,
        credentialOwner: "user_oauth_token",
      },
    };

    workflow.settings = {
      credentials: {
        credentialMode: "user_oauth_token",
        secretState: "missing_secret",
      },
      budget: {
        budgetId: "m0-controls",
        limit: 10,
        amount: 0,
        currency: "USD",
      },
    };

    const blockedSecret = await artifactory.run({
      runId: "run-secret-blocked",
      ownerId: "test-owner",
      workflow,
      now: new Date("2026-07-02T00:00:00.000Z"),
      leaseMs: 60_000,
    });
    expect(blockedSecret.status).toBe("blocked_secret");
    expect(blockedSecret.workflowRun.error?.code).toBe("missing_secret");

    workflow.settings = {
      credentials: {
        credentialMode: "user_oauth_token",
        secretRef: BYOK_SECRET_REF,
      },
      killSwitches: {
        globalDisabled: true,
      },
      budget: {
        budgetId: "m0-controls",
        limit: 10,
        amount: 0,
        currency: "USD",
      },
    };

    const blockedKillSwitch = await artifactory.run({
      runId: "run-disabled",
      ownerId: "test-owner",
      workflow,
      now: new Date("2026-07-02T00:00:00.000Z"),
      leaseMs: 60_000,
    });
    expect(blockedKillSwitch.status).toBe("blocked_authority");
    expect(blockedKillSwitch.workflowRun.error?.code).toBe("run_disabled_global");
  });
});
