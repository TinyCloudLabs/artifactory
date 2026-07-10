import { describe, expect, test } from "bun:test";
import {
  buildSourcePackFromConversations,
  createListenResolverDriver,
  resolveListenConversations,
  resolveListenResolution,
  type ListenConversationRow,
  type ListenResolverDriver,
  type ListenResolvedConversation,
  type ListenTranscriptSegment,
} from "../../packages/artifactory/src/listen-resolver.ts";

function makeResolvedConversation(id: string, text: string): ListenResolvedConversation {
  return {
    conversationId: id,
    row: { id },
    transcriptSource: "kv_transcript",
    sourceRef: {
      sourceRefId: id,
      sourceKind: "listen_conversation",
      sourceId: id,
      observedPath: "kv_transcript",
      observedHash: `sha256:${id}`,
      observedAt: "2026-07-02T00:00:00.000Z",
    },
    transcript: [{ index: 0, text }],
  };
}

function makeDriver(rows: ListenConversationRow[], transcripts: Record<string, ListenTranscriptSegment[]>): ListenResolverDriver {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  return {
    async listRecent(limit, offset) {
      return rows.slice(offset, offset + limit);
    },
    async loadMany(conversationIds) {
      return conversationIds.map((id) => rowById.get(id)).filter((row): row is ListenConversationRow => Boolean(row));
    },
    async loadTranscript(conversationId) {
      return transcripts[conversationId] ?? [];
    },
  };
}

describe("listen resolver", () => {
  test("unwraps a TinyCloud auth artifact before SDK deserialization", async () => {
    const envKey = "ARTIFACTORY_LISTEN_TEST_PRIVATE_KEY";
    const previousPrivateKey = process.env[envKey];
    process.env[envKey] = "0xfeed";
    const portableDelegation = {
      root: "bafy-test-root",
      actions: [{ can: "tinycloud/sql/read", with: "tinycloud://test" }],
    };
    let deserializedInput = "";

    class FakeTinyCloudNode {
      async signIn(): Promise<void> {}

      async useDelegation(): Promise<{
        sql: { db(): { query(): Promise<{ ok: boolean }> } };
        kv: { get(): Promise<{ ok: boolean }> };
      }> {
        return {
          sql: { db: () => ({ query: async () => ({ ok: true }) }) },
          kv: { get: async () => ({ ok: true }) },
        };
      }
    }

    try {
      await createListenResolverDriver(
        {
          privateKeyEnv: envKey,
          serializedDelegation: JSON.stringify({
            kind: "tinycloud.auth.delegation",
            version: 1,
            delegation: portableDelegation,
          }),
        },
        async () => ({
          TinyCloudNode: FakeTinyCloudNode,
          deserializeDelegation(serialized: string) {
            deserializedInput = serialized;
            return JSON.parse(serialized);
          },
        }),
      );
    } finally {
      if (previousPrivateKey === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = previousPrivateKey;
      }
    }

    expect(JSON.parse(deserializedInput)).toEqual(portableDelegation);
  });

  test("preserves explicit conversation order and resolves KV transcripts", async () => {
    const now = new Date("2026-07-02T00:00:00.000Z");
    const driver = makeDriver(
      [
        { id: "conversation-1" },
        { id: "conversation-2" },
      ],
      {
        "conversation-1": [{ index: 0, text: "alpha" }],
        "conversation-2": [{ index: 0, text: "bravo" }],
      },
    );

    const resolved = await resolveListenConversations(
      { conversationIds: ["conversation-2", "conversation-1"] },
      driver,
      () => now,
    );

    expect(resolved.map((conversation) => conversation.conversationId)).toEqual([
      "conversation-2",
      "conversation-1",
    ]);
    expect(resolved[0]?.transcriptSource).toBe("kv_transcript");
    expect(resolved[0]?.sourceRef.observedAt).toBe(now.toISOString());
  });

  test("windows transcript segments into excerpts under the token budget", () => {
    const conversation: ListenResolvedConversation = {
      conversationId: "conversation-1",
      row: { id: "conversation-1" },
      transcriptSource: "kv_transcript",
      sourceRef: {
        sourceRefId: "conversation-1",
        sourceKind: "listen_conversation",
        sourceId: "conversation-1",
        observedPath: "kv_transcript",
        observedHash: "sha256:test",
        observedAt: "2026-07-02T00:00:00.000Z",
      },
      transcript: [
        { index: 0, text: "aaaa" },
        { index: 1, text: "bbbb" },
        { index: 2, text: "cccc" },
      ],
    };

    const sourcePack = buildSourcePackFromConversations([conversation], 3);

    // The token budget is a hard cap on the TOTAL packed tokens: the first
    // window ("aaaa\nbbbb", 3 estimated tokens) exhausts the budget, so the
    // trailing "cccc" window is not packed.
    expect(sourcePack.refs).toHaveLength(1);
    expect(sourcePack.refs[0]?.sourceRefId).toBe("conversation-1");
    expect(sourcePack.excerpts).toHaveLength(1);
    expect(sourcePack.excerpts[0]).toEqual({
      sourceRefId: "conversation-1",
      text: "aaaa\nbbbb",
      quoteLineRefs: ["0", "1"],
    });
    expect(sourcePack.maxInputTokens).toBe(3);
  });

  test("enforces skillManifest.limits.maxSourceRefs as a hard cap on packed refs", () => {
    // Oversized fixture: 4 conversations against a declared cap of 2.
    const conversations = ["c-1", "c-2", "c-3", "c-4"].map((id) => makeResolvedConversation(id, "aaaaaaaa"));

    const sourcePack = buildSourcePackFromConversations(conversations, 100, {
      maxSourceRefs: 2,
      maxInputTokens: 100,
    });

    expect(sourcePack.refs.map((ref) => ref.sourceRefId)).toEqual(["c-1", "c-2"]);
    expect(sourcePack.excerpts.map((excerpt) => excerpt.sourceRefId)).toEqual(["c-1", "c-2"]);
  });

  test("enforces the declared token budget as a hard cap on total packed tokens", () => {
    // Each transcript is 8 chars ≈ 2 estimated tokens; a budget of 5 admits two
    // conversations (4 tokens) and hard-stops before the third.
    const conversations = ["c-1", "c-2", "c-3"].map((id) => makeResolvedConversation(id, "aaaaaaaa"));

    const sourcePack = buildSourcePackFromConversations(conversations, 100, {
      maxSourceRefs: 10,
      maxInputTokens: 5,
    });

    expect(sourcePack.maxInputTokens).toBe(5);
    expect(sourcePack.refs.map((ref) => ref.sourceRefId)).toEqual(["c-1", "c-2"]);
    expect(sourcePack.excerpts).toHaveLength(2);
    const totalTokens = sourcePack.excerpts.reduce(
      (sum, excerpt) => sum + Math.ceil(excerpt.text.length / 4),
      0,
    );
    expect(totalTokens).toBeLessThanOrEqual(5);
  });

  test("resolveListenResolution combines resolution and packing with injected fixtures", async () => {
    const now = new Date("2026-07-02T00:00:00.000Z");
    const driver = makeDriver(
      [{ id: "conversation-1" }],
      {
        "conversation-1": [
          { index: 0, text: "aaaa" },
          { index: 1, text: "bbbb" },
        ],
      },
    );

    const result = await resolveListenResolution(
      {
        auth: {
          privateKeyEnv: "ARTIFACTORY_LISTEN_PRIVATE_KEY",
          serializedDelegation: "delegation-fixture",
        },
        query: { conversationId: "conversation-1" },
      },
      3,
      { driver, now: () => now },
    );

    expect(result.conversations).toHaveLength(1);
    expect(result.sourcePack.excerpts).toHaveLength(1);
    expect(result.sourcePack.excerpts[0]?.quoteLineRefs).toEqual(["0", "1"]);
  });
});
