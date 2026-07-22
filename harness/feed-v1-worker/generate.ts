// Transcript → insight-card generation for the Feed v1 worker. Ports the
// extract-insights skill flow (parse/chunk → judgment → verify quotes →
// validate) into a single callable pipeline. The deterministic plumbing is
// reused from skills/_shared; the judgment step runs a headless `claude -p`
// (or a deterministic stub for tests and no-spend runs).

import { validateArtifact, newArtifactId, type Artifact, type SourceQuote } from "../../skills/_shared/lib/artifact.ts";
import { generateImage, type GeneratedImage } from "../../skills/_shared/lib/gemini.ts";
import {
  chunkTranscript,
  loadTranscripts,
  parseTranscript,
  verifyQuote,
  type Transcript,
  type TranscriptChunk,
} from "../../skills/_shared/lib/transcript.ts";

export type GeneratorKind = "claude" | "stub";
export type GenerationLogLevel = "info" | "warn" | "error";
export type GenerationLog = (
  message: string,
  fields?: Record<string, unknown>,
  level?: GenerationLogLevel,
) => void;
export type HeroImageGenerator = (options: {
  prompt: string;
  aspectRatio: string;
  imageSize: "1K";
}) => Promise<GeneratedImage>;
export type HeroImageProcessor = (options: {
  image: GeneratedImage;
  width: number;
  quality: number;
}) => Promise<GeneratedImage>;

export type GenerationSource = {
  sourceId: string;
  title: string;
  startedAt: string | null;
  transcript: string;
  transcriptSha256: string;
  truncated: boolean;
};

export type DraftGenerator = (input: {
  transcripts: Transcript[];
  chunks: TranscriptChunk[];
  prompt: string | null;
  model: string;
  log: GenerationLog;
}) => DraftCard | Promise<DraftCard>;

export type GenerationInput = {
  requestId: string;
  prompt: string | null;
  transcriptDirs: string[];
  model: string;
  generator: GeneratorKind;
  requireHero?: boolean;
  heroImageGenerator?: HeroImageGenerator;
  heroImageProcessor?: HeroImageProcessor;
  draftGenerator?: DraftGenerator;
  sources?: GenerationSource[];
  maxChunkChars?: number;
  maxCorpusChars?: number;
  log?: GenerationLog;
};

export type DraftCard = {
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
// The Host's one MiB limit covers the complete artifacts request, including
// JSON/base64 overhead. Keep the image itself comfortably below that boundary.
const MAX_HERO_DATA_URI_BYTES = 700 * 1024;
const HERO_TARGET_DECODED_BYTES = 500 * 1024;

// A deterministic transparent PNG used by the no-spend stub generator. It is
// intentionally tiny while still exercising the exact inline-data plumbing.
export const STUB_HERO_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export type HeroFailureReason =
  | "missing_key"
  | "provider_error"
  | "image_processing_failed"
  | "invalid_image"
  | "over_cap";

export class HeroGenerationError extends Error {
  readonly code = "hero_generation_failed";

  constructor(
    readonly reason: HeroFailureReason,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HeroGenerationError";
  }
}

export async function generateInsightArtifact(input: GenerationInput): Promise<Artifact> {
  const log = input.log ?? (() => {});
  const transcripts = input.sources === undefined
    ? await loadTranscripts(input.transcriptDirs)
    : input.sources.map((source) => {
        const transcript = parseTranscript(source.transcript, sourceTranscriptPath(source.sourceId));
        transcript.title = source.title || transcript.title;
        transcript.date = source.startedAt ?? transcript.date;
        transcript.source = "listen";
        return transcript;
      });
  const usable = transcripts.filter((transcript) => !transcript.empty && transcript.turns.length > 0);
  if (usable.length === 0) {
    throw new Error("no usable transcripts were supplied to the generation worker");
  }
  log("transcripts_loaded", { count: usable.length });

  const chunks = corpusChunks(usable, input.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS, input.maxCorpusChars ?? DEFAULT_MAX_CORPUS_CHARS);
  log("corpus_prepared", { chunks: chunks.length, chars: chunks.reduce((total, chunk) => total + chunk.text.length, 0) });

  const draft = input.draftGenerator
    ? await input.draftGenerator({ transcripts: usable, chunks, prompt: input.prompt, model: input.model, log })
    : input.generator === "stub"
      ? stubDraft(usable, input.prompt)
      : await claudeDraft(chunks, input.prompt, input.model, log);

  const sourcePaths = [...new Set(chunks.map((chunk) => chunk.transcript))];
  const promptedPaths = new Set(sourcePaths);
  const promptedTranscripts = usable.filter((transcript) => promptedPaths.has(transcript.path));
  const byPath = new Map(promptedTranscripts.map((transcript) => [transcript.path, transcript]));
  const verifiedQuotes: SourceQuote[] = [];
  let dropped = 0;
  for (const quote of draft.source_quotes) {
    const transcript = byPath.get(quote.transcript) ?? promptedTranscripts.find((candidate) => verifyQuote(candidate, quote.quote));
    if (transcript && verifyQuote(transcript, quote.quote)) {
      verifiedQuotes.push({ ...quote, transcript: transcript.path });
    } else {
      dropped += 1;
      log("quote_dropped", { quoteDropped: true });
    }
  }

  // The card-face pull quote is published independently from source_quotes,
  // so it must pass the same exact-text verifier. Fold a verified pull quote
  // into source_quotes for durable evidence; drop unverifiable copy instead
  // of publishing a fabricated or paraphrased quote.
  let pullQuote = draft.quote;
  let pullQuoteAttribution = draft.attribution;
  let pullQuoteVerified = pullQuote === undefined;
  if (pullQuote !== undefined) {
    const transcript = promptedTranscripts.find((candidate) => verifyQuote(candidate, pullQuote!));
    if (transcript) {
      pullQuoteVerified = true;
      if (!verifiedQuotes.some((quote) => quote.transcript === transcript.path && quote.quote === pullQuote)) {
        verifiedQuotes.push({ transcript: transcript.path, quote: pullQuote });
      }
    } else {
      pullQuote = undefined;
      pullQuoteAttribution = undefined;
      dropped += 1;
      log("pull_quote_dropped", { quoteDropped: true });
    }
  }
  const quotesVerified = verifiedQuotes.length > 0 && dropped === 0 && pullQuoteVerified;

  // Provenance covers exactly the transcript chunks placed in the model
  // prompt. A bounded Host batch may contain more sources than fit under the
  // corpus character cap; those unread sources must not be claimed.
  const artifact: Artifact = {
    id: newArtifactId(),
    type: "insight-card",
    headline: draft.headline,
    body: draft.body,
    quote: pullQuote,
    attribution: pullQuoteAttribution,
    tags: draft.tags.length > 0 ? draft.tags : ["insight"],
    source_transcripts: sourcePaths,
    source_quotes: verifiedQuotes,
    generated_at: new Date().toISOString(),
    generation_model: input.generator === "stub" ? "stub" : input.model,
    quality: {
      // Slice 3 has a real quote verifier but no critic. Never mint a critic
      // success badge for a gate that did not run.
      critic_pass: false,
      quotes_verified: quotesVerified,
      notes: [
        `feed-v1-worker request ${input.requestId}`,
        "critic not run",
        draft.notes,
        dropped > 0 ? `${dropped} unverifiable quote(s) dropped` : undefined,
      ]
        .filter(Boolean)
        .join("; "),
    },
  };

  const validated = validateArtifact(artifact);
  if (!validated.ok) {
    throw new Error(`generated artifact failed validation: ${validated.errors.join("; ")}`);
  }

  if (input.generator === "stub") {
    validated.artifact.hero_image = STUB_HERO_DATA_URI;
    log("hero_image_generated", {
      provider: "stub",
      mimeType: "image/png",
      decodedBytes: Buffer.from(STUB_HERO_DATA_URI.split(",", 2)[1]!, "base64").byteLength,
    });
  } else {
    await attachHeroImage(validated.artifact, {
      requireHero: input.requireHero ?? process.env.FEED_WORKER_REQUIRE_HERO !== "0",
      generate: input.heroImageGenerator ?? generateImage,
      process: input.heroImageProcessor ?? resizeHeroImage,
      log,
    });
  }

  const withHero = validateArtifact(validated.artifact);
  if (!withHero.ok) {
    throw new Error(`generated artifact with hero failed validation: ${withHero.errors.join("; ")}`);
  }
  return withHero.artifact;
}

export async function attachHeroImage(
  artifact: Artifact,
  options: {
    requireHero: boolean;
    generate?: HeroImageGenerator;
    process?: HeroImageProcessor;
    log?: GenerationLog;
  },
): Promise<Artifact> {
  const generate = options.generate ?? generateImage;
  const process = options.process ?? resizeHeroImage;
  const log = options.log ?? (() => {});
  const basePrompt = [
    `Editorial abstract hero image for: ${artifact.headline}.`,
    artifact.tags.length > 0 ? `Themes: ${artifact.tags.join(", ")}.` : "",
    "One-line art direction: editorial, abstract, no text or lettering in the image, dark-canvas friendly.",
    "Wide 16:9 composition with a clear focal point and restrained detail.",
  ].filter(Boolean).join(" ");

  try {
    const original = await generate({
      prompt: `${basePrompt} Return a clean 1K source image suitable for local downscaling and WebP compression.`,
      aspectRatio: "16:9",
      imageSize: "1K",
    });
    assertValidImage(original);

    const profiles = [
      { width: 768, quality: 82 },
      { width: 512, quality: 68 },
    ] as const;
    for (const [attempt, profile] of profiles.entries()) {
      // Both attempts transform the actual provider bytes. The smaller retry
      // changes pixel dimensions and encoder quality, not merely prompt copy.
      const image = await process({ image: original, ...profile });
      assertValidImage(image);
      const dataUri = `data:${image.mimeType.toLowerCase()};base64,${Buffer.from(image.bytes).toString("base64")}`;
      const encodedBytes = Buffer.byteLength(dataUri, "utf8");
      if (image.bytes.byteLength <= HERO_TARGET_DECODED_BYTES && encodedBytes <= MAX_HERO_DATA_URI_BYTES) {
        artifact.hero_image = dataUri;
        log("hero_image_generated", {
          provider: "gemini",
          attempt: attempt + 1,
          requestedWidth: profile.width,
          quality: profile.quality,
          mimeType: image.mimeType.toLowerCase(),
          decodedBytes: image.bytes.byteLength,
          encodedBytes,
          targetDecodedBytes: HERO_TARGET_DECODED_BYTES,
        });
        return artifact;
      }
      log("hero_image_oversize", {
        attempt: attempt + 1,
        requestedWidth: profile.width,
        quality: profile.quality,
        decodedBytes: image.bytes.byteLength,
        encodedBytes,
      }, attempt === 0 ? "warn" : "error");
      if (attempt === 1) {
        throw new HeroGenerationError(
          "over_cap",
          "hero image remained over the worker transport budget after the smaller retry",
          true,
        );
      }
    }
  } catch (error) {
    const typed = normalizeHeroError(error);
    if (options.requireHero) {
      log("hero_image_required_failed", { reason: typed.reason, errorCode: typed.code }, "error");
      throw typed;
    }
    delete artifact.hero_image;
    log("hero_image_degraded_text_only", { reason: typed.reason, errorCode: typed.code }, "warn");
    return artifact;
  }
  return artifact;
}

function assertValidImage(image: GeneratedImage): void {
  if (!/^image\/(png|jpeg|webp)$/i.test(image.mimeType) || image.bytes.byteLength === 0) {
    throw new HeroGenerationError("invalid_image", "hero image provider returned an invalid image payload", true);
  }
}

/**
 * Downscale and WebP-compress provider bytes without writing them to disk.
 * ffmpeg is part of the worker image/runtime contract documented beside the
 * harness. Stdin/stdout keep generated media out of run metadata.
 */
export async function resizeHeroImage(options: {
  image: GeneratedImage;
  width: number;
  quality: number;
}): Promise<GeneratedImage> {
  const executable = Bun.which("ffmpeg");
  if (!executable) {
    throw new HeroGenerationError(
      "image_processing_failed",
      "ffmpeg is required to resize and compress worker hero images",
      false,
    );
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([
      executable,
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-i",
      "pipe:0",
      "-vf",
      `scale=min(${options.width}\\,iw):-2`,
      "-frames:v",
      "1",
      "-c:v",
      "libwebp",
      "-quality",
      String(options.quality),
      "-compression_level",
      "6",
      "-f",
      "webp",
      "pipe:1",
    ], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(options.image.bytes);
    proc.stdin.end();
  } catch (error) {
    throw new HeroGenerationError(
      "image_processing_failed",
      "hero image processor could not be started",
      false,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  const [stdout, _stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).arrayBuffer(),
    proc.exited,
  ]);
  if (exitCode !== 0 || stdout.byteLength === 0) {
    throw new HeroGenerationError(
      "image_processing_failed",
      "hero image processor failed",
      false,
    );
  }
  return { bytes: new Uint8Array(stdout), mimeType: "image/webp" };
}

function normalizeHeroError(error: unknown): HeroGenerationError {
  if (error instanceof HeroGenerationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const missingKey = /Secret\s+"GEMINI_API_KEY"\s+not found/i.test(message);
  return new HeroGenerationError(
    missingKey ? "missing_key" : "provider_error",
    missingKey ? "required Gemini hero credential is not configured" : "Gemini hero generation failed",
    !missingKey,
    error instanceof Error ? { cause: error } : undefined,
  );
}

export function sourceTranscriptPath(sourceId: string): string {
  return `listen:${sourceId}`;
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
  log: GenerationLog,
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
  const proc = Bun.spawn(claudeCommand(model), {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Transcript content is sent only through stdin. Omitting `env` is
  // deliberate: containers authenticate claude through inherited provider
  // credentials (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN).
  proc.stdin.write(instructions);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    // Provider stderr can echo prompt fragments. Never place it in errors or
    // run metadata; consuming it above is only to avoid a blocked pipe.
    void stderr;
    throw new Error(`claude generation failed (exit ${exitCode})`);
  }
  log("claude_done", { outputChars: stdout.length });
  return parseDraft(stdout);
}

export function claudeCommand(model: string): string[] {
  return [
    "claude",
    "-p",
    "--model",
    model,
    "--tools",
    "",
    "--disallowedTools",
    "Bash Read Write Edit Glob Grep WebFetch WebSearch",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
  ];
}

export function parseDraft(output: string): DraftCard {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("generator output contained no JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    throw new Error("generator output was not valid JSON");
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
