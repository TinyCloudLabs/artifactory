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
  executable?: string;
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
  attempt: number;
  feedback: string[];
  log: GenerationLog;
}) => DraftCard | Promise<DraftCard>;

export type CriticVerdict = {
  verdict: "pass" | "reject";
  feedback: string[];
  notes?: string;
};

export type CardCritic = (input: {
  transcripts: Transcript[];
  chunks: TranscriptChunk[];
  draft: DraftCard;
  deterministicIssues: string[];
  log: GenerationLog;
}) => CriticVerdict | Promise<CriticVerdict>;

export type ClaudeProcessRunner = (
  command: string[],
  stdin: string,
  operation: "generation" | "critic",
) => Promise<string>;

export type GenerationInput = {
  requestId: string;
  prompt: string | null;
  transcriptDirs: string[];
  model: string;
  generator: GeneratorKind;
  heroImageGenerator?: HeroImageGenerator;
  heroImageProcessor?: HeroImageProcessor;
  ffmpegPath?: string;
  draftGenerator?: DraftGenerator;
  critic?: CardCritic;
  criticProcessRunner?: ClaudeProcessRunner;
  additionalDraftIssues?: (draft: DraftCard) => string[];
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
export const MAX_HERO_DATA_URI_BYTES = 700 * 1024;
export const HERO_TARGET_DECODED_BYTES = 500 * 1024;
export const CARD_BODY_MIN_WORDS = 150;
export const CARD_BODY_MAX_WORDS = 300;
const MAX_QUALITY_ATTEMPTS = 2;
const MAX_DETAIL_CHARS = 300;

// A deterministic one-pixel WebP used by the no-spend stub generator. It is
// intentionally tiny while still exercising the required compressed-media
// plumbing without a provider call.
export const STUB_HERO_DATA_URI =
  "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";

export type HeroFailureReason =
  | "provider_error"
  | "image_processing_failed"
  | "invalid_image"
  | "media_too_large";

export class HeroGenerationError extends Error {
  readonly code: HeroFailureReason;
  readonly detail: string;

  constructor(
    readonly reason: HeroFailureReason,
    message: string,
    readonly retryable: boolean,
    detail = message,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HeroGenerationError";
    this.code = reason;
    this.detail = boundedDetail(detail);
  }
}

export class ArtifactQualityRejectedError extends Error {
  readonly code = "quality_rejected";
  readonly retryable = false;

  constructor(readonly issues: string[], readonly sourceTranscripts: string[]) {
    super("card quality floor rejected both generation attempts");
    this.name = "ArtifactQualityRejectedError";
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
  const sourcePaths = [...new Set(chunks.map((chunk) => chunk.transcript))];
  const promptedPaths = new Set(sourcePaths);
  const promptedTranscripts = usable.filter((transcript) => promptedPaths.has(transcript.path));
  const critic = input.critic ?? (input.generator === "stub"
    ? deterministicCritic
    : (criticInput: Parameters<CardCritic>[0]) => claudeCritic(criticInput, input.criticProcessRunner));
  let regenerationFeedback: string[] = [];

  for (let attempt = 1; attempt <= MAX_QUALITY_ATTEMPTS; attempt += 1) {
    const draft = input.draftGenerator
      ? await input.draftGenerator({
          transcripts: usable,
          chunks,
          prompt: input.prompt,
          model: input.model,
          attempt,
          feedback: regenerationFeedback,
          log,
        })
      : input.generator === "stub"
        ? stubDraft(usable, input.prompt)
        : await claudeDraft(chunks, input.prompt, input.model, regenerationFeedback, log);

    const assessment = assessDraft(draft, promptedTranscripts, sourcePaths, input, log);
    const criticVerdict = await critic({
      transcripts: promptedTranscripts,
      chunks,
      draft,
      deterministicIssues: assessment.issues,
      log,
    });
    const criticIssues = criticVerdict.verdict === "reject"
      ? (criticVerdict.feedback.length > 0 ? criticVerdict.feedback : ["the independent critic rejected grounding or editorial quality"])
      : [];
    const issues = [...new Set([...assessment.issues, ...criticIssues].map((issue) => boundedDetail(issue)).filter(Boolean))];
    log("critic_verdict", {
      attempt,
      verdict: criticVerdict.verdict,
      detail: `deterministic_issues=${assessment.issues.length}; critic_feedback=${criticIssues.length}`,
    }, issues.length === 0 ? "info" : "warn");

    if (issues.length === 0 && criticVerdict.verdict === "pass") {
      assessment.artifact.quality.critic_pass = true;
      assessment.artifact.quality.quotes_verified = true;
      assessment.artifact.quality.notes = [
        `feed-v1-worker request ${input.requestId}`,
        input.generator === "stub" ? "deterministic stub critic passed" : "independent Sonnet critic passed",
        draft.notes,
      ].filter(Boolean).join("; ");

      const validated = validateArtifact(assessment.artifact);
      if (!validated.ok) {
        throw new Error(`generated artifact failed validation: ${validated.errors.join("; ")}`);
      }

      if (input.generator === "stub") {
        validated.artifact.hero_image = STUB_HERO_DATA_URI;
        log("hero_image_generated", {
          provider: "stub",
          mimeType: "image/webp",
          decodedBytes: Buffer.from(STUB_HERO_DATA_URI.split(",", 2)[1]!, "base64").byteLength,
        });
      } else {
        // The finished-card floor is unconditional: a request cannot opt out
        // of its compressed hero and still publish an artifact.
        await attachHeroImage(validated.artifact, {
          requireHero: true,
          generate: input.heroImageGenerator ?? generateImage,
          process: input.heroImageProcessor ?? resizeHeroImage,
          ffmpegPath: input.ffmpegPath,
          log,
        });
      }
      assertCompressedHero(validated.artifact);

      const withHero = validateArtifact(validated.artifact);
      if (!withHero.ok) {
        throw new Error(`generated artifact with hero failed validation: ${withHero.errors.join("; ")}`);
      }
      return withHero.artifact;
    }

    log("card_quality_rejected", {
      attempt,
      issueCount: issues.length,
      detail: attempt < MAX_QUALITY_ATTEMPTS ? "regeneration_required" : "quality_attempts_exhausted",
    }, "warn");
    regenerationFeedback = issues;
  }

  throw new ArtifactQualityRejectedError(regenerationFeedback, sourcePaths);
}

export async function attachHeroImage(
  artifact: Artifact,
  options: {
    requireHero: boolean;
    generate?: HeroImageGenerator;
    process?: HeroImageProcessor;
    ffmpegPath?: string;
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
    let original: GeneratedImage;
    try {
      original = await generate({
        prompt: `${basePrompt} Return a clean 1K source image suitable for local downscaling and WebP compression.`,
        aspectRatio: "16:9",
        imageSize: "1K",
      });
    } catch (error) {
      throw normalizeProviderError(error);
    }
    assertValidProviderImage(original);

    const profiles = [
      { width: 768, quality: 82 },
      { width: 512, quality: 68 },
    ] as const;
    for (const [attempt, profile] of profiles.entries()) {
      // Both attempts transform the actual provider bytes. The smaller retry
      // changes pixel dimensions and encoder quality, not merely prompt copy.
      let image: GeneratedImage;
      try {
        image = await process({ image: original, ...profile, executable: options.ffmpegPath });
      } catch (error) {
        throw normalizeProcessingError(error);
      }
      assertValidProcessedImage(image);
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
          "media_too_large",
          "hero image remained over the worker transport budget after the smaller retry",
          true,
          `decoded_bytes=${image.bytes.byteLength}; encoded_bytes=${encodedBytes}; cap=${MAX_HERO_DATA_URI_BYTES}`,
        );
      }
    }
  } catch (error) {
    const typed = error instanceof HeroGenerationError ? error : normalizeProviderError(error);
    if (options.requireHero) {
      log("hero_image_required_failed", { reason: typed.reason, errorCode: typed.code, detail: typed.detail }, "error");
      throw typed;
    }
    delete artifact.hero_image;
    log("hero_image_degraded_text_only", { reason: typed.reason, errorCode: typed.code, detail: typed.detail }, "warn");
    return artifact;
  }
  return artifact;
}

function assertValidProviderImage(image: GeneratedImage): void {
  const mimeType = image && typeof image.mimeType === "string" ? image.mimeType : "missing";
  const decodedBytes = image?.bytes instanceof Uint8Array ? image.bytes.byteLength : 0;
  if (!hasImageSignature(mimeType, image?.bytes)) {
    throw new HeroGenerationError(
      "invalid_image",
      "hero image provider returned an invalid image payload",
      true,
      `mime_type=${boundedDetail(mimeType)}; decoded_bytes=${decodedBytes}`,
    );
  }
}

function assertValidProcessedImage(image: GeneratedImage): void {
  const mimeType = image && typeof image.mimeType === "string" ? image.mimeType : "missing";
  const decodedBytes = image?.bytes instanceof Uint8Array ? image.bytes.byteLength : 0;
  if (mimeType.toLowerCase() !== "image/webp" || !hasImageSignature(mimeType, image?.bytes)) {
    throw new HeroGenerationError(
      "image_processing_failed",
      "hero image processor did not return a nonempty WebP image",
      false,
      `mime_type=${boundedDetail(mimeType)}; decoded_bytes=${decodedBytes}`,
    );
  }
}

function hasImageSignature(mimeType: string, bytes: Uint8Array | undefined): boolean {
  if (!(bytes instanceof Uint8Array)) return false;
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return bytes.byteLength >= 8 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
    case "image/jpeg":
      return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/webp":
      return bytes.byteLength >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    default:
      return false;
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
  executable?: string;
}): Promise<GeneratedImage> {
  const executable = options.executable ?? Bun.which("ffmpeg");
  if (!executable) {
    throw new HeroGenerationError(
      "image_processing_failed",
      "ffmpeg is required to resize and compress worker hero images",
      false,
      "binary=ffmpeg; detail=not_found",
    );
  }
  let proc: Bun.Subprocess<Blob, "pipe", "pipe">;
  try {
    const imageBytes = new Uint8Array(options.image.bytes.byteLength);
    imageBytes.set(options.image.bytes);
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
      // A Blob-backed stdin lets Bun own the write. If the decoder exits
      // before reading, the failure is observed through the subprocess exit
      // code rather than an uncaught FileSink EPIPE.
      stdin: new Blob([imageBytes.buffer]),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new HeroGenerationError(
      "image_processing_failed",
      "hero image processor could not be started",
      false,
      `binary=${executable}; detail=${safeErrorMessage(error)}`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }

  const stdoutPromise = new Response(proc.stdout).arrayBuffer().catch(() => new ArrayBuffer(0));
  const stderrPromise = new Response(proc.stderr).arrayBuffer().catch(() => new ArrayBuffer(0));
  const [stdout, stderr, exitCode] = await Promise.all([
    stdoutPromise,
    stderrPromise,
    proc.exited.catch(() => -1),
  ]);
  if (exitCode !== 0 || stdout.byteLength === 0) {
    const stderrText = Buffer.from(stderr).toString("utf8");
    const stderrTail = stderrText.slice(-MAX_DETAIL_CHARS);
    throw new HeroGenerationError(
      "image_processing_failed",
      "hero image processor failed",
      false,
      stderrTail || `binary=${executable}; exit=${exitCode}`,
    );
  }
  return { bytes: new Uint8Array(stdout), mimeType: "image/webp" };
}

export async function preflightFfmpeg(executable: string): Promise<void> {
  const binaryPath = executable.trim();
  if (!binaryPath) throw new Error("ffmpeg preflight failed: binary path is empty");
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([binaryPath, "-version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new Error(`ffmpeg preflight failed for binary ${binaryPath}: ${safeErrorMessage(error)}`);
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text().catch(() => ""),
    new Response(proc.stderr).text().catch(() => ""),
    proc.exited.catch(() => -1),
  ]);
  if (exitCode !== 0) {
    const detail = boundedDetail((stderr || stdout).slice(-MAX_DETAIL_CHARS) || `exit=${exitCode}`);
    throw new Error(`ffmpeg preflight failed for binary ${binaryPath}: ${detail}`);
  }
}

function normalizeProviderError(error: unknown): HeroGenerationError {
  if (error instanceof HeroGenerationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const missingKey = /Secret\s+"GEMINI_API_KEY"\s+not found/i.test(message);
  return new HeroGenerationError(
    "provider_error",
    missingKey ? "required Gemini hero credential is not configured" : "Gemini hero generation failed",
    !missingKey,
    missingKey ? "provider credential is not configured" : safeErrorMessage(error),
    error instanceof Error ? { cause: error } : undefined,
  );
}

function normalizeProcessingError(error: unknown): HeroGenerationError {
  if (error instanceof HeroGenerationError) return error;
  return new HeroGenerationError(
    "image_processing_failed",
    "hero image processor failed",
    false,
    safeErrorMessage(error),
    error instanceof Error ? { cause: error } : undefined,
  );
}

type DraftAssessment = {
  artifact: Artifact;
  issues: string[];
};

function assessDraft(
  draft: DraftCard,
  transcripts: Transcript[],
  sourcePaths: string[],
  input: GenerationInput,
  log: GenerationLog,
): DraftAssessment {
  const byPath = new Map(transcripts.map((transcript) => [transcript.path, transcript]));
  const verifiedQuotes: SourceQuote[] = [];
  let dropped = 0;
  for (const quote of Array.isArray(draft.source_quotes) ? draft.source_quotes : []) {
    const exact = typeof quote.quote === "string" ? quote.quote.trim() : "";
    const transcript = byPath.get(quote.transcript) ?? transcripts.find((candidate) => exact !== "" && verifyQuote(candidate, exact));
    if (exact && transcript && verifyQuote(transcript, exact)) {
      verifiedQuotes.push({ ...quote, quote: exact, transcript: transcript.path });
    } else {
      dropped += 1;
      log("quote_dropped", { quoteDropped: true, detail: "source_quote_not_exact" }, "warn");
    }
  }

  // The card-face quote is independently published, so it must itself occur
  // verbatim in a prompted source. Keep the durable evidence copy in
  // source_quotes even when the draft omitted the duplicate there.
  let pullQuote = typeof draft.quote === "string" && draft.quote.trim() ? draft.quote.trim() : undefined;
  let attribution = typeof draft.attribution === "string" && draft.attribution.trim()
    ? draft.attribution.trim()
    : undefined;
  if (pullQuote) {
    const transcript = transcripts.find((candidate) => verifyQuote(candidate, pullQuote!));
    if (transcript) {
      if (!verifiedQuotes.some((quote) => quote.transcript === transcript.path && quote.quote === pullQuote)) {
        verifiedQuotes.push({ transcript: transcript.path, quote: pullQuote, speaker: attribution });
      }
    } else {
      pullQuote = undefined;
      attribution = undefined;
      dropped += 1;
      log("pull_quote_dropped", { quoteDropped: true, detail: "pull_quote_not_exact" }, "warn");
    }
  }

  const headline = typeof draft.headline === "string" ? draft.headline.trim() : "";
  const body = typeof draft.body === "string" ? draft.body.trim() : "";
  const tags = [...new Set((Array.isArray(draft.tags) ? draft.tags : [])
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean))];
  const bodyWords = markdownWordCount(body);
  const quotesVerified = verifiedQuotes.length > 0 && dropped === 0;
  const issues: string[] = [];
  if (headline.length < 8 || headline.length > 140 || /[\r\n]/.test(headline)) {
    issues.push("headline must be one sharp line between 8 and 140 characters");
  }
  if (bodyWords < CARD_BODY_MIN_WORDS || bodyWords > CARD_BODY_MAX_WORDS) {
    issues.push(`markdown body must contain ${CARD_BODY_MIN_WORDS}-${CARD_BODY_MAX_WORDS} words (received ${bodyWords})`);
  }
  if (!pullQuote) issues.push("card must include a nonempty pull quote copied exactly from a source");
  if (!attribution) issues.push("card pull quote must include a nonempty attribution");
  if (verifiedQuotes.length === 0) issues.push("card must include at least one deterministically verified exact source quote");
  if (dropped > 0) issues.push("every supplied source and pull quote must match the source text exactly");
  if (tags.length < 2 || tags.length > 5) issues.push("card must include 2-5 distinct nonempty tags");
  issues.push(...(input.additionalDraftIssues?.(draft) ?? []));

  return {
    artifact: {
      id: newArtifactId(),
      type: "insight-card",
      headline,
      body,
      quote: pullQuote,
      attribution,
      tags,
      // Provenance covers exactly the chunks placed in the model prompt. A
      // bounded Host batch may include unread sources beyond the corpus cap.
      source_transcripts: sourcePaths,
      source_quotes: verifiedQuotes,
      generated_at: new Date().toISOString(),
      generation_model: input.generator === "stub" ? "stub" : input.model,
      quality: {
        critic_pass: false,
        quotes_verified: quotesVerified,
        notes: `feed-v1-worker request ${input.requestId}; quality gate pending`,
      },
    },
    issues,
  };
}

export function markdownWordCount(markdown: string): number {
  const prose = markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<[^>]+>/g, " ");
  return prose.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function assertCompressedHero(artifact: Artifact): void {
  const hero = artifact.hero_image;
  if (!hero || !/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(hero)) {
    throw new HeroGenerationError(
      "image_processing_failed",
      "finished card is missing its required compressed WebP hero",
      false,
      "required WebP data URI was absent or malformed",
    );
  }
  const bytes = Uint8Array.from(Buffer.from(hero.split(",", 2)[1]!, "base64"));
  if (!hasImageSignature("image/webp", bytes)) {
    throw new HeroGenerationError(
      "image_processing_failed",
      "finished card hero is not a valid compressed WebP image",
      false,
      "required WebP signature was absent",
    );
  }
  const decodedBytes = bytes.byteLength;
  const encodedBytes = Buffer.byteLength(hero, "utf8");
  if (decodedBytes > HERO_TARGET_DECODED_BYTES || encodedBytes > MAX_HERO_DATA_URI_BYTES) {
    throw new HeroGenerationError(
      "media_too_large",
      "finished card hero exceeds the worker transport budget",
      true,
      `decoded_bytes=${decodedBytes}; encoded_bytes=${encodedBytes}; cap=${MAX_HERO_DATA_URI_BYTES}`,
    );
  }
}

function deterministicCritic(input: Parameters<CardCritic>[0]): CriticVerdict {
  return input.deterministicIssues.length === 0
    ? { verdict: "pass", feedback: [], notes: "deterministic no-spend critic" }
    : { verdict: "reject", feedback: input.deterministicIssues, notes: "deterministic no-spend critic" };
}

async function claudeCritic(
  input: Parameters<CardCritic>[0],
  processRunner: ClaudeProcessRunner = runClaudeSubprocess,
): Promise<CriticVerdict> {
  const corpus = input.chunks
    .map((chunk) => `--- transcript: ${chunk.transcript} (chunk ${chunk.index}) ---\n${chunk.text}`)
    .join("\n\n");
  const instructions = [
    "You are the independent editorial and grounding critic for one insight card.",
    "Reject the card if its main claims are not supported by the supplied transcript,",
    "if the angle is a bland summary, if the headline is not sharp, or if the writing",
    "is not useful and publication-ready. Deterministic floor findings are mandatory.",
    "Do not rewrite the card. Return only a compact JSON verdict.",
    "",
    `Deterministic floor findings: ${JSON.stringify(input.deterministicIssues)}`,
    `Candidate card: ${JSON.stringify(input.draft)}`,
    "",
    'Return: {"verdict":"pass"|"reject","feedback":["specific correction"],"notes":"short rationale"}',
    "",
    "Transcript chunks:",
    corpus,
  ].join("\n");

  input.log("critic_spawn", { model: "sonnet", promptChars: instructions.length });
  const output = await processRunner(criticCommand(), instructions, "critic");
  input.log("critic_done", { outputChars: output.length });
  return parseCriticVerdict(output);
}

export function criticCommand(): string[] {
  return claudeCommand("sonnet");
}

export function parseCriticVerdict(output: string): CriticVerdict {
  const parsed = parseJsonObject(output, "critic");
  if (parsed.verdict !== "pass" && parsed.verdict !== "reject") {
    throw new Error("critic output is missing a valid verdict");
  }
  const feedback = Array.isArray(parsed.feedback)
    ? parsed.feedback
        .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
        .slice(0, 8)
        .map((entry) => boundedDetail(entry))
    : [];
  return {
    verdict: parsed.verdict,
    feedback,
    notes: typeof parsed.notes === "string" ? boundedDetail(parsed.notes) : undefined,
  };
}

function boundedDetail(value: string): string {
  return value
    .replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]+/gi, "[redacted-image-bytes]")
    .replace(/(bearer|token|secret|key|password)[=:\s][^\s,;]*/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s?]+\?[^\s]*/gi, "[redacted-url]")
    .replace(/[A-Za-z0-9+/]{120,}={0,2}/g, "[redacted-bytes]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DETAIL_CHARS);
}

function safeErrorMessage(error: unknown): string {
  return boundedDetail(error instanceof Error ? error.message : String(error)) || "unknown failure";
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
  const body = [
    "## The operating decision",
    "",
    `The conversation around ${title} identifies a concrete operating constraint, not merely a theme for later discussion. The team is connecting a near-term implementation choice to the behavior of the system after usage grows, which makes the decision consequential now. The useful insight is that reliability work belongs at the boundary where work is accepted, because downstream cleanup cannot fully repair an intake path that has already lost control of demand.`,
    "",
    "That framing changes the practical next step. Instead of treating capacity controls as polish, the team can define the queue limit, ownership signal, and recovery behavior alongside the first production path. Doing so makes overload visible, gives operators a specific condition to diagnose, and keeps the published result tied to an explicit source observation. It also creates a measurable review point: the implementation either preserves bounded work and clear reconciliation, or it does not.",
    "",
    "The broader lesson is simple: a pipeline is trustworthy only when its failure behavior is designed with its successful path. This source provides a specific decision and rationale that can be checked again as the system evolves.",
  ].join("\n");
  return {
    headline: prompt && prompt.trim() !== "" ? `Insight: ${prompt.trim().slice(0, 96)}` : `Insight from ${title}`,
    body,
    quote: quote.slice(0, 280),
    attribution: anchor.speaker ?? "Source",
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
  feedback: string[],
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
    "- A nonempty card-face pull quote and attribution are required. The pull",
    "  quote must also be copied exactly from the transcript.",
    "",
    "Finished-card floor:",
    "- Write one sharp headline and a 150-300 word markdown body.",
    "- Supply 2-5 distinct, specific tags.",
    "- Ground the body in the supplied transcript instead of inventing context.",
    feedback.length > 0 ? `Regeneration feedback (fix every item): ${JSON.stringify(feedback)}` : "",
    "",
    prompt && prompt.trim() !== "" ? `The reader asked for: ${prompt.trim()}` : "",
    "",
    "Respond with ONLY a JSON object (no prose, no code fences) shaped as:",
    "{",
    '  "headline": "sharp one-line headline",',
    '  "body": "150-300 word markdown body",',
    '  "quote": "required exact pull quote",',
    '  "attribution": "required speaker name",',
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
  const stdout = await runClaudeSubprocess(claudeCommand(model), instructions, "generation");
  log("claude_done", { outputChars: stdout.length });
  return parseDraft(stdout);
}

export async function runClaudeSubprocess(
  command: string[],
  instructions: string,
  operation: "generation" | "critic",
): Promise<string> {
  let proc: Bun.Subprocess<Blob, "pipe", "pipe">;
  try {
    proc = Bun.spawn(command, {
      stdin: new Blob([instructions]),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new Error(`claude ${operation} subprocess could not start`, error instanceof Error ? { cause: error } : undefined);
  }
  // All transcript and candidate content travels through stdin. Omitting env
  // is deliberate: the process inherits only its configured provider auth.
  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");
  const [stdout, stderr, exitCode] = await Promise.all([
    stdoutPromise,
    stderrPromise,
    proc.exited.catch(() => -1),
  ]);
  // Provider stderr can echo prompt fragments. Consume it to avoid a blocked
  // pipe, but never include it in errors or run metadata.
  void stderr;
  if (exitCode !== 0) {
    throw new Error(`claude ${operation} failed (exit ${exitCode})`);
  }
  return stdout;
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
  const record = parseJsonObject(output, "generator");
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

function parseJsonObject(output: string, operation: "generator" | "critic"): Record<string, unknown> {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`${operation} output contained no JSON object`);
  }
  try {
    const parsed = JSON.parse(output.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${operation} output was not valid JSON`);
  }
}
