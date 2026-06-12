// slop-scrubber.ts — deterministic AI-tell linter for outward-facing drafts.
//
// Killing AI-slop tells is half the value of this system: a shareable artifact
// that reads like ChatGPT wrote it gets ignored no matter how good the
// underlying insight is. This linter REPORTS the tells deterministically so the
// agent (and the human at the approval gate) can see exactly what reads as
// machine-generated. It does NOT rewrite — rewriting is the agent's judgment;
// this just makes the tells impossible to miss.
//
// Detected tells (grounded in the humanizer skill / "signs of AI writing"):
//   - negative-parallelism  "not just X but Y" / "it's not just … it's …"
//   - hype-vocab            game-changer, 10x, unlock, the future of, etc.
//   - em-dash-density       em-dashes per sentence above a threshold
//   - tricolon              over-parallel "X, Y, and Z" rhythm, repeated
//   - hot-take-prefix       "unpopular opinion:" / "hot take:" openers
//   - clean-listicle        suspiciously round, uniformly-formatted lists
//
// Returns {tells, score}: score is a normalized tell-density (0 = clean human
// prose, higher = more machine-y), so a critic step can threshold on it. Plain
// TS, no deps — same constraint as the rest of _shared/lib.

export type SlopTellType =
  | "negative-parallelism"
  | "hype-vocab"
  | "em-dash-density"
  | "tricolon"
  | "hot-take-prefix"
  | "clean-listicle";

export interface SlopTell {
  type: SlopTellType;
  /** The offending text (trimmed to a readable excerpt). */
  excerpt: string;
}

export interface SlopReport {
  tells: SlopTell[];
  /**
   * Tell density: tells per sentence, lightly capped. ~0 for clean human text;
   * a draft saturated with tells trends toward and above 1. A heuristic dial
   * for a critic threshold, not a precise metric.
   */
  score: number;
}

// "not just X but Y", "it's not just … it's …", "not only … but also …",
// "isn't just … it's …" — the negative-parallelism construction.
const NEGATIVE_PARALLELISM_RES: RegExp[] = [
  /\b(?:it'?s|that'?s|this is|isn'?t|aren'?t|wasn'?t)\s+not\s+just\b[^.!?\n]*/gi,
  /\bnot\s+just\b[^.!?\n]*?\bbut\b/gi,
  /\bnot\s+only\b[^.!?\n]*?\bbut(?:\s+also)?\b/gi,
  // "X isn't about A, it's about B" / "isn't … it's …" antithesis.
  /\b(?:isn'?t|aren'?t|wasn'?t|weren'?t)\b[^.!?\n]*?\b(?:it'?s|that'?s|they'?re|we'?re)\b[^.!?\n]*/gi,
];

// Hype vocabulary. Each entry is matched as a word-bounded phrase.
const HYPE_TERMS = [
  "game-changer", "game changer", "game-changing", "10x", "100x",
  "unlock", "unlocks", "unlocking", "the future of", "big things coming",
  "supercharge", "supercharged", "seamless", "seamlessly", "revolutionize",
  "revolutionary", "paradigm shift", "next-level", "next level", "leverage",
  "synergy", "synergies", "cutting-edge", "best-in-class", "world-class",
  "delve", "deep dive", "at the end of the day", "moving forward",
  "in today's fast-paced", "elevate", "harness the power",
];
const HYPE_RE = new RegExp(
  "\\b(?:" +
    HYPE_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")\\b",
  "gi",
);

// "unpopular opinion:", "hot take:", "controversial take:", "real talk:"
const HOT_TAKE_RE =
  /\b(?:unpopular opinion|hot take|controversial take|real talk|let that sink in|plot twist)\s*[:.\-—]/gi;

/** Em-dash density flags when em-dashes exceed ~1 per 2 sentences. */
const EM_DASH_PER_SENTENCE_THRESHOLD = 0.5;

/** Split into sentences (rough — good enough for density ratios). */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function excerpt(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

/**
 * Detect a repeated tricolon / over-parallel rhythm: "A, B, and C" lists that
 * recur. A single tricolon is fine human prose; the tell is the RHYTHM — using
 * the rule-of-three repeatedly. We flag each tricolon but only count toward
 * meaningful slop when 2+ appear (the score reflects this).
 */
const TRICOLON_RE = /\b[\w][\w\s'’-]*?,\s+[\w][\w\s'’-]*?,\s+(?:and|or)\s+[\w][\w\s'’-]*?\b/gi;

/**
 * Detect suspiciously-clean listicles: 3+ consecutive lines that are list items
 * with uniform formatting (same bullet/number style, similar length), the kind
 * of round, evenly-weighted list an LLM emits. Returns the block excerpts.
 */
function detectCleanListicles(text: string): string[] {
  const lines = text.split("\n");
  const isItem = (l: string) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l);
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 3) {
      // Uniform length: low variance in item length reads as machine-even.
      const lens = run.map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").length);
      const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
      const variance =
        lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
      const stdev = Math.sqrt(variance);
      // Coefficient of variation < 0.35 → suspiciously uniform.
      if (mean > 0 && stdev / mean < 0.35) {
        out.push(excerpt(run.join(" / "), 120));
      }
    }
    run = [];
  };
  for (const l of lines) {
    if (isItem(l)) run.push(l);
    else flush();
  }
  flush();
  return out;
}

/**
 * Lint a draft for AI-slop tells. Returns every tell found plus a normalized
 * density score. REPORTS only — never rewrites. Clean, human-style prose
 * returns no tells and a near-zero score.
 */
export function scrubSlop(text: string): SlopReport {
  const tells: SlopTell[] = [];
  const sentences = splitSentences(text);
  const sentenceCount = Math.max(1, sentences.length);

  // Negative parallelism
  for (const re of NEGATIVE_PARALLELISM_RES) {
    for (const m of text.matchAll(re)) {
      tells.push({ type: "negative-parallelism", excerpt: excerpt(m[0]) });
    }
  }

  // Hype vocabulary
  for (const m of text.matchAll(HYPE_RE)) {
    tells.push({ type: "hype-vocab", excerpt: m[0] });
  }

  // Hot-take prefixes
  for (const m of text.matchAll(HOT_TAKE_RE)) {
    tells.push({ type: "hot-take-prefix", excerpt: excerpt(m[0]) });
  }

  // Em-dash density (em-dash, not hyphen)
  const emDashes = (text.match(/—/g) ?? []).length;
  if (emDashes / sentenceCount > EM_DASH_PER_SENTENCE_THRESHOLD) {
    tells.push({
      type: "em-dash-density",
      excerpt: `${emDashes} em-dashes across ${sentenceCount} sentence(s)`,
    });
  }

  // Tricolon rhythm — flag each, but it only matters as a repeated pattern.
  const tricolons = [...text.matchAll(TRICOLON_RE)];
  if (tricolons.length >= 2) {
    for (const m of tricolons) {
      tells.push({ type: "tricolon", excerpt: excerpt(m[0]) });
    }
  }

  // Clean listicles
  for (const block of detectCleanListicles(text)) {
    tells.push({ type: "clean-listicle", excerpt: block });
  }

  // Score: tells per sentence, capped per-type contribution so one saturated
  // tell type can't swamp the signal. Em-dash and listicle each count once.
  const score = tells.length / sentenceCount;

  return { tells, score: Math.round(score * 1000) / 1000 };
}

/**
 * Guidance the generation SKILL.mds embed verbatim. Names the banned
 * constructions so the agent writes around them up front, and frames the
 * linter as a check, not an autofix.
 */
export const SLOP_GUIDANCE: string = [
  "KILL THE AI-SLOP TELLS. Outward-facing drafts that read like an LLM wrote",
  "them get ignored regardless of the insight. Do not use:",
  '  - negative parallelism: "not just X but Y", "it\'s not just … it\'s …"',
  '  - hype vocab: game-changer, 10x, unlock, the future of, supercharge,',
  "    seamless, leverage, delve, deep dive, world-class, big things coming",
  "  - em-dash overuse (keep under ~1 per 2 sentences)",
  '  - the rule-of-three rhythm used repeatedly ("X, Y, and Z" over and over)',
  '  - hot-take openers: "unpopular opinion:", "hot take:"',
  "  - suspiciously round, uniformly-weighted listicles",
  "",
  "scrubSlop() reports these deterministically with a density score. Treat a",
  "non-trivial score as a rewrite signal — the linter flags, you rewrite. Aim",
  "for prose a sharp human would actually publish.",
].join("\n");
