import { describe, expect, test } from "bun:test";
import {
  buildSourcePackFromConversations,
  resolveListenConversations,
  resolveListenResolution,
  type ListenConversationRow,
  type ListenResolverDriver,
  type ListenResolvedConversation,
  type ListenTranscriptSegment,
} from "../../packages/artifactory/src/listen-resolver.ts";

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

    expect(sourcePack.refs).toHaveLength(1);
    expect(sourcePack.refs[0]?.sourceRefId).toBe("conversation-1");
    expect(sourcePack.excerpts).toHaveLength(2);
    expect(sourcePack.excerpts[0]).toEqual({
      sourceRefId: "conversation-1",
      text: "aaaa\nbbbb",
      quoteLineRefs: ["0", "1"],
    });
    expect(sourcePack.excerpts[1]).toEqual({
      sourceRefId: "conversation-1",
      text: "cccc",
      quoteLineRefs: ["2"],
    });
    expect(sourcePack.maxInputTokens).toBe(3);
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
