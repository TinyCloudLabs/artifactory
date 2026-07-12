import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFeedArtifact } from "../../skills/_shared/lib/feed-v1.ts";
import { generateInsightArtifact, parseDraft } from "./generate.ts";
import {
  FeedHostClient,
  LedgerWriter,
  processRequest,
  scrubErrorNote,
  type GenerationRequestWire,
  type WorkerConfig,
} from "./worker.ts";

const TRANSCRIPT = `# Weekly sync

Alice (00:01): We decided to move the artifact pipeline to the new Feed Host because the legacy path cannot enforce budgets atomically.
Bob (00:02): The interesting part is that nobody else has noticed the projection reconciliation cost grows with every artifact we publish.
Alice (00:03): Right, so the worker needs backpressure from day one or the queue will silently grow forever.
`;

type MockHostState = {
  requests: Map<string, { status: string }>;
  published: unknown[];
  statusCalls: Array<{ requestId: string; status: string; expectedStatus?: string }>;
};

function startMockHost(state: MockHostState) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/admin/dev/generation-requests") {
        const status = url.searchParams.get("status");
        const items = [...state.requests.entries()]
          .filter(([, row]) => status === null || row.status === status)
          .map(([requestId, row]) => ({
            requestId,
            status: row.status,
            prompt: "What changed this week?",
            scope: {},
            createdAt: "2026-07-10T22:00:00.000Z",
            expiresAt: "2026-07-11T22:00:00.000Z",
          }));
        return Response.json({ items });
      }
      const statusMatch = url.pathname.match(/^\/admin\/dev\/generation-requests\/([^/]+)\/status$/);
      if (request.method === "POST" && statusMatch) {
        const requestId = decodeURIComponent(statusMatch[1]!);
        const body = (await request.json()) as { status: string; expectedStatus?: string };
        const row = state.requests.get(requestId);
        if (!row) return Response.json({ error: { code: "not_found" } }, { status: 404 });
        if (body.expectedStatus !== undefined && row.status !== body.expectedStatus) {
          return Response.json({ error: { code: "status_conflict" } }, { status: 409 });
        }
        row.status = body.status;
        state.statusCalls.push({ requestId, status: body.status, expectedStatus: body.expectedStatus });
        return Response.json({ updated: true, request: { requestId, status: body.status } });
      }
      if (request.method === "POST" && url.pathname === "/admin/dev/publish-artifact") {
        const body = (await request.json()) as { artifact: { artifactId: string } };
        state.published.push(body.artifact);
        return Response.json({ accepted: true, artifactId: body.artifact.artifactId });
      }
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    },
  });
}

let cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function makeTranscriptDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "feed-v1-worker-test-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "transcripts"), { recursive: true });
  await writeFile(join(dir, "transcripts", "weekly-sync.md"), TRANSCRIPT);
  return dir;
}

function workerConfig(hostUrl: string, baseDir: string): WorkerConfig {
  return {
    hostUrl,
    insecureTls: false,
    transcriptDirs: [join(baseDir, "transcripts")],
    pollMs: 10,
    runsDir: join(baseDir, "runs"),
    model: "stub-model",
    generator: "stub",
    maxAttempts: 2,
    once: true,
  };
}

describe("feed-v1 worker", () => {
  test("stub generator produces a contract-valid artifact with verified quotes", async () => {
    const dir = await makeTranscriptDir();
    const artifact = await generateInsightArtifact({
      requestId: "req-gen-1",
      prompt: "What changed this week?",
      transcriptDirs: [join(dir, "transcripts")],
      model: "stub-model",
      generator: "stub",
    });
    expect(artifact.type).toBe("insight-card");
    expect(artifact.quality.quotes_verified).toBe(true);
    expect(artifact.source_quotes?.length).toBe(1);
    expect(artifact.source_transcripts.length).toBe(1);
  });

  test("processRequest claims, publishes a valid Feed v1 artifact, and consumes the request", async () => {
    const dir = await makeTranscriptDir();
    const state: MockHostState = {
      requests: new Map([["req-e2e-1", { status: "accepted" }]]),
      published: [],
      statusCalls: [],
    };
    const host = startMockHost(state);
    cleanup.push(() => host.stop(true));

    const config = workerConfig(`http://${host.hostname}:${host.port}`, dir);
    const client = new FeedHostClient(config);
    const ledger = new LedgerWriter(config.runsDir);
    const requests = await client.listAccepted();
    expect(requests).toHaveLength(1);

    const processed = await processRequest(requests[0]!, client, ledger, config);
    expect(processed).toBe(true);

    expect(state.requests.get("req-e2e-1")?.status).toBe("consumed");
    expect(state.statusCalls[0]).toMatchObject({ status: "pending", expectedStatus: "accepted" });
    expect(state.published).toHaveLength(1);
    const published = validateFeedArtifact(state.published[0]);
    expect(published.ok).toBe(true);
    if (published.ok) {
      expect(published.value.artifactType).toBe("insight_card");
      expect(published.value.producedBy.packageId).toBe("artifactory.extract-insights");
    }

    const ledgerRaw = JSON.parse(await readFile(join(config.runsDir, "req-e2e-1", "status.json"), "utf8")) as {
      state: string;
      artifactId?: string;
    };
    expect(ledgerRaw.state).toBe("done");
    expect(ledgerRaw.artifactId).toBeDefined();
  });

  test("processRequest rejects the request with a scrubbed note when generation cannot succeed", async () => {
    const dir = await makeTranscriptDir();
    await rm(join(dir, "transcripts", "weekly-sync.md"));
    const state: MockHostState = {
      requests: new Map([["req-fail-1", { status: "accepted" }]]),
      published: [],
      statusCalls: [],
    };
    const host = startMockHost(state);
    cleanup.push(() => host.stop(true));

    const config = workerConfig(`http://${host.hostname}:${host.port}`, dir);
    const client = new FeedHostClient(config);
    const ledger = new LedgerWriter(config.runsDir);
    const requests = await client.listAccepted();
    const processed = await processRequest(requests[0]!, client, ledger, config);
    expect(processed).toBe(true);
    expect(state.requests.get("req-fail-1")?.status).toBe("rejected");
    expect(state.published).toHaveLength(0);
  });

  test("skips a request another worker already claimed", async () => {
    const dir = await makeTranscriptDir();
    const state: MockHostState = {
      requests: new Map([["req-race-1", { status: "pending" }]]),
      published: [],
      statusCalls: [],
    };
    const host = startMockHost(state);
    cleanup.push(() => host.stop(true));

    const config = workerConfig(`http://${host.hostname}:${host.port}`, dir);
    const client = new FeedHostClient(config);
    const ledger = new LedgerWriter(config.runsDir);
    const processed = await processRequest(
      {
        requestId: "req-race-1",
        status: "accepted",
        prompt: null,
        scope: {},
        createdAt: "2026-07-10T22:00:00.000Z",
        expiresAt: "2026-07-11T22:00:00.000Z",
      } satisfies GenerationRequestWire,
      client,
      ledger,
      config,
    );
    expect(processed).toBe(false);
    expect(state.published).toHaveLength(0);
  });

  test("parseDraft extracts JSON from noisy model output and scrubErrorNote redacts secrets", () => {
    const draft = parseDraft('Here you go:\n{"headline": "H", "body": "B", "tags": ["x"], "source_quotes": []}\nthanks');
    expect(draft.headline).toBe("H");
    expect(() => parseDraft("no json here")).toThrow();
    const note = scrubErrorNote(new Error("publish failed: token=abc123 secret:hunter2 at row 5"));
    expect(note).not.toContain("abc123");
    expect(note).not.toContain("hunter2");
  });
});
