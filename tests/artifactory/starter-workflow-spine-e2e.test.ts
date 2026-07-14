import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createArtifactory } from "../../packages/artifactory/src/artifactory.ts";
import { compileSkillPackage } from "../../packages/artifactory/src/package-compiler.ts";
import type { ArtifactSkillRuntime } from "../../packages/artifactory/src/runtime-adapter.ts";
import {
  createInMemoryWorkflowSpineStore,
  processNextWorkflowRun,
  type WorkflowSpinePorts,
} from "../../packages/artifactory/src/workflow-spine.ts";
import { loadWorkflowFile, type WorkflowFixture } from "../../packages/artifactory/src/workflow.ts";
import {
  feedItemIdFor,
  type CandidateArtifactEnvelope,
  type FeedArtifact,
  type SkillRequestContext,
  type SkillRunInput,
} from "../../skills/_shared/lib/feed-v1.ts";

const SKILLS_ROOT = resolve(import.meta.dir, "../../skills");
const NOW = new Date("2026-07-14T12:00:00.000Z");
const SOURCE_QUOTE =
  "Hunter said the release checklist must be checked before deployment, and Sam assigned final verification to Morgan.";

const STARTERS = [
  { packageId: "feed-short-insights", artifactType: "insight_collection" },
  { packageId: "feed-daily-brief", artifactType: "daily_brief" },
  { packageId: "feed-exception-alert", artifactType: "exception_alert" },
  { packageId: "feed-synthesis-report", artifactType: "synthesis_report" },
  { packageId: "feed-decision-memo", artifactType: "decision_memo" },
  { packageId: "feed-playbook", artifactType: "playbook" },
] as const;

type Starter = (typeof STARTERS)[number];

function sourcePack(packageId: string, weakSource: boolean): SkillRunInput["sourcePack"] {
  const sourceRefId = `source-${packageId}`;
  return {
    refs: [{
      sourceRefId,
      sourceKind: "listen_conversation",
      sourceId: `conversation-${packageId}`,
      observedPath: "sql_transcript_text",
      observedHash: `sha256:${packageId}-source`,
      observedAt: NOW.toISOString(),
    }],
    excerpts: [{
      sourceRefId,
      text: weakSource
        ? "The participants exchanged greetings but recorded no baseline, deviation, consequence, or action."
        : SOURCE_QUOTE,
      quoteLineRefs: ["0"],
    }],
    maxInputTokens: 12000,
  };
}

function settingsFor(packageId: Starter["packageId"]): unknown {
  switch (packageId) {
    case "feed-short-insights":
      return { maxPosts: 4, audienceRole: "product lead" };
    case "feed-daily-brief":
      return { audienceRole: "product lead", deliveryTime: "07:00", timezone: "UTC" };
    case "feed-exception-alert":
      return { monitorKey: "release-readiness", expectedBaseline: "checklist complete" };
    case "feed-synthesis-report":
      return { topicKey: "release-process", question: "What improves release confidence?" };
    case "feed-decision-memo":
      return { decisionKey: "release-gate", decision: "Should the release proceed?" };
    case "feed-playbook":
      return { processKey: "release-checklist", outcome: "Ship a verified release" };
  }
}

async function loadStarterWorkflow(
  starter: Starter,
  weakSource = false,
): Promise<WorkflowFixture> {
  const packageRoot = join(SKILLS_ROOT, starter.packageId);
  const compiled = await compileSkillPackage(packageRoot);
  const fixture = {
    workflowId: compiled.workflowPack.workflowId,
    packageId: compiled.package.packageId,
    version: compiled.package.version,
    digest: compiled.package.digest,
    packageRoot,
    skillManifest: compiled.manifest,
    runtimePolicy: {
      ...compiled.manifest.runtimePolicy,
      budgetId: "starter-e2e",
    },
    sourcePack: sourcePack(starter.packageId, weakSource),
    settings: settingsFor(starter.packageId),
    maxAcceptedArtifacts: compiled.manifest.limits.maxAcceptedArtifacts,
  };
  const tempRoot = await mkdtemp(join(tmpdir(), "feed-starter-workflow-"));
  const fixturePath = join(tempRoot, `${starter.packageId}.workflow.json`);
  try {
    await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    return await loadWorkflowFile(fixturePath);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function requestContextFor(starter: Starter): SkillRequestContext | undefined {
  if (![
    "feed-synthesis-report",
    "feed-decision-memo",
  ].includes(starter.packageId)) return undefined;
  return {
    scope: {
      packageId: starter.packageId,
      artifactType: starter.artifactType,
      sourceRefId: `source-${starter.packageId}`,
    },
    prompt: starter.packageId === "feed-synthesis-report"
      ? "Synthesize what the release evidence says about confidence and ownership."
      : "Frame whether the release should proceed and compare the options.",
  };
}

function bodyFor(starter: Starter, input: SkillRunInput): unknown {
  const sourceRefId = input.sourcePack.refs[0]!.sourceRefId;
  switch (starter.packageId) {
    case "feed-short-insights":
      return {
        insights: [
          {
            claim: "A release checklist is an explicit gate.",
            implication: "The team can detect incomplete readiness before deployment.",
            evidenceSourceIds: [sourceRefId],
          },
          {
            claim: "Final verification has a named owner.",
            implication: "Morgan is accountable for closing the release loop.",
            evidenceSourceIds: [sourceRefId],
          },
        ],
      };
    case "feed-daily-brief":
      return {
        audienceRole: "product lead",
        priorities: [{
          development: "The release now has a checklist gate and named verifier.",
          implication: "Readiness can be confirmed before deployment.",
          confidence: "high",
          evidenceSourceIds: [sourceRefId],
        }],
        followUps: ["Confirm Morgan completed final verification."],
      };
    case "feed-exception-alert":
      return {
        baseline: "The release checklist is complete before deployment.",
        deviation: "Final verification remains assigned but not yet confirmed.",
        impact: "Deployment readiness is not established.",
        urgency: "high",
        confidence: "high",
        evidenceSourceIds: [sourceRefId],
      };
    case "feed-synthesis-report":
      return {
        assessment: input.requestContext!.prompt!,
        findings: [{
          finding: "Release confidence depends on both a checklist and named verification ownership.",
          confidence: "high",
          evidenceSourceIds: [sourceRefId],
        }],
        uncertainties: ["The transcript does not confirm that verification is complete."],
        dissent: [],
      };
    case "feed-decision-memo":
      return {
        decision: input.requestContext!.prompt!,
        options: [
          {
            label: "Proceed after verification",
            description: "Wait for Morgan to confirm the checklist, then deploy.",
            tradeoffs: ["Slower release, stronger readiness evidence."],
            evidenceSourceIds: [sourceRefId],
          },
          {
            label: "Pause the release",
            description: "Hold deployment until unresolved checks are reviewed.",
            tradeoffs: ["Schedule impact, lower operational risk."],
            evidenceSourceIds: [sourceRefId],
          },
        ],
        openQuestions: ["Has Morgan completed final verification?"],
      };
    case "feed-playbook":
      return {
        outcome: "Ship a verified release.",
        owner: "Morgan",
        prerequisites: ["A completed release checklist."],
        steps: [{
          instruction: "Check every release item before deployment.",
          caution: "Do not deploy while final verification is unresolved.",
          evidenceSourceIds: [sourceRefId],
        }],
        validationChecks: ["Morgan confirms final verification."],
      };
  }
}

function sectionTargetsFor(starter: Starter): Array<{
  sectionId: string;
  title: string;
  bodyPath: string;
}> {
  switch (starter.packageId) {
    case "feed-short-insights":
      return [
        { sectionId: "primary", title: "Checklist gate", bodyPath: "/insights/0/claim" },
        { sectionId: "secondary", title: "Verification owner", bodyPath: "/insights/1/claim" },
      ];
    case "feed-daily-brief":
      return [
        { sectionId: "primary", title: "Priority", bodyPath: "/priorities/0/development" },
        { sectionId: "secondary", title: "Implication", bodyPath: "/priorities/0/implication" },
      ];
    case "feed-exception-alert":
      return [
        { sectionId: "primary", title: "Deviation", bodyPath: "/deviation" },
        { sectionId: "secondary", title: "Impact", bodyPath: "/impact" },
      ];
    case "feed-synthesis-report":
      return [
        { sectionId: "primary", title: "Assessment", bodyPath: "/assessment" },
        { sectionId: "secondary", title: "Finding", bodyPath: "/findings/0/finding" },
      ];
    case "feed-decision-memo":
      return [
        { sectionId: "primary", title: "Decision", bodyPath: "/decision" },
        { sectionId: "secondary", title: "Option", bodyPath: "/options/0/description" },
      ];
    case "feed-playbook":
      return [
        { sectionId: "primary", title: "Outcome", bodyPath: "/outcome" },
        { sectionId: "secondary", title: "First step", bodyPath: "/steps/0/instruction" },
      ];
  }
}

function valueAtBodyPath(body: unknown, path: string): unknown {
  let current = body;
  for (const part of path.slice(1).split("/")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function candidateFor(starter: Starter, input: SkillRunInput): CandidateArtifactEnvelope {
  const ref = input.sourcePack.refs[0]!;
  const sectionTargets = sectionTargetsFor(starter);
  return {
    schemaVersion: "feed.candidate_artifact.v1",
    localCandidateId: `${starter.packageId}-candidate`,
    artifactType: starter.artifactType,
    renderShape: "longform",
    title: `${starter.packageId} artifact`,
    summary: "A durable, evidence-backed starter workflow artifact.",
    body: bodyFor(starter, input),
    renderHints: {
      sectionIds: sectionTargets.map((target) => target.sectionId),
      sectionTargets,
    },
    sourceRefs: [ref],
    feedSurface: { mode: "posts" },
    posts: sectionTargets.map(({ sectionId }, index) => ({
      kind: index === 0 ? "insight" : "follow_up",
      title: index === 0 ? "Primary finding" : "What to check next",
      body: index === 0
        ? `${starter.packageId}: release readiness has explicit evidence.`
        : `${starter.packageId}: final verification still needs an accountable check.`,
      sectionId,
      evidence: [{
        kind: "verified_quote",
        evidenceId: `${starter.packageId}-evidence-${index}`,
        sourceRefId: ref.sourceRefId,
        quote: SOURCE_QUOTE,
      }],
    })),
    sourceQuotes: [{ quote: SOURCE_QUOTE, sourceRefId: ref.sourceRefId }],
    quality: {
      criticPass: true,
      quotesVerified: true,
      reasons: ["schema-valid and grounded"],
      warnings: [],
    },
    idempotencyBasis: {
      sourceFingerprintMaterial: [ref.sourceId, ref.observedHash],
      artifactFingerprintMaterial: { packageId: starter.packageId, body: bodyFor(starter, input) },
    },
  };
}

async function runStarter(
  starter: Starter,
  options: { weakSource?: boolean } = {},
): Promise<{
  phase: string | undefined;
  published: FeedArtifact[];
  feedItemIds: Set<string>;
  cursor: string | undefined;
}> {
  const workflow = await loadStarterWorkflow(starter, options.weakSource);
  const requestContext = requestContextFor(starter);
  const runtime: ArtifactSkillRuntime = {
    tool: "RUN_ARTIFACT_SKILL",
    async run(input) {
      expect(input.executionBundle).toBeDefined();
      expect(input.executionBundle?.packageDigest).toBe(workflow.digest);
      expect(input.executionBundle?.outputSchemaRef).toBe("schemas/output.schema.json");
      expect(input.executionBundle?.outputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(input.executionBundle?.evaluators[0]?.ref).toBe("evaluators/quality.md");
      expect(input.executionBundle?.instructions.length).toBeGreaterThan(100);
      if (requestContext) {
        expect(input.requestContext).toEqual(requestContext);
        expect(input.requestContext?.scope.packageId).toBe(starter.packageId);
        expect(input.requestContext?.scope.artifactType).toBe(starter.artifactType);
        expect(input.requestContext?.scope.sourceRefId).toBe(`source-${starter.packageId}`);
        expect(input.requestContext?.prompt?.length).toBeGreaterThan(20);
      }
      return {
        candidates: options.weakSource ? [] : [candidateFor(starter, input)],
        trace: {
          procedureVersion: `${starter.packageId}.deterministic-e2e.v1`,
          modelCalls: 0,
          toolCalls: [],
          stageTrace: [],
          droppedCandidates: [],
        },
      };
    },
  };
  const store = createInMemoryWorkflowSpineStore();
  const runId = `run-${starter.packageId}${options.weakSource ? "-quiet" : ""}`;
  await store.enqueue({
    requestId: `request-${runId}`,
    runId,
    actorId: "did:example:starter-reader",
    workflowId: workflow.workflowId,
    packageId: workflow.packageId,
    maxAttempts: 2,
    requestContext,
  }, NOW);

  const publications = new Map<string, FeedArtifact[]>();
  const feedItemIds = new Set<string>();
  const ports: WorkflowSpinePorts = {
    sources: {
      async select({ cursor }) {
        return {
          sourcePack: workflow.sourcePack,
          cursorBefore: cursor ?? "cursor:start",
          cursorAfter: `cursor:${workflow.sourcePack.refs[0]!.sourceRefId}`,
        };
      },
    },
    workflow: {
      async execute({ run, priorContext, requestContext: durableRequestContext }) {
        expect(durableRequestContext).toEqual(requestContext);
        const artifactory = createArtifactory({ runtime });
        const result = await artifactory.run({
          runId: run.runId,
          ownerId: "starter-spine",
          workflow,
          now: NOW,
          leaseMs: 60_000,
          priorContext,
          requestContext: durableRequestContext,
        });
        return { artifacts: result.publishedArtifacts };
      },
    },
    continuity: {
      async load() {
        return { recentArtifacts: [] };
      },
    },
    publisher: {
      async publish({ fence, publicationKey, artifacts }) {
        publications.set(publicationKey, structuredClone(artifacts));
        const artifactIds = artifacts.map((artifact) => artifact.artifactId);
        const run = await store.checkpoint(
          fence,
          { phase: "publishing", publicationKey, publishedArtifactIds: artifactIds },
          { event: "publish_started", at: NOW.toISOString() },
        );
        return { outcome: "published", run, artifactIds };
      },
      async resume({ fence }) {
        const run = await store.assertCurrent(fence, NOW);
        return { outcome: "published", run, artifactIds: run.publishedArtifactIds };
      },
    },
    feed: {
      async reconcile({ fence, artifactIds }) {
        for (const artifacts of publications.values()) {
          for (const artifact of artifacts.filter((entry) => artifactIds.includes(entry.artifactId))) {
            for (const post of artifact.posts ?? []) {
              feedItemIds.add(feedItemIdFor(artifact.artifactId, post.postId));
            }
          }
        }
        return store.checkpoint(
          fence,
          { phase: "reconciling" },
          { event: "feed_reconciled", at: NOW.toISOString() },
        );
      },
    },
  };

  const result = await processNextWorkflowRun({
    store,
    ports,
    ownerId: "starter-worker",
    leaseMs: 60_000,
    now: () => NOW,
  });
  return {
    phase: result?.run.phase,
    published: [...publications.values()].flat(),
    feedItemIds,
    cursor: await store.committedCursor("did:example:starter-reader", workflow.workflowId),
  };
}

describe("starter packages through the durable generic workflow spine", () => {
  test("publishes all six rich artifact formats with distinct evidence-backed Feed posts", async () => {
    for (const starter of STARTERS) {
      const result = await runStarter(starter);
      expect(result.phase).toBe("published");
      expect(result.published).toHaveLength(1);
      expect(result.cursor).toBe(`cursor:source-${starter.packageId}`);

      const artifact = result.published[0]!;
      expect(artifact.artifactType).toBe(starter.artifactType);
      expect(artifact.renderShape).toBe("longform");
      expect(artifact.body).toBeTruthy();
      expect(artifact.posts).toHaveLength(2);
      expect(new Set(artifact.posts?.map((post) => post.body)).size).toBe(2);
      expect(result.feedItemIds.size).toBe(2);

      const sectionTargets = artifact.renderHints?.sectionTargets as Array<{
        sectionId: string;
        title: string;
        bodyPath: string;
      }>;
      expect(sectionTargets).toHaveLength(artifact.posts!.length);
      for (const post of artifact.posts ?? []) {
        const sectionTarget = sectionTargets.find(
          (target) => target.sectionId === post.expansionTarget.sectionId,
        );
        expect(sectionTarget).toBeDefined();
        expect(sectionTarget?.title.length).toBeGreaterThan(0);
        expect(sectionTarget?.bodyPath.startsWith("/")).toBe(true);
        expect(valueAtBodyPath(artifact.body, sectionTarget!.bodyPath)).toBeString();
        expect(String(valueAtBodyPath(artifact.body, sectionTarget!.bodyPath)).length).toBeGreaterThan(0);
        expect(post.evidence).toHaveLength(1);
        expect(post.evidence[0]).toMatchObject({
          kind: "verified_quote",
          sourceRefId: `source-${starter.packageId}`,
          verification: {
            method: "worker_source_quote_match",
            sourceObservedHash: `sha256:${starter.packageId}-source`,
          },
        });
      }

      if (starter.packageId === "feed-synthesis-report") {
        expect(artifact.body).toMatchObject({
          assessment: "Synthesize what the release evidence says about confidence and ownership.",
        });
      }
      if (starter.packageId === "feed-decision-memo") {
        expect(artifact.body).toMatchObject({
          decision: "Frame whether the release should proceed and compare the options.",
        });
      }
    }
  });

  test("keeps exception-alert quiet for weak source material", async () => {
    const starter = STARTERS.find((entry) => entry.packageId === "feed-exception-alert")!;
    const result = await runStarter(starter, { weakSource: true });
    expect(result.phase).toBe("zero_artifacts");
    expect(result.published).toEqual([]);
    expect(result.feedItemIds).toEqual(new Set());
    expect(result.cursor).toBe("cursor:source-feed-exception-alert");
  });
});
