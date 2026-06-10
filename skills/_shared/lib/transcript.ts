// Transcript parsing for distillery skills.
//
// Source-agnostic input contract v1: skills consume plain transcript files
// (.md / .txt) from paths passed at invocation time. Nothing here knows
// about any particular machine, folder layout, or backend. A future
// Listen-backed source (transcript multiplexer in TinyCloud) slots in as
// another producer of the same Transcript shape — see loadTranscripts.
//
// Formats handled:
//   A. Fireflies / Gemini-sync markdown:
//        # Title
//        **Date:** 2026-05-12
//        **Duration:** 2 min
//        **Participants:** a@x.com, b@y.com
//        ## Summary ...        (optional)
//        ## Action Items ...   (optional)
//        ## Transcript
//        **Speaker Name:**     (turn marker; may carry a (HH:MM[:SS]) stamp)
//        text...
//   B. Markdown with YAML frontmatter (--- title/date/source ---) over the
//      same speaker-turn body.
//   C. Bare diarized markdown (VoxTerm style): speaker turns with no header.
//   D. Plain text fallback: whole body becomes one unattributed turn.

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export interface TranscriptTurn {
  speaker?: string;
  /** Raw timestamp string as it appeared, e.g. "01:29:10" or "25:47". */
  timestamp?: string;
  text: string;
}

export interface Transcript {
  /** Absolute or as-given path of the source file ("" when parsed from a string). */
  path: string;
  title?: string;
  date?: string;
  source?: string;
  participants?: string[];
  duration?: string;
  /** Pre-written sections (Fireflies emits these); verbatim markdown. */
  summary?: string;
  actionItems?: string;
  turns: TranscriptTurn[];
  /** Full original file content, for exact-quote verification. */
  raw: string;
}

export interface TranscriptChunk {
  /** Path of the transcript this chunk came from. */
  transcript: string;
  index: number;
  speakers: string[];
  text: string;
}

const TRANSCRIPT_EXTENSIONS = new Set([".md", ".txt"]);

// "**Samuel Gbafa:**" / "**Samuel Gbafa (01:29:10):**" — bold speaker marker.
const BOLD_TURN_RE = /^\*\*([^*\n]+?)(?:\s*\((\d{1,2}:\d{2}(?::\d{2})?)\))?\s*:\s*\*\*\s*(.*)$/;
// "Samuel Gbafa: hey" / "[00:12] Samuel: hey" / "Speaker 2: hey" — plain
// diarized marker. The label must look like a NAME, not prose: at most 3
// words, the first capitalized, the rest capitalized or numeric (diarizers
// emit "Speaker 1"). Apostrophes (O'Brien), hyphens (Mary-Jane), and
// periods (Dr.) are allowed inside words. This deliberately rejects prose
// lines containing a colon — "Same root cause: deploys flush the cache."
// must stay attached to the preceding turn, not become a phantom speaker.
const NAME_WORD = String.raw`[A-Z][\w.'’-]*`;
const PLAIN_TURN_RE = new RegExp(
  String.raw`^(?:\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*)?(${NAME_WORD}(?:\s+(?:${NAME_WORD}|\d+)){0,2}):\s+(.*)$`,
);
// "**Date:** 2026-05-12" — header metadata line.
const META_LINE_RE = /^\*\*([A-Za-z ]+):\*\*\s*(.*)$/;

export function parseTranscript(raw: string, path = ""): Transcript {
  const t: Transcript = { path, turns: [], raw };
  let body = raw;

  // YAML frontmatter (simple key: value pairs only — enough for
  // title/date/source; we deliberately don't pull in a YAML parser).
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (fm?.[1] !== undefined) {
    for (const line of fm[1].split("\n")) {
      const m = /^([A-Za-z_ -]+):\s*(.*)$/.exec(line);
      if (!m || m[1] === undefined || m[2] === undefined) continue;
      applyMeta(t, m[1], stripQuotes(m[2]));
    }
    body = body.slice(fm[0].length);
  }

  const lines = body.split("\n");
  let section = ""; // current "## Heading" (lowercased), "" = preamble
  const sectionText: Record<string, string[]> = {};
  const turnLines: { speaker?: string; timestamp?: string; lines: string[] }[] = [];
  let sawTranscriptHeading = false;
  let sawBoldTurn = false;

  const inTurnRegion = () =>
    !sawTranscriptHeading || section === "transcript";

  for (const line of lines) {
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1?.[1] !== undefined && t.title === undefined) {
      t.title = h1[1].trim();
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2?.[1] !== undefined) {
      section = h2[1].trim().toLowerCase();
      if (section === "transcript") sawTranscriptHeading = true;
      continue;
    }

    const meta = META_LINE_RE.exec(line);
    if (meta?.[1] !== undefined && section === "" && turnLines.length === 0) {
      // Header metadata only counts before any speaker turns; after that,
      // **Name:** lines are turn markers.
      const looksLikeMeta = applyMeta(t, meta[1], meta[2] ?? "");
      if (looksLikeMeta) continue;
    }

    if (inTurnRegion()) {
      const bold = BOLD_TURN_RE.exec(line);
      if (bold?.[1] !== undefined) {
        sawBoldTurn = true;
        turnLines.push({
          speaker: bold[1].trim(),
          timestamp: bold[2],
          lines: bold[3] ? [bold[3]] : [],
        });
        continue;
      }
      // Format dominance: files that mark turns in bold (Fireflies /
      // Gemini-sync) never mix in plain "Name: text" markers, so once a
      // bold turn has been seen, a name-like colon line ("Plan B: ship
      // Friday.") is prose inside the current turn, not a speaker change.
      const plain = sawBoldTurn ? null : PLAIN_TURN_RE.exec(line);
      if (plain?.[2] !== undefined && plain[3] !== undefined) {
        turnLines.push({
          speaker: plain[2].trim(),
          timestamp: plain[1],
          lines: [plain[3]],
        });
        continue;
      }
      if (turnLines.length > 0) {
        turnLines[turnLines.length - 1]!.lines.push(line);
        continue;
      }
    }

    (sectionText[section] ??= []).push(line);
  }

  if (sectionText["summary"]) t.summary = sectionText["summary"].join("\n").trim() || undefined;
  if (sectionText["action items"])
    t.actionItems = sectionText["action items"].join("\n").trim() || undefined;

  for (const tl of turnLines) {
    const text = tl.lines.join("\n").trim();
    if (!text) continue;
    t.turns.push({ speaker: tl.speaker, timestamp: tl.timestamp, text });
  }

  // Plain-text fallback: no speaker structure found → one unattributed turn.
  if (t.turns.length === 0) {
    const fallback = (sectionText[""] ?? []).join("\n").trim() || body.trim();
    if (fallback) t.turns.push({ text: fallback });
  }

  return t;
}

function applyMeta(t: Transcript, key: string, value: string): boolean {
  const v = value.trim();
  switch (key.trim().toLowerCase()) {
    case "title":
      t.title ??= v || undefined;
      return true;
    case "date":
      t.date = v || undefined;
      return true;
    case "source":
      t.source = v || undefined;
      return true;
    case "duration":
      t.duration = v || undefined;
      return true;
    case "participants":
      t.participants = v ? v.split(",").map((p) => p.trim()).filter(Boolean) : undefined;
      return true;
    default:
      return false;
  }
}

function stripQuotes(s: string): string {
  const t = s.trim();
  return /^".*"$/.test(t) || /^'.*'$/.test(t) ? t.slice(1, -1) : t;
}

/**
 * Best-available duration string for a transcript. Fireflies sometimes emits
 * a broken "**Duration:** 0 min" header even for hour-long meetings, so when
 * the parsed turns carry timestamps we compute the span from the first to the
 * last stamped turn and trust THAT; the header value is only a fallback.
 * Returns e.g. "62 min" (rounded, min 1), or the header string, or undefined.
 *
 * Timestamp convention: "HH:MM:SS" or "MM:SS" (two-part stamps are
 * minutes:seconds, matching Fireflies/diarizer output).
 */
export function transcriptDuration(transcript: Transcript): string | undefined {
  const stamps = transcript.turns
    .map((turn) => turn.timestamp)
    .filter((s): s is string => s !== undefined)
    .map(timestampToSeconds)
    .filter((s): s is number => s !== undefined);
  if (stamps.length >= 2) {
    const span = stamps[stamps.length - 1]! - stamps[0]!;
    if (span > 0) return `${Math.max(1, Math.round(span / 60))} min`;
  }
  return transcript.duration;
}

function timestampToSeconds(stamp: string): number | undefined {
  const parts = stamp.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return undefined;
}

/**
 * Load transcripts from a mix of file and directory paths (directories are
 * walked recursively; only .md/.txt files are picked up). This is the v1
 * input boundary: a future Listen adapter replaces "paths on disk" with
 * "transcripts from TinyCloud" by producing the same Transcript[].
 */
export async function loadTranscripts(paths: string[]): Promise<Transcript[]> {
  const files: string[] = [];
  for (const p of paths) {
    await collectFiles(p, files);
  }
  files.sort();
  const out: Transcript[] = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    out.push(parseTranscript(raw, file));
  }
  return out;
}

async function collectFiles(path: string, into: string[]): Promise<void> {
  const info = await stat(path); // throws ENOENT for bad paths — let it surface
  if (info.isDirectory()) {
    const entries = await readdir(path);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      await collectFiles(join(path, entry), into);
    }
    return;
  }
  if (TRANSCRIPT_EXTENSIONS.has(extname(path).toLowerCase())) into.push(path);
}

/**
 * Group consecutive turns into chunks of at most maxChars (one oversize turn
 * still becomes its own chunk). Deterministic plumbing for skills that hand
 * chunks to an agent for judgment.
 */
export function chunkTranscript(
  transcript: Transcript,
  maxChars = 8000,
): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let buf: string[] = [];
  let speakers = new Set<string>();
  let size = 0;

  const flush = () => {
    if (buf.length === 0) return;
    chunks.push({
      transcript: transcript.path || basename(transcript.path || "") || "(in-memory)",
      index: chunks.length,
      speakers: [...speakers],
      text: buf.join("\n\n"),
    });
    buf = [];
    speakers = new Set();
    size = 0;
  };

  for (const turn of transcript.turns) {
    const rendered = turn.speaker
      ? `${turn.speaker}${turn.timestamp ? ` (${turn.timestamp})` : ""}: ${turn.text}`
      : turn.text;
    if (size > 0 && size + rendered.length > maxChars) flush();
    buf.push(rendered);
    if (turn.speaker) speakers.add(turn.speaker);
    size += rendered.length + 2;
  }
  flush();
  return chunks;
}

/**
 * Verify a quote appears in a transcript, whitespace-insensitively.
 * The quality loop's deterministic half: agents propose quotes, this proves
 * they exist verbatim in the source.
 *
 * Matches against parsed speaker-segment text when segments exist — NOT the
 * raw file, which can carry AI-generated Summary / Action Items headers
 * (Fireflies) that were never actually spoken. Only the plain-text fallback
 * (no speaker structure found) verifies against the raw content.
 */
export function verifyQuote(transcript: Transcript, quote: string): boolean {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const needle = normalize(quote);
  if (!needle) return false;
  const hasSegments = transcript.turns.some((turn) => turn.speaker !== undefined);
  const haystack = hasSegments
    ? transcript.turns.map((turn) => turn.text).join("\n")
    : transcript.raw;
  return normalize(haystack).includes(needle);
}

export interface QuoteTurnMatch {
  /** Index into transcript.turns of the first matching turn. */
  index: number;
  turn: TranscriptTurn;
}

/**
 * Locate the first speaker turn whose text contains the quote, using the
 * same whitespace-insensitive matching as verifyQuote. Returns null when no
 * single turn contains it. A quote can still pass verifyQuote while this
 * returns null when it spans adjacent turns — callers should treat
 * (verifyQuote=true, findQuoteTurn=null) as "present, but spans turns".
 *
 * Note: a turn match proves the words were spoken, not who spoke them —
 * diarization speaker labels can be wrong.
 */
export function findQuoteTurn(transcript: Transcript, quote: string): QuoteTurnMatch | null {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const needle = normalize(quote);
  if (!needle) return null;
  for (const [index, turn] of transcript.turns.entries()) {
    if (normalize(turn.text).includes(needle)) return { index, turn };
  }
  return null;
}
