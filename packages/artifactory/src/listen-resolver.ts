import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { SkillRunInput, TranscriptSourceRef } from "../../../skills/_shared/lib/feed-v1.ts";

const DEFAULT_LISTEN_HOST = "https://node.tinycloud.xyz";
const DEFAULT_NODE_SDK_DIST = resolve(
  import.meta.dir,
  "../../../repositories/js-sdk/packages/node-sdk/dist/index.js",
);
const LISTEN_CONVERSATIONS_DB = "xyz.tinycloud.listen/conversations";

export type ListenResolverAuth = {
  serializedDelegation: string;
  privateKeyPath?: string;
  privateKeyEnv?: string;
  host?: string;
};

export type ListenResolutionQuery = {
  conversationId?: string;
  conversationIds?: string[];
  mostRecent?: number;
  offset?: number;
};

export type ListenConversationRow = {
  id: string;
  title?: string;
  started_at?: string;
  transcript_json?: string | null;
  transcript_text?: string | null;
};

export type ListenTranscriptSegment = {
  index: number;
  speaker_id?: string;
  speaker_name?: string;
  text: string;
  raw_text?: string;
  start_time?: number;
  end_time?: number;
  ai_filters?: unknown;
};

export type ListenResolvedConversation = {
  conversationId: string;
  row: ListenConversationRow;
  transcript: ListenTranscriptSegment[];
  transcriptSource: "kv_transcript" | "sql_transcript_json" | "sql_transcript_text";
  sourceRef: TranscriptSourceRef;
};

export type ListenResolverDriver = {
  listRecent(limit: number, offset: number): Promise<ListenConversationRow[]>;
  loadMany(conversationIds: string[]): Promise<ListenConversationRow[]>;
  loadTranscript(conversationId: string): Promise<ListenTranscriptSegment[]>;
};

export type ListenResolverFactory = (
  auth: ListenResolverAuth,
) => Promise<ListenResolverDriver> | ListenResolverDriver;

export type ListenResolution = {
  auth: ListenResolverAuth;
  query: ListenResolutionQuery;
};

export type ListenResolutionResult = {
  conversations: ListenResolvedConversation[];
  sourcePack: SkillRunInput["sourcePack"];
};

type TinyCloudNodeSdk = {
  TinyCloudNode: new (options: {
    host: string;
    privateKey: string;
    autoCreateSpace?: boolean;
    prefix?: string;
  }) => {
    signIn(): Promise<void>;
    useDelegation(delegation: unknown): Promise<{
      sql: {
        db(name?: string): {
          query<T = Record<string, unknown>>(
            sql: string,
            params?: unknown[],
          ): Promise<{ ok: boolean; data?: { columns: string[]; rows: T[][]; rowCount: number }; error?: unknown }>;
        };
      };
      kv: {
        get<T = unknown>(
          key: string,
          options?: { raw?: boolean; binary?: boolean },
        ): Promise<{ ok: boolean; data?: { data: T }; error?: unknown }>;
      };
    }>;
  };
  deserializeDelegation(serialized: string): unknown;
};

export async function resolveListenResolution(
  resolution: ListenResolution,
  maxInputTokens: number,
  options: {
    driver?: ListenResolverDriver;
    loadSdk?: () => Promise<TinyCloudNodeSdk>;
    now?: () => Date;
  } = {},
): Promise<ListenResolutionResult> {
  const driver = options.driver ?? (await createListenResolverDriver(resolution.auth, options.loadSdk));
  const conversations = await resolveListenConversations(resolution.query, driver, options.now);
  return {
    conversations,
    sourcePack: buildSourcePackFromConversations(conversations, maxInputTokens),
  };
}

export async function resolveListenConversations(
  query: ListenResolutionQuery,
  driver: ListenResolverDriver,
  now: () => Date = () => new Date(),
): Promise<ListenResolvedConversation[]> {
  const rows = await selectConversationRows(query, driver);
  const resolved: ListenResolvedConversation[] = [];
  for (const row of rows) {
    const { transcript, source } = await resolveTranscript(row, driver);
    if (transcript.length === 0) continue;
    resolved.push({
      conversationId: row.id,
      row,
      transcript,
      transcriptSource: source,
      sourceRef: buildTranscriptSourceRef(row, transcript, source, now()),
    });
  }
  return resolved;
}

export function buildSourcePackFromConversations(
  conversations: ListenResolvedConversation[],
  maxInputTokens: number,
): SkillRunInput["sourcePack"] {
  const budget = normalizeTokenBudget(maxInputTokens);
  const refs: TranscriptSourceRef[] = [];
  const refIds = new Set<string>();
  const excerpts: SkillRunInput["sourcePack"]["excerpts"] = [];

  for (const conversation of conversations) {
    if (!refIds.has(conversation.sourceRef.sourceRefId)) {
      refs.push(conversation.sourceRef);
      refIds.add(conversation.sourceRef.sourceRefId);
    }

    const windows = windowTranscriptSegments(conversation.transcript, budget);
    for (const window of windows) {
      excerpts.push({
        sourceRefId: conversation.conversationId,
        text: window.text,
        quoteLineRefs: window.quoteLineRefs,
      });
    }
  }

  return { refs, excerpts, maxInputTokens: budget };
}

export async function createListenResolverDriver(
  auth: ListenResolverAuth,
  loadSdk: () => Promise<TinyCloudNodeSdk> = loadListenNodeSdk,
): Promise<ListenResolverDriver> {
  const sdk = await loadSdk();
  const privateKey = await readPrivateKey(auth);
  const node: any = new sdk.TinyCloudNode({
    host: auth.host?.trim() || DEFAULT_LISTEN_HOST,
    privateKey,
    autoCreateSpace: false,
  });
  await node.signIn();
  const delegation = sdk.deserializeDelegation(auth.serializedDelegation.trim());
  const access: any = await node.useDelegation(delegation);

  return {
    async listRecent(limit, offset) {
      const result = await access.sql.db(LISTEN_CONVERSATIONS_DB).query<unknown>(
        "SELECT id, title, started_at, transcript_json, transcript_text FROM conversation ORDER BY rowid DESC LIMIT ? OFFSET ?",
        [limit, offset],
      );
      return unwrapSqlRows(result, ["id", "title", "started_at", "transcript_json", "transcript_text"]);
    },
    async loadMany(conversationIds) {
      if (conversationIds.length === 0) return [];
      const placeholders = conversationIds.map(() => "?").join(", ");
      const result = await access.sql.db(LISTEN_CONVERSATIONS_DB).query<unknown>(
        `SELECT id, title, started_at, transcript_json, transcript_text FROM conversation WHERE id IN (${placeholders})`,
        conversationIds,
      );
      const rows = unwrapSqlRows(result, ["id", "title", "started_at", "transcript_json", "transcript_text"]);
      const byId = new Map(rows.map((row) => [row.id, row]));
      return conversationIds.map((id) => byId.get(id)).filter((row): row is ListenConversationRow => Boolean(row));
    },
    async loadTranscript(conversationId) {
      const result = await access.kv.get<string>(`transcript/${conversationId}`, { raw: true });
      if (!result.ok || !result.data) {
        return [];
      }
      return parseTranscriptSegments(result.data.data);
    },
  };
}

function normalizeTokenBudget(maxInputTokens: number): number {
  if (!Number.isFinite(maxInputTokens) || maxInputTokens <= 0) {
    throw new Error("maxInputTokens must be a positive number");
  }
  return Math.floor(maxInputTokens);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function segmentText(segment: ListenTranscriptSegment): string {
  const text = segment.text.trim() || (segment.raw_text ?? "").trim();
  return text;
}

function windowTranscriptSegments(
  segments: ListenTranscriptSegment[],
  maxInputTokens: number,
): { text: string; quoteLineRefs: string[] }[] {
  const windows: { text: string; quoteLineRefs: string[] }[] = [];
  let currentLines: string[] = [];
  let currentRefs: string[] = [];

  const flush = (): void => {
    if (currentLines.length === 0) return;
    windows.push({
      text: currentLines.join("\n"),
      quoteLineRefs: [...currentRefs],
    });
    currentLines = [];
    currentRefs = [];
  };

  for (const segment of segments) {
    const line = segmentText(segment);
    if (!line) continue;
    const candidateLines = currentLines.length > 0 ? [...currentLines, line] : [line];
    const candidateTokens = estimateTokens(candidateLines.join("\n"));
    if (currentLines.length > 0 && candidateTokens > maxInputTokens) {
      flush();
    }
    currentLines.push(line);
    currentRefs.push(String(segment.index));
    const currentTokens = estimateTokens(currentLines.join("\n"));
    if (currentTokens >= maxInputTokens) {
      flush();
    }
  }

  flush();
  return windows;
}

function buildTranscriptSourceRef(
  row: ListenConversationRow,
  transcript: ListenTranscriptSegment[],
  source: ListenResolvedConversation["transcriptSource"],
  observedAt: Date,
): TranscriptSourceRef {
  const observedPath =
    source === "kv_transcript"
      ? "kv_transcript"
      : source === "sql_transcript_json"
        ? "sql_transcript_json"
        : "sql_transcript_text";
  const observedHash =
    source === "kv_transcript"
      ? hashJson(transcript)
      : source === "sql_transcript_json"
        ? hashText(row.transcript_json ?? "")
        : hashText(row.transcript_text ?? "");

  return {
    sourceRefId: row.id,
    sourceKind: "listen_conversation",
    sourceId: row.id,
    observedPath,
    observedHash,
    observedAt: observedAt.toISOString(),
  };
}

async function resolveTranscript(
  row: ListenConversationRow,
  driver: ListenResolverDriver,
): Promise<{ transcript: ListenTranscriptSegment[]; source: ListenResolvedConversation["transcriptSource"] }> {
  const kvTranscript = await driver.loadTranscript(row.id);
  if (kvTranscript.length > 0) {
    return { transcript: kvTranscript, source: "kv_transcript" };
  }
  if (row.transcript_json?.trim()) {
    return { transcript: parseTranscriptSegments(row.transcript_json), source: "sql_transcript_json" };
  }
  if (row.transcript_text?.trim()) {
    return {
      transcript: [
        {
          index: 0,
          speaker_name: row.title?.trim() || "Transcript",
          text: row.transcript_text.trim(),
        },
      ],
      source: "sql_transcript_text",
    };
  }
  return { transcript: [], source: "sql_transcript_text" };
}

function parseTranscriptSegments(value: unknown): ListenTranscriptSegment[] {
  const parsed = typeof value === "string" ? parseJsonValue(value) : value;
  if (Array.isArray(parsed)) {
    return parsed.map((entry, index) => normalizeSegment(entry, index)).filter((segment): segment is ListenTranscriptSegment => Boolean(segment));
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    for (const key of ["turns", "segments", "utterances", "transcript"]) {
      const nested = record[key];
      if (!nested) continue;
      const segments = parseTranscriptSegments(nested);
      if (segments.length > 0) return segments;
    }
  }
  return [];
}

function normalizeSegment(value: unknown, fallbackIndex: number): ListenTranscriptSegment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const text =
    typeof record.text === "string"
      ? record.text
      : typeof record.content === "string"
        ? record.content
        : typeof record.raw_text === "string"
          ? record.raw_text
          : "";
  if (!text.trim()) return undefined;
  return {
    index:
      typeof record.index === "number"
        ? record.index
        : typeof record.idx === "number"
          ? record.idx
          : fallbackIndex,
    speaker_id:
      typeof record.speaker_id === "string"
        ? record.speaker_id
        : typeof record.speakerId === "string"
          ? record.speakerId
          : undefined,
    speaker_name:
      typeof record.speaker_name === "string"
        ? record.speaker_name
        : typeof record.speakerName === "string"
          ? record.speakerName
          : typeof record.speaker === "string"
            ? record.speaker
            : undefined,
    text,
    raw_text: typeof record.raw_text === "string" ? record.raw_text : undefined,
    start_time:
      typeof record.start_time === "number"
        ? record.start_time
        : typeof record.startTime === "number"
          ? record.startTime
          : undefined,
    end_time:
      typeof record.end_time === "number"
        ? record.end_time
        : typeof record.endTime === "number"
          ? record.endTime
          : undefined,
    ai_filters: record.ai_filters,
  };
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function hashText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function unwrapSqlRows(
  result: { ok: boolean; data?: { columns: string[]; rows: unknown[][] }; error?: unknown },
  columns: string[],
): ListenConversationRow[] {
  if (!result.ok || !result.data) {
    throw new Error(`Listen SQL query failed${result.error ? `: ${JSON.stringify(result.error)}` : ""}`);
  }
  return rowsToConversationRows(result.data.columns, result.data.rows, columns);
}

function rowsToConversationRows(
  actualColumns: string[],
  rows: unknown[][],
  preferredColumns: string[],
): ListenConversationRow[] {
  const indexes = new Map(preferredColumns.map((column) => [column, actualColumns.indexOf(column)]));
  const idIndex = indexes.get("id") ?? -1;
  if (idIndex < 0) {
    throw new Error(`Listen SQL query did not return an id column (columns: ${actualColumns.join(", ")})`);
  }
  return rows.map((row) => ({
    id: String(row[idIndex]),
    title: optionalString(row, indexes.get("title")),
    started_at: optionalString(row, indexes.get("started_at")),
    transcript_json: optionalString(row, indexes.get("transcript_json")),
    transcript_text: optionalString(row, indexes.get("transcript_text")),
  }));
}

function optionalString(row: unknown[], index: number | undefined): string | undefined {
  if (index === undefined || index < 0) return undefined;
  const value = row[index];
  if (value == null) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

async function selectConversationRows(
  query: ListenResolutionQuery,
  driver: ListenResolverDriver,
): Promise<ListenConversationRow[]> {
  if (Array.isArray(query.conversationIds) && query.conversationIds.length > 0) {
    return driver.loadMany(uniqueIds(query.conversationIds));
  }
  if (typeof query.conversationId === "string" && query.conversationId.trim()) {
    const rows = await driver.loadMany([query.conversationId.trim()]);
    if (rows.length === 0) {
      throw new Error(`Listen conversation not found: ${query.conversationId}`);
    }
    return rows;
  }
  if (typeof query.mostRecent === "number" && Number.isFinite(query.mostRecent) && query.mostRecent > 0) {
    return driver.listRecent(Math.floor(query.mostRecent), Math.max(0, Math.floor(query.offset ?? 0)));
  }
  throw new Error("Listen resolution requires conversationId, conversationIds, or mostRecent");
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}

async function loadPrivateKey(auth: ListenResolverAuth): Promise<string> {
  if (auth.privateKeyPath?.trim()) {
    return normalizePrivateKey(await readFile(auth.privateKeyPath, "utf8"), `privateKeyPath:${auth.privateKeyPath}`);
  }
  if (auth.privateKeyEnv?.trim()) {
    const envKey = auth.privateKeyEnv.trim();
    const value = process.env[envKey];
    if (!value) {
      throw new Error(`Listen resolver private key env var not set: ${envKey}`);
    }
    return normalizePrivateKey(value, `env:${envKey}`);
  }
  throw new Error("Listen resolver auth requires privateKeyPath or privateKeyEnv");
}

function normalizePrivateKey(raw: string, source: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Listen resolver private key is empty (${source})`);
  }
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { privateKey?: unknown; private_key?: unknown; key?: unknown };
    const candidate = [parsed.privateKey, parsed.private_key, parsed.key].find((value) => typeof value === "string" && value.trim().length > 0);
    if (typeof candidate === "string") return candidate.trim();
  } catch {
    // Fall through to the raw JSON string; some profile files may already hold the key directly.
  }
  return trimmed;
}

async function loadListenNodeSdk(): Promise<TinyCloudNodeSdk> {
  const override = process.env.NODE_SDK_DIST?.trim();
  const path = override || DEFAULT_NODE_SDK_DIST;
  if (!existsSync(path)) {
    throw new Error(
      `@tinycloud/node-sdk dist not found at ${path}. Build repositories/js-sdk or set NODE_SDK_DIST to a built dist/index.js.`,
    );
  }
  return (await import(pathToFileURL(path).href)) as TinyCloudNodeSdk;
}
