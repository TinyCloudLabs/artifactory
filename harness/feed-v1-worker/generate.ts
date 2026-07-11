// Transcript → insight-card generation for the Feed v1 worker. Ports the
// extract-insights skill flow (parse/chunk → judgment → verify quotes →
// validate) into a single callable pipeline. The deterministic plumbing is
// reused from skills/_shared; the judgment step runs a headless `claude -p`
// (or a deterministic stub for tests and no-spend runs).

import { validateArtifact, newArtifactId, type Artifact, type SourceQuote } from "../../skills/_shared/lib/artifact.ts";
import {
  chunkTranscript,
  loadTranscripts,
  verifyQuote,
  type Transcript,
  type TranscriptChunk,
} from "../../skills/_shared/lib/transcript.ts";

export type GeneratorKind = "claude" | "stub";

export type GenerationInput = {
  requestId: string;
  prompt: string | null;
  transcriptDirs: string[];
  model: string;
  generator: GeneratorKind;
  maxChunkChars?: number;
  maxCorpusChars?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
};

type DraftCard = {
  headline: string;
  body: string;
  quote?: string;
  attribution?: string;
  tags: string[];
  source_quotes: SourceQuote[];
  notes?: string;
};

const DEFAULT_MAX_CHUNK_CHARS = 8000;
const DEFAULT_MAX_CORPUS_CHARS = 20000;

export async function generateInsightArtifact(input: GenerationInput): Promise<Artifact> {
  const log = input.log ?? (() => {});
  const transcripts = await loadTranscripts(input.transcriptDirs);
  const usable = transcripts.filter((transcript) => !transcript.empty && transcript.turns.length > 0);
  if (usable.length === 0) {
    throw new Error(`no usable transcripts found under: ${input.transcriptDirs.join(", ")}`);
  }
  log("transcripts_loaded", { count: usable.length });

  const chunks = corpusChunks(usable, input.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS, input.maxCorpusChars ?? DEFAULT_MAX_CORPUS_CHARS);
  log("corpus_prepared", { chunks: chunks.length, chars: chunks.reduce((total, chunk) => total + chunk.text.length, 0) });

  const draft =
    input.generator === "stub"
      ? stubDraft(usable, input.prompt)
      : await claudeDraft(chunks, input.prompt, input.model, log);

  const byPath = new Map(usable.map((transcript) => [transcript.path, transcript]));
  const verifiedQuotes: SourceQuote[] = [];
  let dropped = 0;
  for (const quote of draft.source_quotes) {
    const transcript = byPath.get(quote.transcript) ?? usable.find((candidate) => verifyQuote(candidate, quote.quote));
    if (transcript && verifyQuote(transcript, quote.quote)) {
      verifiedQuotes.push({ ...quote, transcript: transcript.path });
    } else {
      dropped += 1;
      log("quote_dropped", { quote: quote.quote.slice(0, 80) });
    }
  }
  const quotesVerified = verifiedQuotes.length > 0 && dropped === 0;

  const sourcePaths = [...new Set(verifiedQuotes.map((quote) => quote.transcript))];
  const artifact: Artifact = {
    id: newArtifactId(),
    type: "insight-card",
    headline: draft.headline,
    body: draft.body,
    quote: draft.quote,
    attribution: draft.attribution,
    tags: draft.tags.length > 0 ? draft.tags : ["insight"],
    source_transcripts: sourcePaths.length > 0 ? sourcePaths : usable.map((transcript) => transcript.path),
    source_quotes: verifiedQuotes,
    generated_at: new Date().toISOString(),
    generation_model: input.generator === "stub" ? "stub" : input.model,
    quality: {
      critic_pass: true,
      quotes_verified: quotesVerified,
      notes: [
        `feed-v1-worker request ${input.requestId}`,
        draft.notes,
        dropped > 0 ? `${dropped} unverifiable quote(s) dropped` : undefined,
      ]
        .filter(Boolean)
        .join("; "),
    },
  };

  const result = validateArtifact(artifact);
  if (!result.ok) {
    throw new Error(`generated artifact failed validation: ${result.errors.join("; ")}`);
  }
  return result.artifact;
}

function corpusChunks(transcripts: Transcript[], maxChunkChars: number, maxCorpusChars: number): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let total = 0;
  for (const transcript of transcripts) {
    for (const chunk of chunkTranscript(transcript, maxChunkChars)) {
      if (total + chunk.text.length > maxCorpusChars && chunks.length > 0) return chunks;
      chunks.push(chunk);
      total += chunk.text.length;
    }
  }
  return chunks;
}

// Deterministic generator for tests / no-spend smoke runs: builds a card from
// the longest turn so the quote always verifies against the source.
function stubDraft(transcripts: Transcript[], prompt: string | null): DraftCard {
  const transcript = transcripts[0]!;
  const turns = transcript.turns.filter((turn) => turn.text.trim().length >= 40);
  const anchor = (turns.length > 0 ? turns : transcript.turns).reduce((longest, turn) =>
    turn.text.length > longest.text.length ? turn : longest,
  );
  const quote = anchor.text.trim();
  const title = transcript.title ?? transcript.path;
  return {
    headline: prompt && prompt.trim() !== "" ? `Insight: ${prompt.trim().slice(0, 96)}` : `Insight from ${title}`,
    body: `From ${title}: ${quote.slice(0, 280)}`,
    quote: quote.slice(0, 280),
    attribution: anchor.speaker,
    tags: ["insight", "stub"],
    source_quotes: [
      {
        transcript: transcript.path,
        quote,
        timestamp: anchor.timestamp,
      },
    ],
    notes: "stub generator (deterministic, no model call)",
  };
}

async function claudeDraft(
  chunks: TranscriptChunk[],
  prompt: string | null,
  model: string,
  log: (message: string, fields?: Record<string, unknown>) => void,
): Promise<DraftCard> {
  const corpus = chunks
    .map((chunk) => `--- transcript: ${chunk.transcript} (chunk ${chunk.index}) ---\n${chunk.text}`)
    .join("\n\n");
  const instructions = [
    "You are the judgment step of the extract-insights skill. Read the transcript",
    "chunks below and produce exactly ONE insight card as JSON.",
    "",
    "Selection rules (from SKILL.md):",
    "- Lead with something non-obvious: a decision with reasoning, a contrarian",
    "  take, a cross-transcript connection, or knowledge only one voice holds.",
    "- A plain summary of what was said is disqualified.",
    "- Never assert an inference about a person (role, employer, affiliation) as",
    "  fact; only state identities the transcript supports.",
    "",
    "Quote rules:",
    '- "source_quotes" must contain EXACT VERBATIM quotes copied from the',
    "  transcript text. Never paraphrase. Each quote's \"transcript\" field must",
    "  be the transcript path shown in the chunk header.",
    "",
    prompt && prompt.trim() !== "" ? `The reader asked for: ${prompt.trim()}` : "",
    "",
    "Respond with ONLY a JSON object (no prose, no code fences) shaped as:",
    "{",
    '  "headline": "sharp one-line headline",',
    '  "body": "short markdown body (2-4 sentences)",',
    '  "quote": "optional pull quote",',
    '  "attribution": "optional speaker name",',
    '  "tags": ["tag1", "tag2"],',
    '  "source_quotes": [{"transcript": "<path>", "quote": "<verbatim>", "timestamp": "<optional>"}],',
    '  "notes": "one line on why this is novel"',
    "}",
    "",
    "Transcript chunks:",
    corpus,
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  log("claude_spawn", { model, promptChars: instructions.length });
  const proc = Bun.spawn(["claude", "-p", instructions, "--model", model], {
    stdout: "pipe",
    stderr: "pipe",
    env: scrubbedEnv(),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`claude generation failed (exit ${exitCode}): ${stderr.slice(0, 300)}`);
  }
  log("claude_done", { outputChars: stdout.length });
  return parseDraft(stdout);
}

// The generation subprocess only needs a shell environment plus claude's own
// config from HOME; provider credentials and TinyCloud material stay out.
function scrubbedEnv(): Record<string, string> {
  const allowlist = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL", "TMPDIR"];
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

export function parseDraft(output: string): DraftCard {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`generator output contained no JSON object: ${output.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch (error) {
    throw new Error(`generator output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = parsed as Record<string, unknown>;
  const headline = typeof record.headline === "string" ? record.headline.trim() : "";
  const body = typeof record.body === "string" ? record.body.trim() : "";
  if (!headline || !body) {
    throw new Error("generator output is missing headline or body");
  }
  const sourceQuotes = Array.isArray(record.source_quotes)
    ? record.source_quotes
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        .filter((entry) => typeof entry.transcript === "string" && typeof entry.quote === "string")
        .map((entry) => ({
          transcript: entry.transcript as string,
          quote: entry.quote as string,
          timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
        }))
    : [];
  return {
    headline,
    body,
    quote: typeof record.quote === "string" && record.quote.trim() !== "" ? record.quote : undefined,
    attribution: typeof record.attribution === "string" && record.attribution.trim() !== "" ? record.attribution : undefined,
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : [],
    source_quotes: sourceQuotes,
    notes: typeof record.notes === "string" ? record.notes : undefined,
  };
}
