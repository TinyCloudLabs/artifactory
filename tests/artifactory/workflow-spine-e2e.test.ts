import { describe, expect, test } from "bun:test";
import { createArtifactory } from "../../packages/artifactory/src/artifactory.ts";
import { resolveUnseenListenResolution, type ListenResolverDriver } from "../../packages/artifactory/src/listen-resolver.ts";
import type { ArtifactSkillRuntime } from "../../packages/artifactory/src/runtime-adapter.ts";
import {
  createInMemoryWorkflowSpineStore,
  processNextWorkflowRun,
  type WorkflowSpinePorts,
} from "../../packages/artifactory/src/workflow-spine.ts";
import { loadWorkflowFile } from "../../packages/artifactory/src/workflow.ts";
import { feedItemIdFor, type FeedArtifact } from "../../skills/_shared/lib/feed-v1.ts";

const FIXTURE = new URL("./fixtures/listen.workflow.json", import.meta.url).pathname;

describe("generic authorized transcript-to-post spine", () => {
  test("selects one unseen delegated transcript, validates a generic workflow, and projects its post", async () => {
    const now = () => new Date("2026-07-14T02:00:00.000Z");
    const driver: ListenResolverDriver = {
      authority: {
        lineageId: "bafy-terminal-listen-child",
        releasePolicy: "delegated",
        audienceDids: ["did:example:feed-host"],
        expiresAt: "2027-07-14T00:00:00.000Z",
      },
      async listRecent() {
        return [{
          id: "conversation-authorized-1",
          started_at: "2026-07-13T18:00:00.000Z",
          transcript_text: "A concrete decision was recorded.",
        }];
      },
      async listAfter() { return []; },
      async loadMany() { return []; },
      async loadTranscript() { return []; },
    };
    const template = await loadWorkflowFile(FIXTURE);
    const runtime: ArtifactSkillRuntime = {
      tool: "RUN_ARTIFACT_SKILL",
      async run(input) {
        expect(input.priorContext?.recentArtifacts?.[0]?.artifactId).toBe("artifact-prior-1");
        const ref = input.sourcePack.refs[0]!;
        return {
          candidates: [{
            schemaVersion: "feed.candidate_artifact.v1",
            localCandidateId: "decision-post",
            artifactType: "noop",
            renderShape: "short_form",
            title: "A decision worth revisiting",
            summary: "One evidence-backed takeaway from newly authorized context.",
            body: { markdown: "# Decision\n\nA concrete decision was recorded." },
            sourceRefs: [ref],
            feedSurface: { mode: "posts" },
            posts: [{
              kind: "insight",
              body: "A concrete decision was recorded.",
              evidence: [{
                kind: "verified_quote",
                evidenceId: "decision-quote",
                sourceRefId: ref.sourceRefId,
                quote: "A concrete decision was recorded.",
              }],
            }],
            sourceQuotes: [{ quote: "A concrete decision was recorded.", sourceRefId: ref.sourceRefId }],
            quality: { criticPass: true, quotesVerified: true, reasons: ["verified"], warnings: [] },
            idempotencyBasis: {
              sourceFingerprintMaterial: [ref.sourceId, ref.observedHash],
              artifactFingerprintMaterial: { decision: "recorded" },
            },
          }],
          trace: {
            procedureVersion: "generic-transcript-to-post.v1",
            modelCalls: 0,
            toolCalls: [],
            stageTrace: [],
            droppedCandidates: [],
          },
        };
      },
    };
    const store = createInMemoryWorkflowSpineStore();
    await store.enqueue({
      requestId: "request-authorized-1",
      runId: "run-authorized-1",
      actorId: "did:example:reader",
      workflowId: template.workflowId,
      packageId: template.packageId,
      maxAttempts: 2,
    }, now());

    const visible = new Map<string, FeedArtifact[]>();
    const feedItems = new Set<string>();
    const ports: WorkflowSpinePorts = {
      sources: {
        async select({ cursor }) {
          const selected = await resolveUnseenListenResolution(
            { auth: { authorityName: "listen-child" }, query: { mostRecent: 1 } },
            template.sourcePack.maxInputTokens,
            cursor,
            { driver, now },
          );
          return {
            sourcePack: selected.sourcePack,
            cursorBefore: selected.cursorBefore,
            cursorAfter: selected.cursorAfter,
          };
        },
      },
      workflow: {
        async execute({ run, sourcePack, priorContext }) {
          const artifactory = createArtifactory({ runtime });
          const result = await artifactory.run({
            runId: run.runId,
            ownerId: "generic-spine",
            workflow: { ...template, listenResolution: undefined, sourcePack },
            now: now(),
            leaseMs: 60_000,
            priorContext,
          });
          return { artifacts: result.publishedArtifacts };
        },
      },
      continuity: {
        async load() {
          return {
            recentArtifacts: [{
              artifactId: "artifact-prior-1",
              artifactType: "noop",
              title: "Prior durable context",
              idempotency: {
                sourceFingerprint: "sha256:prior-source",
                artifactFingerprint: "sha256:prior-artifact",
                dedupeKey: "sha256:prior-dedupe",
              },
            }],
          };
        },
      },
      publisher: {
        async publish({ fence, publicationKey, artifacts }) {
          if (!visible.has(publicationKey)) visible.set(publicationKey, structuredClone(artifacts));
          const artifactIds = visible.get(publicationKey)!.map((artifact) => artifact.artifactId);
          const run = await store.checkpoint(
            fence,
            { phase: "publishing", publicationKey, publishedArtifactIds: artifactIds },
            { event: "publish_started", at: now().toISOString() },
          );
          return { outcome: "published", run, artifactIds };
        },
        async resume({ fence }) {
          const run = await store.assertCurrent(fence, now());
          return { outcome: "published", run, artifactIds: run.publishedArtifactIds };
        },
      },
      feed: {
        async reconcile({ fence, artifactIds }) {
          await store.assertCurrent(fence, now());
          for (const artifacts of visible.values()) {
            for (const artifact of artifacts.filter((entry) => artifactIds.includes(entry.artifactId))) {
              for (const post of artifact.posts ?? []) feedItems.add(feedItemIdFor(artifact.artifactId, post.postId));
            }
          }
          return store.checkpoint(
            fence,
            { phase: "reconciling" },
            { event: "feed_reconciled", at: now().toISOString() },
          );
        },
      },
    };

    const result = await processNextWorkflowRun({
      store,
      ports,
      ownerId: "worker-authorized",
      leaseMs: 60_000,
      now,
    });

    expect(result?.run.phase).toBe("published");
    expect(result?.run.sourceRefIds).toEqual(["conversation-authorized-1"]);
    expect(result?.run.publishedArtifactIds).toEqual(["run-authorized-1:decision-post"]);
    expect(await store.committedCursor("did:example:reader", template.workflowId)).toContain("conversation-authorized-1");
    const published = [...visible.values()][0]![0]!;
    expect(feedItems).toEqual(new Set([feedItemIdFor(published.artifactId, published.posts![0]!.postId)]));
    expect(published.sourceRefs[0]?.authority?.lineageId).toBe("bafy-terminal-listen-child");
    expect(published.posts?.[0]?.evidence[0]).toMatchObject({
      verification: { method: "worker_source_quote_match" },
    });
  });
});
