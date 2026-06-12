// person-brief.ts — deterministic helpers for the person-brief skill.
//
// person-brief is the POSITIVE use of the identity machinery the rest of this
// repo uses to PREVENT leaks. Here the goal is a grounded pre-meeting dossier:
// who a person is, their role/affiliation, what they have actually SAID across
// meetings, the positions they hold, their relationship to TinyCloud, and the
// open threads with them. The discipline that makes the Cush incident a failure
// elsewhere is the LOAD-BEARING feature here: every claim about the person must
// be transcript-grounded and cited; any inference is marked explicitly; a
// role/affiliation is NEVER fabricated.
//
// This file is the DETERMINISTIC half — pure plumbing, no model calls:
//   - gatherPersonMentions: scan a corpus for a person by name and return,
//     per transcript, the turns they SPOKE and the turns that MENTION them by
//     name, plus the metadata (date, title, participants, co-speakers) the agent
//     needs to ground claims. It surfaces RAW EVIDENCE; it draws no conclusions.
//   - renderDossierMarkdown: render that evidence as a readable survey the agent
//     reads before writing the brief.
//   - verifyArtifactQuotes / saveBrief: the same verify + persist contract the
//     other skills use, specialized to type "person-brief".
//
// The judgment — deciding which facts are grounded, what is an inference vs a
// fact, organizing the brief, marking "likely…" — is the AGENT's, in SKILL.md.
// Nothing here interprets; it only finds and formats the mentions.
//
// Plain TS, no deps beyond the shared libs — same constraint as the rest.

import { readFile } from "node:fs/promises";
import {
  parseTranscript,
  transcriptDuration,
  verifyQuote,
  type Transcript,
  type TranscriptTurn,
} from "../../_shared/lib/transcript.ts";
import {
  newArtifactId,
  validateArtifact,
  writeArtifact,
  type SourceQuote,
  type WrittenArtifact,
} from "../../_shared/lib/artifact.ts";
import { isStopword } from "../../_shared/lib/stopwords.ts";

// ---------------------------------------------------------------------------
// Name matching — deterministic, conservative
// ---------------------------------------------------------------------------

/**
 * Normalize a name for matching: lowercase, collapse whitespace, drop a
 * trailing parenthetical affiliation a diarizer sometimes appends
 * ("Tina (Flashbots)" → "tina (flashbots)" stays, but we ALSO index the bare
 * "tina"). Punctuation around the name is trimmed.
 */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The set of strings a speaker label or a mention should match against for a
 * queried name. For "Samuel Gbafa" this is {"samuel gbafa", "samuel", "gbafa"};
 * we keep the full name AND each component word so a diarizer that labels turns
 * "Samuel" still matches, and a mention of just a last name is caught. Single
 * very-short tokens (< 2 chars) are dropped to avoid matching initials as words.
 */
export function nameVariants(name: string): string[] {
  const full = norm(name);
  const variants = new Set<string>();
  if (full) variants.add(full);
  for (const word of full.split(" ")) {
    if (word.length >= 2) variants.add(word);
  }
  return [...variants];
}

/**
 * The variants safe to scan FREE TEXT against. Single-token components that are
 * generic English words (a stopword like "here", "may", "will") are dropped —
 * matching a lone "here" inside prose is a false positive that would attribute
 * random turns to the person. The full multi-word name is always kept (it is
 * never a stopword), so a name whose only components are common words ("May
 * Day") still matches as a whole phrase, just not on its lone tokens. Speaker-
 * LABEL matching keeps the full variant set (it is strict on the WHOLE label,
 * where a lone "May" can only match a speaker actually labeled "May").
 */
export function textMatchVariants(variants: string[]): string[] {
  return variants.filter((v) => v.includes(" ") || !isStopword(v));
}

/**
 * Does a speaker label denote the queried person? A speaker turn is attributed
 * to the person when the (normalized) label equals the full name OR the label,
 * stripped of any trailing "(affiliation)", equals the full name, OR the label
 * is a single token that equals a name component. We are deliberately STRICT on
 * the speaker side (this asserts "the person spoke these words"): a bare last
 * name matches only when it is the WHOLE label, never a substring, so "Sam"
 * never silently captures "Samantha".
 *
 * Note: a speaker-label match proves the diarizer ATTRIBUTED the words to this
 * label — not that the real human said them. Diarization can be wrong; the
 * SKILL.md surfaces that caveat and the agent records it.
 */
export function speakerIsPerson(label: string | undefined, variants: string[]): boolean {
  if (!label) return false;
  const l = norm(label);
  const stripped = l.replace(/\s*\([^)]*\)\s*$/, "").trim(); // drop "(Flashbots)"
  return variants.includes(l) || variants.includes(stripped);
}

/**
 * Does a turn's TEXT mention the queried person by name? Matches the full name
 * as a whole-word phrase first (high confidence). A single-component match
 * (just "Gbafa", or just "Samuel") is also reported but flagged lower-confidence
 * by the caller, because a lone first name is ambiguous. We match on word
 * boundaries so "Sam" does not hit inside "Samantha"/"same".
 *
 * Returns the matched variant (the longest one that hit), or null.
 */
export function mentionInText(text: string, variants: string[]): string | null {
  const hay = ` ${norm(text)} `;
  // Prefer the longest variant (the full name) so a full-name hit is reported
  // as such rather than as a first-name-only hit.
  const ordered = [...variants].sort((a, b) => b.length - a.length);
  for (const v of ordered) {
    // Whole-word/phrase match: bounded by non-word chars.
    const re = new RegExp(`(?:^|[^\\w'])${escapeRe(v)}(?:[^\\w']|$)`, "i");
    if (re.test(hay)) return v;
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Gather — the dossier survey
// ---------------------------------------------------------------------------

/** A turn the person SPOKE (per the diarizer's label). */
export interface SpokenTurn {
  index: number;
  timestamp?: string;
  /** The verbatim spoken text — a candidate source_quote. */
  text: string;
  /** The diarizer's raw speaker label (may carry "(affiliation)"). */
  speakerLabel: string;
}

/** A turn (spoken by someone ELSE) whose TEXT names the person. */
export interface MentionTurn {
  index: number;
  timestamp?: string;
  /** Who said it (the OTHER speaker), per the diarizer. */
  speaker?: string;
  /** The verbatim text containing the mention — a candidate source_quote. */
  text: string;
  /** Which name variant matched. "full" when the whole name hit; else the token. */
  matchedVariant: string;
  /** True when the full queried name matched (high confidence vs a lone token). */
  fullNameMatch: boolean;
}

/** Everything found about the person in ONE transcript. */
export interface TranscriptMentions {
  path: string;
  title?: string;
  date?: string;
  source?: string;
  duration?: string;
  /** The transcript's declared participants (a header field — not spoken). */
  participants?: string[];
  /** True when the person's name appears in the participants header. */
  inParticipants: boolean;
  /** Turns the diarizer attributed to the person. */
  spoke: SpokenTurn[];
  /** Turns by OTHERS that mention the person by name. */
  mentions: MentionTurn[];
  /** Other speakers present in this transcript (co-occurrence — context only). */
  coSpeakers: string[];
}

export interface PersonDossier {
  /** The queried name, as given. */
  name: string;
  /** The variants used for matching (full name + component words). */
  variants: string[];
  /** Per-transcript evidence, newest first (undated last). */
  transcripts: TranscriptMentions[];
  /** Convenience totals (raw counts — NOT conclusions). */
  totals: {
    transcriptsWithEvidence: number;
    transcriptsSpoken: number;
    spokenTurns: number;
    mentionTurns: number;
  };
}

/**
 * Scan a set of parsed transcripts for the named person and return the raw
 * evidence dossier. Deterministic: same transcripts + name in, same dossier out.
 * Draws NO conclusions — it finds the turns the person spoke, the turns that
 * name them, the participant-header appearances, and the co-speakers, and hands
 * them to the agent. Transcripts with no evidence at all are omitted.
 *
 * A transcript flagged empty (no spoken content) yields no spoken/mention turns
 * but can still contribute a participants-header appearance (a header fact, not
 * a spoken one) — the agent treats that as "listed as a participant", never as
 * "said X".
 */
export function gatherPersonMentions(
  transcripts: Transcript[],
  name: string,
): PersonDossier {
  const variants = nameVariants(name);
  const textVariants = textMatchVariants(variants);
  const full = norm(name);
  const out: TranscriptMentions[] = [];

  for (const t of transcripts) {
    const spoke: SpokenTurn[] = [];
    const mentions: MentionTurn[] = [];
    const coSpeakers = new Set<string>();

    t.turns.forEach((turn: TranscriptTurn, index: number) => {
      const isPerson = speakerIsPerson(turn.speaker, variants);
      if (isPerson) {
        spoke.push({
          index,
          timestamp: turn.timestamp,
          text: turn.text,
          speakerLabel: turn.speaker!,
        });
      } else {
        if (turn.speaker) coSpeakers.add(turn.speaker.trim());
        // Only scan OTHER speakers' turns for mentions — the person referring to
        // themselves in the third person is rare and noisy; their own turns are
        // already captured as spoken evidence.
        const matched = mentionInText(turn.text, textVariants);
        if (matched) {
          mentions.push({
            index,
            timestamp: turn.timestamp,
            speaker: turn.speaker,
            text: turn.text,
            matchedVariant: matched,
            fullNameMatch: matched === full,
          });
        }
      }
    });

    const inParticipants =
      (t.participants ?? []).some((p) => {
        const np = norm(p);
        // Participant header values are often emails (samuel@x.com) or names.
        // Match the full name, a name component as a whole word, or the local
        // part of an email containing a name component.
        return (
          variants.includes(np) ||
          textVariants.some((v) => new RegExp(`(?:^|[^\\w'])${escapeRe(v)}(?:[^\\w']|$)`, "i").test(` ${np} `))
        );
      });

    if (spoke.length === 0 && mentions.length === 0 && !inParticipants) continue;

    out.push({
      path: t.path,
      title: t.title,
      date: t.date,
      source: t.source,
      duration: transcriptDuration(t),
      participants: t.participants,
      inParticipants,
      spoke,
      mentions,
      coSpeakers: [...coSpeakers].sort((a, b) => a.localeCompare(b)),
    });
  }

  // Newest first (undated last), then path — same ordering convention as
  // query-corpus, so the agent reads recent context first.
  out.sort((a, b) => {
    const da = a.date ?? "";
    const db = b.date ?? "";
    if (da !== db) return da < db ? 1 : -1;
    return a.path.localeCompare(b.path);
  });

  return {
    name,
    variants,
    transcripts: out,
    totals: {
      transcriptsWithEvidence: out.length,
      transcriptsSpoken: out.filter((tm) => tm.spoke.length > 0).length,
      spokenTurns: out.reduce((n, tm) => n + tm.spoke.length, 0),
      mentionTurns: out.reduce((n, tm) => n + tm.mentions.length, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// Render the dossier — readable survey for the agent
// ---------------------------------------------------------------------------

function excerpt(text: string, max = 400): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

/**
 * Render the dossier as a markdown survey the agent reads before drafting. It
 * lays out, per transcript: metadata, whether the person was a listed
 * participant, every turn they spoke (candidate quotes), and every turn that
 * mentions them. It states plainly that these are RAW mentions, that speaker
 * attribution is the diarizer's (and can be wrong), and that lone-first-name
 * mentions are low-confidence — so the agent grounds and marks accordingly.
 */
export function renderDossierMarkdown(dossier: PersonDossier): string {
  const out: string[] = [];
  out.push(`# Person dossier survey: ${dossier.name}`);
  out.push("");
  out.push(
    "RAW EVIDENCE ONLY — no conclusions drawn here. This lists the turns the" +
      " person spoke, the turns that name them, and the participant-header" +
      " appearances. Ground EVERY claim in the brief against this evidence and" +
      " cite it. Speaker labels are the diarizer's and CAN be wrong (verification" +
      " proves the words were said, not who said them). A lone first-name match" +
      " is low-confidence — confirm it really refers to this person before using it.",
  );
  out.push("");
  out.push(`- name variants matched: ${dossier.variants.join(", ")}`);
  out.push(
    `- transcripts with evidence: ${dossier.totals.transcriptsWithEvidence}` +
      ` (spoke in ${dossier.totals.transcriptsSpoken})`,
  );
  out.push(
    `- spoken turns: ${dossier.totals.spokenTurns} · mention turns: ${dossier.totals.mentionTurns}`,
  );

  if (dossier.transcripts.length === 0) {
    out.push("");
    out.push(
      "## No evidence found\n\nThe name does not appear as a speaker, in any" +
        " turn text, or in any participants header across the supplied corpus." +
        " A grounded brief is not possible — say so and output nothing rather" +
        " than fabricate. (Check spelling / try a name variant before concluding.)",
    );
    out.push("");
    return out.join("\n");
  }

  for (const tm of dossier.transcripts) {
    out.push("");
    out.push(`## ${tm.date ?? "(undated)"} — ${tm.title ?? tm.path}`);
    out.push("");
    out.push(`- path: \`${tm.path}\``);
    if (tm.source) out.push(`- source: ${tm.source}`);
    if (tm.duration) out.push(`- duration: ${tm.duration}`);
    out.push(`- listed as participant: ${tm.inParticipants ? "yes" : "no"}`);
    if (tm.participants?.length) {
      out.push(`- participants header: ${tm.participants.join(", ")}`);
    }
    if (tm.coSpeakers.length) {
      out.push(`- other speakers present: ${tm.coSpeakers.join(", ")}`);
    }

    if (tm.spoke.length) {
      out.push("");
      out.push(`### Spoke (${tm.spoke.length} turn(s)) — candidate quotes`);
      out.push("");
      for (const s of tm.spoke) {
        const ts = s.timestamp ? ` (${s.timestamp})` : "";
        out.push(`- [turn ${s.index}${ts}] **${s.speakerLabel}:** ${excerpt(s.text)}`);
      }
    }

    if (tm.mentions.length) {
      out.push("");
      out.push(`### Mentioned by others (${tm.mentions.length} turn(s))`);
      out.push("");
      for (const m of tm.mentions) {
        const ts = m.timestamp ? ` (${m.timestamp})` : "";
        const conf = m.fullNameMatch ? "full-name" : `partial: "${m.matchedVariant}" (low-confidence)`;
        out.push(
          `- [turn ${m.index}${ts}] **${m.speaker ?? "(unknown)"}** [${conf}]: ${excerpt(m.text)}`,
        );
      }
    }
  }

  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Quote verification — same contract as the other skills
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
 * Proves the TEXT was spoken — not who spoke it (diarization can mislabel).
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
// Save — validate + persist artifact.json with brief.md alongside
// ---------------------------------------------------------------------------

export interface SavedBrief {
  written: WrittenArtifact;
  warnings: string[];
}

/**
 * Normalize, validate, and persist a person-brief artifact. Writes
 * <outDir>/person-brief/<slug>/artifact.json plus brief.md (the dossier body)
 * alongside it. Throws on contract violations.
 *
 * person-brief-specific rules on top of the shared contract:
 * - type must be "person-brief" (defaulted when missing);
 * - body is required (the brief IS the dossier prose);
 * - audience defaults to "internal" — a person-brief is your pre-meeting prep
 *   doc. It is still an OUTWARD type in the contract sense (it names a real
 *   person), so it gates at approval_status "pending" by default (the contract
 *   defaults this). The lighter abstraction reflects the internal audience, but
 *   the no-fabrication rule is absolute regardless of audience;
 * - hero_image: null is stripped (briefs are not illustrated).
 *
 * A person-brief MUST carry source_quotes — a dossier with zero grounded
 * anchors is exactly the fabrication failure this skill exists to prevent — so
 * an empty source_quotes list is rejected here (verify-quotes also fails it).
 */
export async function saveBrief(
  raw: Record<string, unknown>,
  opts: { outDir?: string } = {},
): Promise<SavedBrief> {
  raw.id ??= newArtifactId();
  raw.generated_at ??= new Date().toISOString();
  raw.type ??= "person-brief";
  if (raw.type !== "person-brief") {
    throw new Error(`person-brief only saves type "person-brief" (got "${String(raw.type)}")`);
  }
  raw.audience ??= "internal";
  if (raw.hero_image === null) delete raw.hero_image;

  if (typeof raw.body !== "string" || !raw.body.trim()) {
    throw new Error("person-brief artifacts require a non-empty markdown body");
  }

  const quotes = raw.source_quotes;
  if (!Array.isArray(quotes) || quotes.length === 0) {
    throw new Error(
      "person-brief artifacts require source_quotes — every claim about the" +
        " person must be transcript-grounded. An empty list is the fabrication" +
        " failure this skill prevents.",
    );
  }

  const result = validateArtifact(raw);
  if (!result.ok) {
    throw new Error(`Artifact failed contract validation:\n  - ${result.errors.join("\n  - ")}`);
  }

  const body = result.artifact.body ?? "";
  const warnings: string[] = [];

  const written = await writeArtifact(result.artifact, {
    outDir: opts.outDir,
    media: { "brief.md": new TextEncoder().encode(body.endsWith("\n") ? body : body + "\n") },
  });
  return { written, warnings };
}
