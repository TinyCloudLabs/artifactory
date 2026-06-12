// snippet.ts — deterministic helpers for the investor-snippet skill.
//
// Everything here is plumbing: surveying transcripts, running the two
// outward-facing safety linters (leak flags + AI-slop tells) over a draft,
// quote verification, and persisting the artifact. The JUDGMENT — picking the
// ONE genuine investor signal, framing it in a credible-not-hype register,
// climbing the abstraction ladder, deciding zero is the right answer — belongs
// to the agent reading SKILL.md. No model calls happen in this file or in any
// script that imports it.
//
// Reuses the write-article digest + quote-verification plumbing verbatim (same
// transcripts → same survey), so the investor-snippet skill doesn't re-derive
// transcript parsing. The investor-specific bits are: the combined safety
// report (abstraction.safetyFlags + slop-scrubber.scrubSlop) and a save that
// enforces the outward-facing contract — type "investor-update-snippet",
// audience "investors", approval_status "pending" (nothing outward auto-ships).

import {
  newArtifactId,
  validateArtifact,
  writeArtifact,
  type Artifact,
  type WrittenArtifact,
} from "../../_shared/lib/artifact.ts";
import {
  safetyFlags,
  type SafetyFlag,
  type SafetyFlagResult,
} from "../../_shared/lib/abstraction.ts";
import { scrubSlop, type SlopReport } from "../../_shared/lib/slop-scrubber.ts";

// Re-export the digest plumbing so the survey script (and tests) can pull
// everything investor-snippet needs from one place; the build is identical to
// write-article's, deliberately — a survey is a survey.
export {
  buildDigest,
  renderDigestMarkdown,
  verifyArtifactQuotes,
  type ArticleDigest,
  type QuoteFailure,
} from "../../write-article/scripts/article.ts";

// ---------------------------------------------------------------------------
// Safety report — the combined outward-facing check for a snippet draft
// ---------------------------------------------------------------------------

/**
 * An investor snippet is short and forwardable. Two failure modes sink it:
 * leaking a real private entity (the source material is the edge — leaking it
 * is the cardinal sin) and reading like ChatGPT hype (an investor pattern-
 * matches that to noise instantly). This report runs both deterministic
 * linters and rolls them into one object the agent reviews before the draft
 * reaches the human-approval gate. It FLAGS; it never rewrites.
 */
export interface SnippetSafetyReport {
  /** Leak detector: proper nouns, money, %, emails, URLs in the draft. */
  leaks: SafetyFlagResult;
  /** AI-slop tells + a normalized density score. */
  slop: SlopReport;
  /**
   * The single highest-risk subset: flagged terms that ALSO appear in the
   * source transcript — real private entities carried straight from the
   * meeting. A non-empty list means the draft almost certainly leaks; climb
   * the abstraction ladder before it goes anywhere.
   */
  leaksFromSource: SafetyFlag[];
}

/**
 * Run the leak + slop linters over a snippet draft. `draftText` should be the
 * exact text that would be forwarded (headline + body — what an investor
 * reads); `sourceText` is the concatenated source transcript text so leaks
 * carried from the meeting can be marked `inSource`. Pure function: no I/O.
 */
export function analyzeSnippet(
  draftText: string,
  sourceText = "",
): SnippetSafetyReport {
  const leaks = safetyFlags(draftText, sourceText);
  const slop = scrubSlop(draftText);
  return { leaks, slop, leaksFromSource: leaks.fromSource };
}

/** Render the safety report as a readable lint summary for the agent/CLI. */
export function renderSafetyReport(report: SnippetSafetyReport): string {
  const out: string[] = [];
  out.push("# Investor-snippet safety report");
  out.push("");

  out.push("## Leak flags (proper nouns, money, %, emails, URLs)");
  out.push("");
  if (report.leaks.flagged.length === 0) {
    out.push("- (none) — draft carries no flaggable specifics.");
  } else {
    for (const f of report.leaks.flagged) {
      out.push(`- [${f.kind}] ${f.term}${f.inSource ? "  <- IN SOURCE (highest risk)" : ""}`);
    }
  }
  out.push("");
  out.push(
    report.leaksFromSource.length === 0
      ? "No flagged term appears in the source transcript."
      : `WARNING: ${report.leaksFromSource.length} flagged term(s) appear in the source — real private entities. Climb the abstraction ladder before approving.`,
  );

  out.push("");
  out.push(`## AI-slop tells (density score: ${report.slop.score})`);
  out.push("");
  if (report.slop.tells.length === 0) {
    out.push("- (none) — reads clean.");
  } else {
    for (const t of report.slop.tells) {
      out.push(`- [${t.type}] ${t.excerpt}`);
    }
  }
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Save — validate + persist the outward-facing investor snippet
// ---------------------------------------------------------------------------

/**
 * A forwardable investor DM is short. Outside this band the save warns
 * (non-fatal): a 2-line nugget that drops into a DM, not a memo. Counted on
 * the body (the snippet text); headline is the framing line above it.
 */
export const SNIPPET_WORDS_MIN = 12;
export const SNIPPET_WORDS_MAX = 90;

export interface SavedSnippet {
  written: WrittenArtifact;
  wordCount: number;
  warnings: string[];
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Normalize, validate, and persist an investor-snippet artifact to
 * <outDir>/investor-update-snippet/<slug>/artifact.json.
 *
 * Outward-facing contract enforced here (on top of the shared contract):
 * - type must be "investor-update-snippet" (defaulted when missing);
 * - body is required (the snippet *is* the body — the forwardable text);
 * - audience is forced to "investors";
 * - approval_status is forced to "pending" — NOTHING outward-facing ships
 *   without a human at the approval gate. Even an explicit "approved" in the
 *   draft is downgraded; approval is a human action taken on the saved
 *   artifact, never something the generation step grants itself.
 */
export async function saveSnippet(
  raw: Record<string, unknown>,
  opts: { outDir?: string } = {},
): Promise<SavedSnippet> {
  raw.id ??= newArtifactId();
  raw.generated_at ??= new Date().toISOString();
  raw.type ??= "investor-update-snippet";
  if (raw.type !== "investor-update-snippet") {
    throw new Error(
      `investor-snippet only saves type "investor-update-snippet" (got "${String(raw.type)}")`,
    );
  }

  if (typeof raw.body !== "string" || !raw.body.trim()) {
    throw new Error("investor-snippet artifacts require a non-empty body (the forwardable text)");
  }

  // Outward-facing invariants — set by the save step, not trusted from the draft.
  raw.audience = "investors";
  raw.approval_status = "pending";

  const result = validateArtifact(raw);
  if (!result.ok) {
    throw new Error(`Artifact failed contract validation:\n  - ${result.errors.join("\n  - ")}`);
  }

  const artifact: Artifact = result.artifact;
  const wordCount = countWords(artifact.body ?? "");
  const warnings: string[] = [];
  if (wordCount < SNIPPET_WORDS_MIN || wordCount > SNIPPET_WORDS_MAX) {
    warnings.push(
      `body is ${wordCount} words; a forwardable investor nugget is ~${SNIPPET_WORDS_MIN}-${SNIPPET_WORDS_MAX} (drop-into-a-DM short, not a memo)`,
    );
  }

  const written = await writeArtifact(artifact, { outDir: opts.outDir });
  return { written, wordCount, warnings };
}
