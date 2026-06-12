// attribution.ts — deterministic identity/role/affiliation grounding check.
//
// distillery makes claims about REAL PEOPLE. Every claim about a person's
// identity, role, title, affiliation, employer, location, or relationship MUST
// be explicitly supported by the source transcript — never inferred, guessed,
// or imported from outside context. verify-quotes proves the QUOTES are real;
// this proves the IDENTITY FRAMING around them is real too.
//
// The incident this guards against (ground truth): a generated card stated
// "Odisea's Cush — a Shape Rotator cohort founder" while the source transcript
// contained ZERO mentions of "Shape Rotator" or "cohort". The quotes were
// verbatim-real; the affiliation was fabricated by inference. quotes_verified
// was true and it still shipped a false claim about a real person.
//
// Approach (the analog of verifyQuote, for descriptors):
//   1. Scan the artifact's prose for patterns that ATTACH A DESCRIPTOR to a
//      NAMED PERSON — "<Name> — <descriptor>", "<Name>, <role/affiliation>",
//      "<Name> who <is/works/runs/founded> …", "<Org>'s <Name>", "<Name> of
//      <Org>", "<Name> from <Place>".
//   2. For each, pull the descriptor's KEY TERMS (proper-noun org/place names,
//      role/affiliation nouns) and check whether each appears somewhere in the
//      source transcript, using the same case/whitespace-insensitive matching
//      as verifyQuote.
//   3. Return one record per claim: { person, descriptor, grounded, missingTerms }.
//      grounded=false means at least one key term of the descriptor is absent
//      from the source — the claim is NOT supported and must be judged.
//
// This is DETERMINISTIC and NO-LLM by design. It over-flags on paraphrase
// (e.g. the source says "runs a company", the card says "founder" — different
// word, flagged). That is acceptable and intended: it FLAGS for the agent /
// critic to judge and correct, it never auto-deletes. False positives cost a
// human/critic glance; a false negative ships a fabricated claim about a real
// person, which is the trust-critical failure this exists to stop.

import { isStopword } from "./stopwords.ts";

export interface AttributionClaim {
  /** The named person the descriptor is attached to, as it appeared in prose. */
  person: string;
  /** The descriptor span attached to the person (role/affiliation/place/…). */
  descriptor: string;
  /**
   * The pattern that matched, for debugging / reporting:
   * "dash" | "appositive" | "relative" | "possessive" | "of-org" | "from-place".
   */
  pattern: AttributionPattern;
  /** True when every key term of the descriptor appears in the source. */
  grounded: boolean;
  /** Descriptor key terms NOT found in the source (lowercased). Empty when grounded. */
  missingTerms: string[];
}

export type AttributionPattern =
  | "dash"
  | "appositive"
  | "relative"
  | "possessive"
  | "of-org"
  | "from-place";

// A capitalized name token: "Cush", "O'Brien", "Mary-Jane", "Dorsey". Mirrors
// the NAME_WORD shape used by the transcript parser.
const NAME_WORD = String.raw`[A-Z][\w.'’-]*`;
// A full person name: 1–3 capitalized words ("Cush", "Samuel Gbafa",
// "Hunter K Horsfall"). Kept to 3 to avoid swallowing a following sentence.
const NAME = String.raw`${NAME_WORD}(?:\s+${NAME_WORD}){0,2}`;

// Relative-clause verbs that introduce a role/affiliation claim:
// "Cush who founded …", "Sam who runs …", "Ada who works at …".
const RELATIVE_VERB =
  "(?:is|was|are|were|works?|worked|runs?|ran|leads?|led|founded|founders?|co-?founded|heads?|headed|owns?|owned|serves?|served|manages?|managed|directs?|directed|joined|builds?|built)";

// Role / affiliation / relationship nouns. When a descriptor contains one of
// these (the "claim words"), the claim is asserting WHO the person IS, not just
// a passing adjective — these are the substantive terms we ground-check.
const ROLE_NOUNS = new Set<string>([
  "founder", "founders", "cofounder", "co-founder", "cofounders",
  "ceo", "cto", "coo", "cfo", "cmo", "president", "vp", "vice",
  "director", "manager", "lead", "head", "chief", "officer",
  "engineer", "engineers", "developer", "designer", "architect",
  "investor", "investors", "partner", "partners", "advisor", "adviser",
  "analyst", "consultant", "contractor", "freelancer", "intern",
  "researcher", "scientist", "professor", "student", "alum", "alumnus",
  "owner", "operator", "principal", "associate", "executive",
  "employee", "staff", "member", "cohort", "fellow", "graduate",
  "client", "customer", "vendor", "supplier", "colleague", "teammate",
  "boss", "report", "manager",
]);

// Words that signal a descriptor is RELATIONAL/affiliational even without a
// role noun: "Cush of Odisea", "Sam from Flashbots", "the X team's lead".
const AFFILIATION_PREPS = new Set<string>(["of", "from", "at", "with", "for"]);

// Role-asserting verbs. In a relative/direct clause ("Dana who founded the
// company", "Sam runs Odisea") the VERB carries the identity claim, so it is a
// checkable key term in its own right — the source must show that relationship,
// not just the person's name. Stored as base forms; we match the verb stem
// (founded/found, runs/ran/run, leads/led) loosely via the source containing
// any of the listed surface forms.
const ROLE_VERBS = new Set<string>([
  "founded", "found", "founding",
  "runs", "ran", "running",
  "leads", "led", "leading",
  "heads", "headed", "heading",
  "owns", "owned", "owning",
  "manages", "managed", "managing",
  "directs", "directed", "directing",
  "built", "builds", "building",
  "co-founded", "cofounded",
]);

// Tokenize a descriptor into ground-checkable key terms:
//   - PROPER NOUNS (Capitalized words / multi-word proper phrases) — org names,
//     place names, product names: "Shape Rotator", "Guatemala", "Flashbots".
//   - ROLE NOUNS from the set above ("founder", "cohort", "investor").
// Everything else (articles, prepositions, generic adjectives, stopwords) is
// dropped: those don't pin a verifiable fact and would only create noise.
function descriptorKeyTerms(descriptor: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (term: string) => {
    const norm = term.toLowerCase().trim();
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    terms.push(norm);
  };

  // 1. Multi-word Proper-Noun phrases ("Shape Rotator", "Y Combinator").
  //    Grab runs of 2+ consecutive capitalized words as a single phrase so the
  //    org name is checked as a unit, then also index their parts isn't needed —
  //    a phrase match is stronger and matches verifyQuote semantics.
  const properPhraseRe = new RegExp(String.raw`${NAME_WORD}(?:\s+${NAME_WORD})+`, "g");
  const consumed: Array<[number, number]> = [];
  for (const m of descriptor.matchAll(properPhraseRe)) {
    const phrase = m[0];
    // Skip a phrase made only of role nouns ("Vice President" is a title, but
    // its parts are still individually checked below); index the phrase only if
    // it carries a non-role proper token (a real org/place name).
    const parts = phrase.split(/\s+/);
    const hasProperOrg = parts.some((p) => !ROLE_NOUNS.has(p.toLowerCase()));
    if (hasProperOrg) {
      push(phrase);
      consumed.push([m.index!, m.index! + phrase.length]);
    }
  }

  const inConsumed = (idx: number) =>
    consumed.some(([s, e]) => idx >= s && idx < e);

  // 2. Single Capitalized proper nouns NOT already part of a phrase
  //    ("Guatemala", "Odisea", "Flashbots").
  const singleProperRe = new RegExp(String.raw`(?<![\w'’-])${NAME_WORD}`, "g");
  for (const m of descriptor.matchAll(singleProperRe)) {
    if (inConsumed(m.index!)) continue;
    const word = m[0];
    // A lone capitalized word that's just a role noun ("Founder") is handled by
    // the role-noun pass below; here we want proper nouns (orgs/places).
    if (ROLE_NOUNS.has(word.toLowerCase())) continue;
    push(word);
  }

  // 3. Role / affiliation nouns ("founder", "cohort", "investor") and role
  //    verbs ("founded", "runs", "led"), regardless of case — these are the
  //    substantive "who they are" / "what relationship" claim words.
  for (const m of descriptor.matchAll(/[A-Za-z][A-Za-z'’-]+/g)) {
    const word = m[0].toLowerCase();
    if (ROLE_NOUNS.has(word) || ROLE_VERBS.has(word)) push(word);
  }

  // Final cleanup: never ground-check a bare stopword (defensive; role nouns and
  // proper nouns above are not stopwords, but a proper phrase part could be).
  return terms.filter((t) => {
    // Keep multi-word phrases as-is; only single tokens get the stopword filter.
    if (t.includes(" ")) return true;
    return !isStopword(t);
  });
}

// True when a descriptor actually makes a substantive identity/role/affiliation
// claim worth checking — it contains a role noun, OR a proper-noun org/place
// term. A descriptor of only generic words ("a skeptical voice", "the load-
// bearing one") asserts no verifiable affiliation and is skipped (no claim).
function isSubstantiveDescriptor(descriptor: string): boolean {
  return descriptorKeyTerms(descriptor).length > 0;
}

// Normalize like verifyQuote: collapse whitespace, lowercase. The source haystack
// and each needle term are compared after this transform.
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// Strip leading articles/glue so the descriptor reported reads cleanly
// ("a Shape Rotator cohort founder" → descriptor span kept; we don't alter
// key-term extraction, only trim obvious trailing punctuation).
function trimDescriptor(descriptor: string): string {
  return descriptor
    .replace(/^[\s,;:—–-]+/, "")
    .replace(/[\s,;:.!?—–-]+$/, "")
    .trim();
}

/** A raw match before grounding: which person, which descriptor, which pattern. */
interface RawClaim {
  person: string;
  descriptor: string;
  pattern: AttributionPattern;
}

// A name capture can swallow a leading possessive ("Odisea's Cush") because
// NAME_WORD allows an apostrophe-s. The possessive extractor handles the
// "<Org>'s" affiliation claim separately, so for the person field here we want
// just the final name — strip a leading "<Word>'s " prefix when present.
function stripLeadingPossessive(name: string): string {
  const m = /^.+?['’]s\s+(.+)$/.exec(name);
  return m ? m[1]!.trim() : name.trim();
}

// Each extractor scans the prose and yields {person, descriptor, pattern}. They
// are intentionally permissive on the descriptor span (a clause up to the next
// strong boundary) and rely on descriptorKeyTerms to pull the checkable terms.

// Boundary that ends a descriptor clause: sentence end, a newline, OR a second
// em/en dash that closes a parenthetical aside ("Name — descriptor — verb …").
// Cutting at the closing dash keeps "a Shape Rotator cohort founder … from
// Guatemala" as the descriptor and drops the trailing "— laid out the heuristic".
const CLAUSE_END = String.raw`(?=[.!?\n—–]|$)`;
// A shorter descriptor for appositives: cut at the next comma or sentence end so
// "Cush, a founder, said X" yields descriptor "a founder" not "a founder, said X".
const APPOSITIVE_END = String.raw`(?=[,.!?\n]|$)`;

function extractDash(prose: string): RawClaim[] {
  const out: RawClaim[] = [];
  // "<Name> — <descriptor up to sentence end>"  (em dash, en dash, or " - ").
  const re = new RegExp(
    String.raw`(?<![\w'’-])(${NAME})\s*[—–]\s*(.+?)${CLAUSE_END}`,
    "g",
  );
  for (const m of prose.matchAll(re)) {
    out.push({ person: stripLeadingPossessive(m[1]!), descriptor: trimDescriptor(m[2]!), pattern: "dash" });
  }
  return out;
}

function extractAppositive(prose: string): RawClaim[] {
  const out: RawClaim[] = [];
  // "<Name>, a/an/the <descriptor>"  — appositive role/affiliation.
  // Require the descriptor to start with an article or a role/affiliation word
  // so we don't grab "Cush, and then he said …".
  const re = new RegExp(
    String.raw`(?<![\w'’-])(${NAME}),\s+((?:an?|the)\s+.+?|(?:running|founding|leading|heading)\s+.+?)${APPOSITIVE_END}`,
    "g",
  );
  for (const m of prose.matchAll(re)) {
    out.push({ person: m[1]!.trim(), descriptor: trimDescriptor(m[2]!), pattern: "appositive" });
  }
  return out;
}

function extractRelative(prose: string): RawClaim[] {
  const out: RawClaim[] = [];
  // "<Name> who <is/works/runs/founded …>"  — relative-clause role claim.
  const re = new RegExp(
    String.raw`(?<![\w'’-])(${NAME})\s+who\s+(${RELATIVE_VERB}\b.+?)${CLAUSE_END}`,
    "gi",
  );
  for (const m of prose.matchAll(re)) {
    out.push({ person: m[1]!.trim(), descriptor: trimDescriptor(m[2]!), pattern: "relative" });
  }
  // "<Name> <is/runs/founded …>" without "who" — direct role assertion.
  const reDirect = new RegExp(
    String.raw`(?<![\w'’-])(${NAME})\s+(${RELATIVE_VERB}\s+(?:an?|the)\s+.+?)${CLAUSE_END}`,
    "g",
  );
  for (const m of prose.matchAll(reDirect)) {
    out.push({ person: m[1]!.trim(), descriptor: trimDescriptor(m[2]!), pattern: "relative" });
  }
  return out;
}

function extractPossessive(prose: string): RawClaim[] {
  const out: RawClaim[] = [];
  // "<Org>'s <Name>"  — "Odisea's Cush", "Flashbots' Tina". The ORG is the
  // descriptor here (the affiliation claim is "Name belongs to Org").
  const re = new RegExp(
    String.raw`(?<![\w'’-])(${NAME})['’]s\s+(${NAME})(?![\w'’-])`,
    "g",
  );
  for (const m of prose.matchAll(re)) {
    const org = m[1]!.trim();
    const person = m[2]!.trim();
    // Skip when the "org" is itself a role noun ("the founder's name") — that's
    // not an affiliation claim about a named org.
    if (ROLE_NOUNS.has(org.toLowerCase())) continue;
    out.push({ person, descriptor: org, pattern: "possessive" });
  }
  return out;
}

function extractOfFrom(prose: string): RawClaim[] {
  const out: RawClaim[] = [];
  // "<Name> of <Org>" / "<Name> from <Place/Org>"  — affiliation/origin.
  const re = new RegExp(
    String.raw`(?<![\w'’-])(${NAME})\s+(of|from)\s+(${NAME})(?![\w'’-])`,
    "g",
  );
  for (const m of prose.matchAll(re)) {
    const person = m[1]!.trim();
    const prep = m[2]!.toLowerCase();
    const org = m[3]!.trim();
    if (!AFFILIATION_PREPS.has(prep)) continue;
    out.push({
      person,
      descriptor: org,
      pattern: prep === "from" ? "from-place" : "of-org",
    });
  }
  return out;
}

/**
 * Extract every person+descriptor claim in `prose` and ground-check each
 * descriptor's key terms against `source` (the raw transcript text).
 *
 * @param prose   The artifact's human-facing text — concatenate headline, body,
 *                quote, and attribution before calling (see helper below).
 * @param source  The source transcript's raw text (or the concatenation of all
 *                source transcripts, when an artifact draws from several).
 * @returns       One AttributionClaim per detected claim. grounded=false items
 *                are the ones an agent/critic must judge and strip or correct.
 *                Only SUBSTANTIVE descriptors (with a role noun or proper-noun
 *                org/place) are returned — generic adjectives are not claims.
 */
export function checkAttribution(prose: string, source: string): AttributionClaim[] {
  const haystack = normalize(source);
  const extractors = [
    extractDash,
    extractAppositive,
    extractRelative,
    extractPossessive,
    extractOfFrom,
  ];

  const raw: RawClaim[] = [];
  for (const extract of extractors) raw.push(...extract(prose));

  const claims: AttributionClaim[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!isSubstantiveDescriptor(r.descriptor)) continue;
    // De-dup identical (person, descriptor) across overlapping patterns.
    const dedupKey = `${r.person.toLowerCase()} ${r.descriptor.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const keyTerms = descriptorKeyTerms(r.descriptor);
    const missingTerms = keyTerms.filter((term) => !haystack.includes(normalize(term)));
    claims.push({
      person: r.person,
      descriptor: r.descriptor,
      pattern: r.pattern,
      grounded: missingTerms.length === 0,
      missingTerms,
    });
  }
  return claims;
}

/**
 * Convenience: pull the human-facing prose out of an artifact-shaped object
 * (headline + body + quote + attribution) into one string for checkAttribution.
 * source_quotes are NOT included — those are verbatim transcript text by
 * construction, not the artifact's own framing.
 */
export function artifactProse(artifact: {
  headline?: string;
  body?: string;
  quote?: string;
  attribution?: string;
}): string {
  return [artifact.headline, artifact.body, artifact.quote, artifact.attribution]
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .join("\n\n");
}
