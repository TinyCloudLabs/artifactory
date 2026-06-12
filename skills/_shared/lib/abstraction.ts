// abstraction.ts — the leak-prevention core for outward-facing artifacts.
//
// The competitive edge of this whole system is its SOURCE MATERIAL: private
// meetings are an earned-secret factory. The hard, valuable work is the
// ABSTRACTION — turning a private incident into a shareable lesson WITHOUT
// leaking the customer, the person, the deal, or the unannounced number. A
// social post or investor snippet that names a real private entity is a leak,
// however well-written.
//
// This module does the DETERMINISTIC half of leak prevention:
//   - LADDER:      a documented abstraction ladder the agent climbs (specific
//                  incident → strip identifiers → generalize actors → lift to
//                  the transferable lesson → keep ONE true non-confidential
//                  detail). Doc/constant, not an algorithm — climbing it is
//                  agent judgment.
//   - safetyFlags: deterministically FLAG risky specifics in a draft (proper
//                  names, dollar figures, named customers/deals/products),
//                  especially ones that also appear in the source transcript
//                  (i.e. real private entities, not generic illustration). It
//                  FLAGS for review; it NEVER auto-edits.
//   - SAFETY_TEST: the 4-question safety checklist the skills embed in their
//                  critic step.
//
// Cardinal rule of this repo: NOTHING outward-facing auto-publishes, and
// nothing here auto-redacts. safetyFlags is the INPUT to a human-approval gate,
// not a replacement for it. The agent + the human decide; this just makes sure
// the risky specifics are impossible to miss.
//
// Plain TS, no deps — same constraint as the rest of _shared/lib.

// ---------------------------------------------------------------------------
// The abstraction ladder — documented rungs the agent climbs
// ---------------------------------------------------------------------------

export interface AbstractionRung {
  /** Stable key for referencing the rung. */
  level: number;
  name: string;
  /** What the agent does at this rung. */
  guidance: string;
}

/**
 * The abstraction LADDER. A private incident becomes a shareable lesson by
 * climbing these rungs in order. This is a DOC the SKILL.mds embed and the
 * agent reasons through — not an automated transform. Each rung removes a
 * class of leak while preserving the transferable insight; the last rung
 * deliberately keeps ONE true, non-confidential detail so the lesson stays
 * concrete instead of dissolving into generic advice.
 */
export const ABSTRACTION_LADDER: readonly AbstractionRung[] = [
  {
    level: 1,
    name: "specific-incident",
    guidance:
      "Start from the real moment as it happened in the meeting — the concrete" +
      " incident is where the earned secret lives. This is the raw material," +
      " not the artifact: it still names the customer, the person, the number.",
  },
  {
    level: 2,
    name: "strip-identifiers",
    guidance:
      "Remove the direct identifiers: customer/company names, person names," +
      " product names, deal names, exact dollar figures, dates that pin the" +
      " event, and anything a search would resolve to the real entity.",
  },
  {
    level: 3,
    name: "generalize-actors",
    guidance:
      'Replace named actors with their role/class ("a mid-market customer", "a' +
      ' founder we were selling to", "an enterprise prospect"). The relationship' +
      " and the dynamic survive; the identity does not.",
  },
  {
    level: 4,
    name: "lift-to-lesson",
    guidance:
      "State the TRANSFERABLE lesson — the thing that is true beyond this one" +
      " incident and useful to a stranger. If what remains only makes sense if" +
      " you know who it was about, you have not lifted it yet.",
  },
  {
    level: 5,
    name: "keep-one-true-detail",
    guidance:
      "Keep exactly ONE concrete, non-confidential detail so the lesson stays" +
      " specific and credible instead of generic LinkedIn mush. The detail must" +
      " pass the safety test on its own — it reveals nothing about the real" +
      " entity, only texture about the lesson.",
  },
] as const;

// ---------------------------------------------------------------------------
// The 4-question safety test — embedded in the skills' critic step
// ---------------------------------------------------------------------------

export interface SafetyQuestion {
  id: string;
  question: string;
  /** Why a "yes" (or, for the last one, a "no") fails the artifact. */
  failMode: string;
}

/**
 * The safety TEST: four questions the agent answers in its critic step before
 * an outward-facing artifact reaches the human-approval gate. The first three
 * must be answerable "no"; the last must be answerable "yes". Any other answer
 * sends the draft back down the ladder (or kills it — zero is a valid result).
 */
export const SAFETY_TEST: readonly SafetyQuestion[] = [
  {
    id: "identifiable-entity",
    question:
      "Could a reader identify the specific customer, company, deal, or product" +
      " from this draft?",
    failMode:
      "yes → leak. Climb to strip-identifiers / generalize-actors and re-test.",
  },
  {
    id: "participant-exposed",
    question:
      "Would a participant in the source meeting feel exposed, misquoted, or" +
      " betrayed reading this in public?",
    failMode:
      "yes → relationship damage. Generalize the actor or drop the detail.",
  },
  {
    id: "unannounced-strategy",
    question:
      "Does this reveal unannounced strategy, roadmap, numbers, or anything not" +
      " already public?",
    failMode:
      "yes → leak of non-public information. Remove the specific or do not ship.",
  },
  {
    id: "insight-survives",
    question:
      "Stripped down to the lesson, is there still a non-obvious insight worth a" +
      " stranger's attention?",
    failMode:
      "no → nothing left to say. Kill it; abstraction emptied the artifact.",
  },
] as const;

// ---------------------------------------------------------------------------
// safetyFlags — deterministic risky-specific detector (FLAGS, never edits)
// ---------------------------------------------------------------------------

export type FlagKind =
  /** Capitalized proper-noun name (person, company, product, place). */
  | "proper-noun"
  /** A dollar/money figure. */
  | "money"
  /** A percentage figure (often an unannounced metric). */
  | "percent"
  /** An email address — a direct personal identifier. */
  | "email"
  /** A URL/domain — can resolve to a specific private entity. */
  | "url";

export interface SafetyFlag {
  /** The exact text matched in the draft. */
  term: string;
  kind: FlagKind;
  /**
   * True when this term ALSO appears in the source transcript — i.e. it is a
   * REAL private entity carried straight from the meeting, not a generic
   * illustration the agent invented. These are the highest-risk flags.
   */
  inSource: boolean;
}

export interface SafetyFlagResult {
  /** Every risky specific found, in order of appearance, de-duplicated. */
  flagged: SafetyFlag[];
  /** Convenience: the subset that also appears in the source (real entities). */
  fromSource: SafetyFlag[];
}

// Money: "$100k", "$50,000", "$7.5M", "$2,600". Mirrors the spoken-money shapes
// novelty.ts tracks, but tuned for written drafts (symbol-led only — a draft
// won't say "100 grand").
const MONEY_RE = /\$\d[\d,]*(?:\.\d+)?(?:\s*(?:thousand|million|billion|[kKmMbB])\b)?/g;
const PERCENT_RE = /\b\d+(?:\.\d+)?\s*(?:%|percent\b)/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
// URL or bare domain (foo.com, https://acme.io/x). Kept conservative so plain
// prose ("e.g.", "i.e.") doesn't trip it: requires a known-ish TLD shape.
const URL_RE =
  /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|io|co|net|org|ai|app|dev|xyz|gg)(?:\/[^\s)]*)?\b/gi;

// Capitalized proper-noun phrase (1-4 words). Mid-sentence or sentence-initial;
// we de-noise below by dropping sentence-initial single words that are common
// words, and dropping anything on the COMMON_CAPS allowlist (months, days,
// etc. — capitalized but not private entities).
const CAP_WORD = String.raw`[A-Z][\w'’&-]*`;
const PROPER_NOUN_RE = new RegExp(String.raw`\b${CAP_WORD}(?:\s+${CAP_WORD}){0,3}\b`, "g");

// Capitalized words that are NOT private entities — calendar words, common
// sentence openers, and ubiquitous tech/biz words that say nothing about who.
const COMMON_CAPS = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "i", "i'm", "i've", "i'll", "the", "a", "an", "we", "they", "it", "this",
  "that", "these", "those", "but", "and", "or", "so", "yes", "no", "okay",
  "our", "their", "my", "your", "his", "her", "you", "he", "she",
  "q1", "q2", "q3", "q4", "ceo", "cto", "coo", "cfo", "vp", "ai", "api", "saas",
  "when", "where", "what", "why", "how", "who", "if", "then", "here", "there",
  "monday", "today", "tomorrow", "yesterday",
]);

interface RawHit {
  term: string;
  kind: FlagKind;
  start: number;
}

/** Tokenize source text into a lowercased set of words + multiword phrases. */
function sourcePhraseSet(sourceText: string): Set<string> {
  const set = new Set<string>();
  if (!sourceText) return set;
  for (const m of sourceText.matchAll(PROPER_NOUN_RE)) {
    set.add(m[0].toLowerCase());
    // also index each word so a multiword draft term matches a single source word
    for (const w of m[0].split(/\s+/)) if (w) set.add(w.toLowerCase());
  }
  for (const re of [MONEY_RE, PERCENT_RE, EMAIL_RE, URL_RE]) {
    for (const m of sourceText.matchAll(re)) {
      set.add(m[0].toLowerCase());
      set.add(normalizeNumeric(m[0]));
    }
  }
  return set;
}

/** Normalize a money/percent value for cross-text matching ($100,000 ≈ $100000). */
function normalizeNumeric(value: string): string {
  return value.toLowerCase().replace(/[$,\s]/g, "");
}

function isProperNounHit(term: string): boolean {
  const words = term.split(/\s+/);
  // Multi-word capitalized phrase: almost always a real name/entity. Keep
  // unless EVERY word is a common-cap word.
  if (words.length > 1) {
    return !words.every((w) => COMMON_CAPS.has(w.toLowerCase()));
  }
  // Single capitalized word: keep only if it isn't a common opener/calendar
  // word. (We can't tell sentence-initial "Pricing" from a name deterministically,
  // so we keep it — a false flag costs a glance; a missed name costs a leak.)
  return !COMMON_CAPS.has(term.toLowerCase());
}

/**
 * Deterministically FLAG risky specifics in a draft for human/agent review.
 * Detects proper-noun names, money, percentages, emails, and URLs, and marks
 * which ones ALSO appear in the source transcript (`inSource: true`) — those
 * are real private entities carried straight from the meeting and are the
 * highest-risk leaks.
 *
 * This FLAGS; it does NOT auto-edit. The output feeds the human-approval gate
 * and the agent's climb up the ABSTRACTION_LADDER. A clean, fully-abstracted
 * draft (roles not names, lessons not numbers) returns no flags.
 *
 * @param draftText  the outward-facing draft being checked
 * @param sourceText the source transcript text (pass "" if unavailable — every
 *                   flag then reports inSource: false)
 */
export function safetyFlags(draftText: string, sourceText = ""): SafetyFlagResult {
  const source = sourcePhraseSet(sourceText);
  const hits: RawHit[] = [];

  const collect = (re: RegExp, kind: FlagKind, filter?: (t: string) => boolean) => {
    for (const m of draftText.matchAll(re)) {
      if (filter && !filter(m[0])) continue;
      hits.push({ term: m[0], kind, start: m.index });
    }
  };

  // Order matters for de-overlap: email/url before proper-noun (so "acme.io"
  // isn't also flagged as a capitalized word), money/percent are disjoint.
  collect(EMAIL_RE, "email");
  collect(URL_RE, "url");
  collect(MONEY_RE, "money");
  collect(PERCENT_RE, "percent");
  collect(PROPER_NOUN_RE, "proper-noun", isProperNounHit);

  // De-overlap: a later hit fully inside an earlier hit's span is dropped (the
  // proper-noun pass would otherwise re-flag words inside an email/url).
  hits.sort((a, b) => a.start - b.start || b.term.length - a.term.length);
  const spans: { start: number; end: number }[] = [];
  const kept: RawHit[] = [];
  for (const h of hits) {
    const end = h.start + h.term.length;
    if (spans.some((s) => h.start >= s.start && end <= s.end)) continue;
    spans.push({ start: h.start, end });
    kept.push(h);
  }

  // De-duplicate by term+kind, preserving first appearance; compute inSource.
  const seen = new Set<string>();
  const flagged: SafetyFlag[] = [];
  for (const h of kept) {
    const dedupeKey = `${h.kind}:${h.term.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const lower = h.term.toLowerCase();
    const inSource =
      source.has(lower) ||
      source.has(normalizeNumeric(h.term)) ||
      // a multiword draft name leaks if ANY of its words is a source entity word
      (h.kind === "proper-noun" &&
        h.term.split(/\s+/).some((w) => source.has(w.toLowerCase())));
    flagged.push({ term: h.term, kind: h.kind, inSource });
  }

  return { flagged, fromSource: flagged.filter((f) => f.inSource) };
}

// ---------------------------------------------------------------------------
// Guidance string the SKILL.mds embed
// ---------------------------------------------------------------------------

/**
 * Human-readable guidance the generation SKILL.mds embed verbatim in their
 * critic step. Renders the ladder + the safety test as a checklist so the
 * agent climbs the same rungs and answers the same four questions every run.
 */
export const ABSTRACTION_GUIDANCE: string = [
  "ABSTRACTION (leak prevention). The edge is the source material; the work is",
  "turning a private incident into a shareable lesson WITHOUT leaking the",
  "customer, person, deal, or unannounced number. Nothing outward-facing",
  "auto-publishes — this ends at a human-approval gate.",
  "",
  "Climb the abstraction ladder:",
  ...ABSTRACTION_LADDER.map((r) => `  ${r.level}. ${r.name} — ${r.guidance}`),
  "",
  "Then run the 4-question safety test (first three must be NO, last must be YES):",
  ...SAFETY_TEST.map((q) => `  - ${q.question} (${q.failMode})`),
  "",
  "safetyFlags() will surface proper names, money, percentages, emails, and",
  "URLs in your draft — especially ones that appear in the source transcript",
  "(real private entities). It flags for your review; it does not redact. A",
  "flag is not automatically a leak, but every flag must be defensible before",
  "the draft reaches the approval gate.",
].join("\n");
