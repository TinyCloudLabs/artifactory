import { describe, expect, test } from "bun:test";
import { createFeedHostWorkflowBridge } from "../../packages/artifactory/src/workflow-spine-feed-host.ts";
import { StaleWorkflowFenceError } from "../../packages/artifactory/src/workflow-spine.ts";
import type { FeedArtifact } from "../../skills/_shared/lib/feed-v1.ts";

const TOKEN = "stage-3-worker-token-with-at-least-32-bytes";

describe("Feed Host workflow bridge", () => {
  test("uses one authenticated Host authority for claim, publish, reconcile, and cursor commit", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown>; authorization: string | null }> = [];
    const record = requestRecord();
    const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ path: url.pathname, body, authorization: new Headers(init?.headers).get("authorization") });
      const action = url.pathname.split("/").at(-1);
      if (action === "claim") {
        return Response.json({ request: record, committedCursor: "cursor-previous" });
      }
      if (action === "phase") {
        const patch = body.patch as Partial<typeof record>;
        Object.assign(record, patch, { updatedAt: "2026-07-14T02:00:01.000Z" });
      }
      if (action === "artifacts") {
        record.phase = "publishing";
        record.artifactIds = ["request-1:post-1"];
        return Response.json({ outcome: "published", request: record, artifactIds: record.artifactIds });
      }
      if (action === "reconcile") record.phase = "reconciling";
      if (action === "complete") {
        record.phase = String(body.outcome);
        record.artifactIds = body.artifactIds as string[];
      }
      return Response.json({ request: record });
    };
    const bridge = createFeedHostWorkflowBridge({
      baseUrl: "https://api.feed.example",
      token: TOKEN,
      actorId: "did:example:reader",
      workflowId: "workflow.insights",
      packageId: "package.insights",
      maxAttempts: 3,
      fetch: fetchMock,
    });

    const claim = await bridge.store.claimNext("worker-1", 60_000, new Date());
    expect(claim?.run.runId).toBe("request-1");
    expect(claim?.run.requestContext).toEqual({
      scope: { packageId: "package.insights", sourceRefId: "conversation-1" },
      prompt: "Compare the two options.",
    });
    expect(await bridge.store.committedCursor("did:example:reader", "workflow.insights")).toBe("cursor-previous");
    const fence = claim!.fence;
    await bridge.store.checkpoint(fence, {
      phase: "validating",
      publicationKey: "sha256:publication",
    }, { event: "publish_started", at: "2026-07-14T02:00:01.000Z" });
    const artifact = { artifactId: "request-1:post-1" } as FeedArtifact;
    expect(await bridge.publisher.publish({
      run: claim!.run,
      fence,
      publicationKey: "sha256:publication",
      artifacts: [artifact],
    })).toMatchObject({ outcome: "published", artifactIds: ["request-1:post-1"] });
    await bridge.feed.reconcile({ run: claim!.run, fence, artifactIds: [artifact.artifactId] });
    const complete = await bridge.store.complete(fence, {
      phase: "published",
      cursor: "cursor-next",
      publishedArtifactIds: [artifact.artifactId],
    }, new Date());

    expect(complete.phase).toBe("published");
    expect(calls.map((call) => call.path)).toEqual([
      "/api/worker/generation-requests/claim",
      "/api/worker/generation-requests/request-1/phase",
      "/api/worker/generation-requests/request-1/artifacts",
      "/api/worker/generation-requests/request-1/reconcile",
      "/api/worker/generation-requests/request-1/complete",
    ]);
    expect(calls.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls[0]?.body).not.toHaveProperty("runId");
    expect(calls.at(-1)?.body).toMatchObject({ cursor: "cursor-next", outcome: "published" });
  });

  test("maps a rejected Host fence to the workflow stale-fence error", async () => {
    const bridge = createFeedHostWorkflowBridge({
      baseUrl: "https://api.feed.example",
      token: TOKEN,
      actorId: "did:example:reader",
      workflowId: "workflow.insights",
      packageId: "package.insights",
      maxAttempts: 3,
      fetch: async () => Response.json({ error: { code: "generation_lease_conflict" } }, { status: 409 }),
    });
    await expect(bridge.store.assertCurrent({
      runId: "request-1",
      ownerId: "worker-1",
      fencingToken: 1,
    }, new Date())).rejects.toBeInstanceOf(StaleWorkflowFenceError);
  });
});

function requestRecord() {
  return {
    requestId: "request-1",
    actorId: "did:example:reader",
    status: "pending",
    packageId: "package.insights",
    scope: { packageId: "package.insights", sourceRefId: "conversation-1" },
    prompt: "Compare the two options.",
    runId: "request-1",
    workflowId: "workflow.insights",
    claimOwner: "worker-1",
    leaseExpiresAt: "2026-07-14T02:01:00.000Z",
    fencingToken: 1,
    attemptCount: 1,
    maxAttempts: 3,
    nextRetryAt: null,
    cancellationRequested: false,
    phase: "running",
    sourceCursorBefore: null,
    sourceCursorAfter: null,
    sourceRefs: [] as string[],
    publicationKey: null,
    artifactIds: [] as string[],
    error: null,
    timingEvents: [],
    createdAt: "2026-07-14T02:00:00.000Z",
    updatedAt: "2026-07-14T02:00:00.000Z",
  };
}
