// banger.ts — deterministic helpers for the banger-extractor skill.
//
// The whole skill compresses one or more meeting transcripts into the SINGLE
// most non-obvious EARNED SECRET actually said, turned into ONE postable line
// (a "social-post" artifact for X). Everything here is plumbing: surveying the
// material, running the two deterministic checks (leak-safety flags + AI-slop
// tells) over a candidate line, quote verification, and persistence.
//
// THE JUDGMENT — which line is the banger, climbing the abstraction ladder,
// deciding "zero bangers" — belongs to the agent reading SKILL.md. No script in
// this skill calls a model. (Same boundary as extract-insights / write-article.)
//
// Cardinal rule carried straight from the contract: a banger is an OUTWARD type
// (social-post). It saves with approval_status "pending" — NEVER post-ready
// without a human at the approval gate. saveBanger refuses to persist anything
// pre-approved.

import { readFile } from "node:fs/promises";
import {
  chunkTranscript,
  parseTranscript,
  verifyQuote,
  type Transcript,
  type TranscriptChunk,
} from "../../_shared/lib/transcript.ts";
import {
  newArtifactId,
  validateArtifact,
  writeArtifact,
  type SourceQuote,
  type WrittenArtifact,
} from "../../_shared/lib/artifact.ts";
import { safetyFlags, type SafetyFlagResult } from "../../_shared/lib/abstraction.ts";
import { scrubSlop, type SlopReport } from "../../_shared/lib/slop-scrubber.ts";

// ---------------------------------------------------------------------------
// Survey — what the agent reads before picking the one line
// ---------------------------------------------------------------------------

export interface SpeakerStat {
  speaker: string;
  turns: number;
}

export interface BangerSurveyTranscript {
  path: string;
  title?: string;
  date?: string;
  participants?: string[];
  summary?: string;
  turnCount: number;
  speakers: SpeakerStat[];
}

export interface BangerSurvey {
  mode: "single" | "collection";
  transcriptCount: number;
  transcripts: BangerSurveyTranscript[];
  chunks: TranscriptChunk[];
}

/**
 * Build the survey the agent reads before choosing the one line. Deterministic:
 * same transcripts in, same survey out. Intentionally lean — the banger lives
 * in the chunk TEXT (verbatim turns), which is why every chunk is included;
 * speaker stats are a hint for "who holds the non-obvious view".
 */
export function buildBangerSurvey(
  transcripts: Transcript[],
  maxChunk = 8000,
): BangerSurvey {
  const surveyTranscripts: BangerSurveyTranscript[] = transcripts.map((t) => {
    const turnsBySpeaker = new Map<string, number>();
    for (const turn of t.turns) {
      if (!turn.speaker) continue;
      turnsBySpeaker.set(turn.speaker, (turnsBySpeaker.get(turn.speaker) ?? 0) + 1);
    }
    const speakers = [...turnsBySpeaker.entries()]
      .map(([speaker, turns]) => ({ speaker, turns }))
      .sort((a, b) => b.turns - a.turns || a.speaker.localeCompare(b.speaker));
    return {
      path: t.path,
      title: t.title,
      date: t.date,
      participants: t.participants,
      summary: t.summary,
      turnCount: t.turns.length,
      speakers,
    };
  });

  return {
    mode: transcripts.length >= 2 ? "collection" : "single",
    transcriptCount: transcripts.length,
    transcripts: surveyTranscripts,
    chunks: transcripts.flatMap((t) => chunkTranscript(t, maxChunk)),
  };
}

/**
 * Render the survey as a human/agent-readable markdown document. Same content
 * as the JSON survey, built for reading in one pass.
 */
export function renderBangerSurveyMarkdown(survey: BangerSurvey): string {
  const out: string[] = [];
  out.push("# Banger survey");
  out.push("");
  out.push(`- mode: ${survey.mode}`);
  out.push(`- transcripts: ${survey.transcriptCount}`);
  out.push(`- chunks: ${survey.chunks.length}`);
  out.push("");
  out.push(
    "You are looking for the SINGLE most compressed, non-obvious earned secret",
  );
  out.push(
    "actually SAID in these turns — one postable line. Most meetings yield none.",
  );

  for (const t of survey.transcripts) {
    out.push("");
    out.push(`## Transcript: ${t.title ?? t.path}`);
    out.push("");
    out.push(`- path: ${t.path}`);
    if (t.date) out.push(`- date: ${t.date}`);
    if (t.participants?.length) out.push(`- participants: ${t.participants.join(", ")}`);
    out.push(`- turns: ${t.turnCount}`);
    if (t.speakers.length > 0) {
      out.push("");
      out.push("Speaker turn counts (a hint for who holds the asymmetric view):");
      out.push("");
      for (const s of t.speakers) out.push(`- ${s.speaker}: ${s.turns}`);
    }
    if (t.summary) {
      out.push("");
      out.push("### Pre-written summary (AI-generated header — NOT spoken text)");
      out.push("");
      out.push(t.summary);
    }
  }

  out.push("");
  out.push("## Chunks (the spoken turns — the banger lives here)");
  for (const c of survey.chunks) {
    out.push("");
    out.push(`### Chunk ${c.index} — ${c.transcript}`);
    out.push("");
    out.push(c.text);
  }
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// scrub-check — the two deterministic checks over a candidate line
// ---------------------------------------------------------------------------

export interface BangerCheck {
  /** The line being checked. */
  line: string;
  /** Leak-safety flags (proper names, money, %, emails, URLs) — never edits. */
  safety: SafetyFlagResult;
  /** AI-slop tells + density score. */
  slop: SlopReport;
  /**
   * True when the line is clean on BOTH deterministic checks: no flag that also
   * appears in the source (no real private entity carried straight from the
   * meeting) AND zero slop tells. This is necessary-not-sufficient — the agent's
   * abstraction-ladder + 4-question safety judgment still gates the artifact.
   * A flag that is NOT in the source (a generic illustrative name/number the
   * agent invented) does not by itself fail the check, but is surfaced for the
   * human gate.
   */
  clean: boolean;
}

/**
 * Run both deterministic checks over a candidate banger line. REPORTS only —
 * never rewrites or redacts. `clean` is a conservative gate: it trips on any
 * source-carried safety flag (a real private entity) or any slop tell. The
 * agent still owns the abstraction-ladder + 4-question judgment; this just makes
 * the mechanical tells impossible to miss before the human-approval gate.
 *
 * @param line       the candidate one-line banger
 * @param sourceText the source transcript spoken text (pass "" if unavailable;
 *                   every safety flag then reports inSource:false)
 */
export function checkBanger(line: string, sourceText = ""): BangerCheck {
  const safety = safetyFlags(line, sourceText);
  const slop = scrubSlop(line);
  const clean = safety.fromSource.length === 0 && slop.tells.length === 0;
  return { line, safety, slop, clean };
}

/** Render a checkBanger result as a readable report for the agent/human. */
export function renderBangerCheck(check: BangerCheck): string {
  const out: string[] = [];
  out.push(`line: ${check.line}`);
  out.push("");
  out.push(`clean: ${check.clean ? "yes" : "NO"}`);
  out.push("");
  out.push("leak-safety flags:");
  if (check.safety.flagged.length === 0) {
    out.push("  (none)");
  } else {
    for (const f of check.safety.flagged) {
      out.push(
        `  - ${f.kind}: "${f.term}"${f.inSource ? "  ⚠ IN SOURCE (real private entity)" : "  (not in source)"}`,
      );
    }
  }
  out.push("");
  out.push(`AI-slop tells (score ${check.slop.score}):`);
  if (check.slop.tells.length === 0) {
    out.push("  (none)");
  } else {
    for (const t of check.slop.tells) out.push(`  - ${t.type}: "${t.excerpt}"`);
  }
  out.push("");
  if (check.clean) {
    out.push(
      "Both mechanical checks pass. This is NECESSARY, not sufficient — you still",
    );
    out.push(
      "own the abstraction ladder + 4-question safety test, and this artifact",
    );
    out.push("STILL saves as approval_status:pending for a human gate.");
  } else {
    out.push(
      "Not clean. Revise: climb the abstraction ladder for any IN-SOURCE flag,",
    );
    out.push("rewrite to kill any slop tell, then re-check. Zero bangers is valid.");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Quote verification — same contract as the other skills' verify-quotes
// ---------------------------------------------------------------------------

export interface QuoteFailure {
  index: number;
  quote: string;
  transcript: string;
  reason: string;
}

/**
 * Verify every source_quote verbatim (whitespace-insensitive) against its
 * transcript file. Returns the failures; an empty array means all verified.
 * For a banger, the quote(s) anchor the EARNED SECRET to a real spoken moment —
 * a banger asserting something nobody said is the failure to avoid.
 */
export async function verifyArtifactQuotes(
  quotes: SourceQuote[],
): Promise<QuoteFailure[]> {
  const cache = new Map<string, Transcript>();
  const failures: QuoteFailure[] = [];
  for (const [index, sq] of quotes.entries()) {
    try {
      let transcript = cache.get(sq.transcript);
      if (!transcript) {
        transcript = parseTranscript(await readFile(sq.transcript, "utf8"), sq.transcript);
        cache.set(sq.transcript, transcript);
      }
      if (!verifyQuote(transcript, sq.quote)) {
        failures.push({
          index,
          quote: sq.quote,
          transcript: sq.transcript,
          reason: "quote not found verbatim in transcript",
        });
      }
    } catch (e) {
      failures.push({
        index,
        quote: sq.quote,
        transcript: sq.transcript,
        reason: `could not read transcript: ${(e as Error).message}`,
      });
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Save — validate + persist the social-post artifact (pending approval)
// ---------------------------------------------------------------------------

/** A postable X line shouldn't run long; over this, save warns (non-fatal). */
export const MAX_POST_CHARS = 280;

export interface SavedBanger {
  written: WrittenArtifact;
  charCount: number;
  warnings: string[];
}

/**
 * Normalize, validate, and persist a banger as a "social-post" artifact.
 * Banger-specific rules on top of the shared contract:
 *   - type is forced to "social-post";
 *   - platform defaults to "x", audience to "public";
 *   - approval_status is FORCED to "pending" — nothing outward-facing ships
 *     pre-approved, so an incoming "approved" is rejected outright (the human
 *     approval gate lives downstream, not in this script);
 *   - the post line itself lives in `body` (the headline is an internal label);
 *   - hero_image: null is stripped (illustrate-card adds one later if wanted).
 * Throws on contract violations.
 */
export async function saveBanger(
  raw: Record<string, unknown>,
  opts: { outDir?: string } = {},
): Promise<SavedBanger> {
  raw.id ??= newArtifactId();
  raw.generated_at ??= new Date().toISOString();
  raw.type ??= "social-post";
  if (raw.type !== "social-post") {
    throw new Error(
      `banger-extractor only saves type "social-post" (got "${String(raw.type)}")`,
    );
  }

  raw.platform ??= "x";
  raw.audience ??= "public";

  // The cardinal rule, enforced structurally: a banger never ships pre-approved.
  // Refuse anything claiming approval — approval happens at a human gate
  // downstream of this script, never inside it.
  if (raw.approval_status !== undefined && raw.approval_status !== "pending") {
    throw new Error(
      "banger-extractor refuses to save a pre-approved artifact: approval_status " +
        `must be "pending" (got "${String(raw.approval_status)}"). Nothing ` +
        "outward-facing auto-publishes — approval is a human gate downstream.",
    );
  }
  raw.approval_status = "pending";

  if (raw.hero_image === null) delete raw.hero_image;

  if (typeof raw.body !== "string" || !raw.body.trim()) {
    throw new Error("a banger requires a non-empty body (the postable line)");
  }

  const result = validateArtifact(raw);
  if (!result.ok) {
    throw new Error(`Artifact failed contract validation:\n  - ${result.errors.join("\n  - ")}`);
  }

  const line = result.artifact.body ?? "";
  const charCount = line.trim().length;
  const warnings: string[] = [];
  if (charCount > MAX_POST_CHARS) {
    warnings.push(`post line is ${charCount} chars; X limit is ${MAX_POST_CHARS}`);
  }
  if (charCount === 0) {
    warnings.push("post line is empty");
  }

  const written = await writeArtifact(result.artifact, { outDir: opts.outDir });
  return { written, charCount, warnings };
}
