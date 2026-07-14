import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { FeedArtifact, SkillRunInput } from "../../skills/_shared/lib/feed-v1.ts";
import {
  StaleWorkflowFenceError,
  createInMemoryWorkflowSpineStore,
  processNextWorkflowRun,
  type DurableWorkflowRun,
  type WorkflowSpinePorts,
} from "../../packages/artifactory/src/workflow-spine.ts";

const ACTOR = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const WORKFLOW = "workflow.generic.insight";
const RUN = "run-request-1";
const REQUEST = "request-1";

async function artifact(): Promise<FeedArtifact> {
  return JSON.parse(
    await readFile(new URL("../fixtures/feed-v1/rich-artifact.json", import.meta.url), "utf8"),
  ) as FeedArtifact;
}

function sourcePack(id = "conversation-1"): SkillRunInput["sourcePack"] {
  return {
    refs: [{
      sourceRefId: id,
      sourceKind: "listen_conversation",
      sourceId: id,
      observedPath: "sql_transcript_json",
      observedHash: `sha256:${id}`,
      observedAt: "2026-07-14T00:00:00.000Z",
    }],
    excerpts: [{ sourceRefId: id, text: "A verified transcript excerpt." }],
    maxInputTokens: 1000,
  };
}

async function enqueue(store: ReturnType<typeof createInMemoryWorkflowSpineStore>, now: Date): Promise<void> {
  await store.enqueue({
    requestId: REQUEST,
    runId: RUN,
    actorId: ACTOR,
    workflowId: WORKFLOW,
    packageId: "xyz.tinycloud.generic-insight",
    maxAttempts: 2,
  }, now);
}

function ports(input: {
  store: ReturnType<typeof createInMemoryWorkflowSpineStore>;
  now: () => Date;
  artifacts?: FeedArtifact[];
  publish?: WorkflowSpinePorts["publisher"]["publish"];
  resume?: WorkflowSpinePorts["publisher"]["resume"];
  reconcile?: WorkflowSpinePorts["feed"]["reconcile"];
  execute?: WorkflowSpinePorts["workflow"]["execute"];
}): WorkflowSpinePorts {
  return {
    sources: {
      async select({ cursor }) {
        return { sourcePack: sourcePack(), cursorBefore: cursor ?? "0", cursorAfter: "1" };
      },
    },
    workflow: {
      execute: input.execute ?? (async () => ({ artifacts: input.artifacts ?? [] })),
    },
    publisher: {
      publish: input.publish ?? (async ({ fence, publicationKey, artifacts }) => {
        await input.store.checkpoint(
          fence,
          { phase: "publishing", publicationKey, publishedArtifactIds: artifacts.map((entry) => entry.artifactId) },
          { event: "publish_started", at: input.now().toISOString() },
        );
        const run = await input.store.checkpoint(
          fence,
          {},
          { event: "artifacts_published", at: input.now().toISOString() },
        );
        return { outcome: "published", run, artifactIds: artifacts.map((entry) => entry.artifactId) };
      }),
      resume: input.resume ?? (async ({ fence }) => {
        const run = await input.store.assertCurrent(fence, input.now());
        return { outcome: "published", run, artifactIds: run.publishedArtifactIds };
      }),
    },
    feed: {
      reconcile: input.reconcile ?? (async ({ fence }) => {
        return input.store.checkpoint(
          fence,
          { phase: "reconciling" },
          { event: "feed_reconciled", at: input.now().toISOString() },
        );
      }),
    },
  };
}

describe("durable generic workflow spine", () => {
  test("runs authorized unseen sources through publish, reconciliation, then cursor commit", async () => {
    const store = createInMemoryWorkflowSpineStore();
    const now = () => new Date("2026-07-14T00:00:10.000Z");
    await enqueue(store, new Date("2026-07-14T00:00:00.000Z"));
    const result = await processNextWorkflowRun({
      store,
      ports: ports({ store, now, artifacts: [await artifact()] }),
      ownerId: "worker-a",
      leaseMs: 60_000,
      now,
    });

    expect(result?.run.phase).toBe("published");
    expect(result?.run.sourceRefIds).toEqual(["conversation-1"]);
    expect(result?.run.publicationKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result?.run.publishedArtifactIds).toHaveLength(1);
    expect(await store.committedCursor(ACTOR, WORKFLOW)).toBe("1");
    expect(result?.run.timings.map((entry) => entry.event)).toEqual([
      "queued",
      "claimed",
      "sources_selected",
      "workflow_validated",
      "publish_started",
      "artifacts_published",
      "feed_reconciled",
      "cursor_committed",
    ]);
  });

  test("zero-output success still commits its source cursor", async () => {
    const store = createInMemoryWorkflowSpineStore();
    const now = () => new Date("2026-07-14T00:01:00.000Z");
    await enqueue(store, now());
    const result = await processNextWorkflowRun({
      store,
      ports: ports({ store, now }),
      ownerId: "worker-a",
      leaseMs: 60_000,
      now,
    });

    expect(result?.run.phase).toBe("zero_artifacts");
    expect(result?.run.publishedArtifactIds).toEqual([]);
    expect(await store.committedCursor(ACTOR, WORKFLOW)).toBe("1");
  });

  test("honors cancellation before publish and leaves the cursor unchanged", async () => {
    const store = createInMemoryWorkflowSpineStore();
    const now = () => new Date("2026-07-14T00:02:00.000Z");
    await enqueue(store, now());
    const result = await processNextWorkflowRun({
      store,
      ports: ports({
        store,
        now,
        execute: async () => {
          expect((await store.requestCancel(RUN, now())).accepted).toBe(true);
          return { artifacts: [await artifact()] };
        },
      }),
      ownerId: "worker-a",
      leaseMs: 60_000,
      now,
    });

    expect(result?.run.phase).toBe("cancelled");
    expect(await store.committedCursor(ACTOR, WORKFLOW)).toBeUndefined();
  });

  test("a cancellation requested while queued prevents any source read", async () => {
    const store = createInMemoryWorkflowSpineStore();
    const now = () => new Date("2026-07-14T00:02:30.000Z");
    await enqueue(store, now());
    expect((await store.requestCancel(RUN, now())).accepted).toBe(true);
    let selected = false;
    const configured = ports({ store, now });
    configured.sources.select = async () => {
      selected = true;
      throw new Error("cancelled work must not read sources");
    };
    const result = await processNextWorkflowRun({
      store,
      ports: configured,
      ownerId: "worker-a",
      leaseMs: 60_000,
      now,
    });
    expect(result?.run.phase).toBe("cancelled");
    expect(selected).toBe(false);
  });

  test("publication is the cancellation point of no return", async () => {
    const store = createInMemoryWorkflowSpineStore();
    const now = () => new Date("2026-07-14T00:03:00.000Z");
    await enqueue(store, now());
    const result = await processNextWorkflowRun({
      store,
      ports: ports({
        store,
        now,
        artifacts: [await artifact()],
        publish: async ({ fence, artifacts }) => {
          const run = await store.checkpoint(
            fence,
            { phase: "publishing", publishedArtifactIds: artifacts.map((entry) => entry.artifactId) },
            { event: "publish_started", at: now().toISOString() },
          );
          expect((await store.requestCancel(RUN, now())).accepted).toBe(false);
          return { outcome: "published", run, artifactIds: artifacts.map((entry) => entry.artifactId) };
        },
      }),
      ownerId: "worker-a",
      leaseMs: 60_000,
      now,
    });
    expect(result?.run.phase).toBe("published");
    expect(await store.committedCursor(ACTOR, WORKFLOW)).toBe("1");
  });

  test("restart reclaims an expired lease with a higher fence and rejects the zombie", async () => {
    const state = { runs: new Map<string, DurableWorkflowRun>(), cursors: new Map<string, string>() };
    const beforeRestart = createInMemoryWorkflowSpineStore(state);
    const started = new Date("2026-07-14T00:04:00.000Z");
    await enqueue(beforeRestart, started);
    const first = await beforeRestart.claimNext("worker-a", 1000, started);
    expect(first?.fence.fencingToken).toBe(1);

    const afterRestart = createInMemoryWorkflowSpineStore(state);
    const reclaimedAt = new Date("2026-07-14T00:04:02.000Z");
    const second = await afterRestart.claimNext("worker-b", 60_000, reclaimedAt);
    expect(second?.fence.fencingToken).toBe(2);
    await expect(
      afterRestart.checkpoint(first!.fence, { phase: "publishing" }, { event: "zombie", at: reclaimedAt.toISOString() }),
    ).rejects.toBeInstanceOf(StaleWorkflowFenceError);
  });

  test("renews its lease while a workflow stage is awaiting a provider", async () => {
    const store = createInMemoryWorkflowSpineStore();
    const wallStart = Date.now();
    const logicalStart = Date.parse("2026-07-14T00:04:30.000Z");
    const now = () => new Date(logicalStart + (Date.now() - wallStart));
    await enqueue(store, now());
    const configured = ports({
      store,
      now,
      execute: async () => {
        await Bun.sleep(80);
        return { artifacts: [] };
      },
    });
    const result = await processNextWorkflowRun({
      store,
      ports: configured,
      ownerId: "worker-a",
      leaseMs: 30,
      now,
    });
    expect(result?.run.phase).toBe("zero_artifacts");
  });

  test("rolls a crash after durable publish forward without rerunning or duplicating", async () => {
    const store = createInMemoryWorkflowSpineStore();
    let current = new Date("2026-07-14T00:05:00.000Z");
    const now = () => new Date(current);
    await enqueue(store, now());
    const publicationKeys = new Set<string>();
    let visiblePublishes = 0;
    let reconcileAttempts = 0;
    const artifactValue = await artifact();
    const sharedPorts = ports({
      store,
      now,
      artifacts: [artifactValue],
      publish: async ({ fence, publicationKey }) => {
        const run = await store.checkpoint(
          fence,
          { phase: "publishing", publicationKey, publishedArtifactIds: [artifactValue.artifactId] },
          { event: "publish_started", at: now().toISOString() },
        );
        if (!publicationKeys.has(publicationKey)) {
          publicationKeys.add(publicationKey);
          visiblePublishes += 1;
        }
        return { outcome: "published", run, artifactIds: [artifactValue.artifactId] };
      },
      reconcile: async ({ fence }) => {
        await store.assertCurrent(fence, now());
        reconcileAttempts += 1;
        if (reconcileAttempts === 1) throw new Error("temporary reconcile outage token=must-not-leak");
        return store.checkpoint(
          fence,
          { phase: "reconciling" },
          { event: "feed_reconciled", at: now().toISOString() },
        );
      },
    });

    await expect(processNextWorkflowRun({
      store,
      ports: sharedPorts,
      ownerId: "worker-a",
      leaseMs: 1000,
      now,
    })).rejects.toThrow("temporary reconcile outage");
    expect(await store.committedCursor(ACTOR, WORKFLOW)).toBeUndefined();

    current = new Date("2026-07-14T00:05:02.000Z");
    const second = await processNextWorkflowRun({
      store,
      ports: sharedPorts,
      ownerId: "worker-b",
      leaseMs: 60_000,
      now,
    });
    expect(second?.run.phase).toBe("published");
    expect(second?.run.attempt).toBe(2);
    expect(visiblePublishes).toBe(1);
    expect(await store.committedCursor(ACTOR, WORKFLOW)).toBe("1");
  });

  test("moves a poisoned run to a terminal dead letter after its bounded attempts", async () => {
    const store = createInMemoryWorkflowSpineStore();
    let current = new Date("2026-07-14T00:06:00.000Z");
    const now = () => new Date(current);
    await enqueue(store, now());
    const failing = ports({
      store,
      now,
      execute: async () => {
        throw new Error("provider unavailable");
      },
    });
    const first = await processNextWorkflowRun({
      store,
      ports: failing,
      ownerId: "worker-a",
      leaseMs: 60_000,
      now,
      retryDelayMs: () => 1000,
    });
    expect(first?.run.phase).toBe("retry_wait");

    current = new Date("2026-07-14T00:06:02.000Z");
    const second = await processNextWorkflowRun({
      store,
      ports: failing,
      ownerId: "worker-b",
      leaseMs: 60_000,
      now,
    });
    expect(second?.run.phase).toBe("dead_letter");
    expect(second?.run.attempt).toBe(2);
    expect(await store.committedCursor(ACTOR, WORKFLOW)).toBeUndefined();
  });
});
