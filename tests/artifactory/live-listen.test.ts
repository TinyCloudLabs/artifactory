import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  buildSourcePackFromConversations,
  type ListenConversationRow,
  type ListenResolvedConversation,
  type ListenTranscriptSegment,
} from "../../packages/artifactory/src/listen-resolver.ts";

const runFile = promisify(execFile);
const LIVE_Tc = resolve(process.cwd(), "../../repositories/feed/node_modules/.bin/tc");
const LIVE_LISTEN_SPACE = "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:applications";

async function runTc(args: string[]): Promise<unknown> {
  const { stdout } = await runFile(LIVE_Tc, ["--json", "--quiet", "--profile", "feed-listen-delegate", ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim()) as unknown;
}

const liveDescribe = process.env.ARTIFACTORY_LIVE_LISTEN === "1" ? describe : describe.skip;

liveDescribe("live Listen transcript windowing", () => {
  test("resolves one real conversation and produces a non-empty sourcePack", async () => {
    const conversationQuery = (await runTc([
      "sql",
      "query",
      "SELECT id FROM conversation ORDER BY rowid DESC",
      "--db",
      "xyz.tinycloud.listen/conversations",
      "--space",
      LIVE_LISTEN_SPACE,
    ])) as { columns: string[]; rows: unknown[][]; rowCount: number };

    const transcriptListing = (await runTc([
      "kv",
      "list",
      "--prefix",
      "xyz.tinycloud.listen/transcript/",
      "--space",
      LIVE_LISTEN_SPACE,
    ])) as { keys: string[] };

    const transcriptKeys = new Set(
      transcriptListing.keys.map((key) => key.split("/").pop() ?? "").filter((key) => Boolean(key)),
    );
    const conversationRow = conversationQuery.rows.find((row) => {
      const id = String(row[0] ?? "");
      return transcriptKeys.has(id);
    });
    const conversationId = String(conversationRow?.[0] ?? "");
    expect(conversationId).not.toEqual("");

    const transcriptKey = `xyz.tinycloud.listen/transcript/${conversationId}`;

    const transcriptRaw = await runTc([
      "kv",
      "get",
      transcriptKey,
      "--raw",
      "--space",
      LIVE_LISTEN_SPACE,
    ]);
    const transcript = normalizeSegments(transcriptRaw);
    expect(transcript.length).toBeGreaterThan(0);

    const resolved: ListenResolvedConversation = {
      conversationId,
      row: { id: conversationId } satisfies ListenConversationRow,
      transcript,
      transcriptSource: "kv_transcript",
      sourceRef: {
        sourceRefId: conversationId,
        sourceKind: "listen_conversation",
        sourceId: conversationId,
        observedPath: "kv_transcript",
        observedHash: "sha256:live-check",
        observedAt: "2026-07-02T00:00:00.000Z",
      },
    };

    const sourcePack = buildSourcePackFromConversations([resolved], 64);
    const excerptChars = sourcePack.excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0);

    expect(sourcePack.refs).toHaveLength(1);
    expect(sourcePack.excerpts.length).toBeGreaterThan(0);
    expect(sourcePack.excerpts[0]?.quoteLineRefs.length).toBeGreaterThan(0);
    expect(excerptChars).toBeGreaterThan(0);
  }, 30000);
});

function normalizeSegments(value: unknown): ListenTranscriptSegment[] {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") return undefined;
      const record = entry as Record<string, unknown>;
      const text = typeof record.text === "string" ? record.text : typeof record.raw_text === "string" ? record.raw_text : "";
      if (!text.trim()) return undefined;
      return {
        index: typeof record.index === "number" ? record.index : index,
        speaker_name: typeof record.speaker_name === "string" ? record.speaker_name : undefined,
        speaker_id: typeof record.speaker_id === "string" ? record.speaker_id : undefined,
        text,
        raw_text: typeof record.raw_text === "string" ? record.raw_text : undefined,
      } satisfies ListenTranscriptSegment;
    })
    .filter((segment): segment is ListenTranscriptSegment => Boolean(segment));
}
