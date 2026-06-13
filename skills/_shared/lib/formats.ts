// formats.ts — the FORMAT REGISTRY: the single source of truth for which
// artifact formats exist and how each one behaves. Everything that needs a
// format list derives it from here — the artifact contract (validation), the
// harness's outward/internal routing, the exploration slot's eligible-format
// list, the brief's miner roster, and the feed UI's kicker labels. Adding a
// format means adding ONE entry here (plus its skill); nothing else should
// need a hand-maintained list.
//
// BROWSER-SAFE ON PURPOSE: the feed's web bundle imports this file for
// labels, so it must stay pure data — no node builtins, no imports. The
// fs-bound artifact helpers live in artifact.ts, which re-exports this
// registry for script-side consumers.

export const ARTIFACT_TYPES = [
  "insight-card",
  "article",
  "podcast",
  // Multi-thread roundup: shorter than an article (~300-500 words), weaves
  // 2-3 related threads from across the corpus. Internal — always publishes.
  "digest",
  // Short video clip (~15s) compiled narrative -> storyboard sheet -> video
  // (make-clip). Internal — always publishes. Media is the mp4 + poster frame.
  "clip",
  // Phase-2 outward-facing comms types. These default to approval_status
  // "pending" (see validateArtifact) — nothing outward-facing auto-publishes.
  "social-post",
  "investor-update-snippet",
  "quote-card",
  "person-brief",
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface FormatMeta {
  /** Human kicker label the feed UI shows. */
  label: string;
  /**
   * Outward-facing formats gate at a human-approval step before they can
   * ship; internal formats always publish. (person-brief is the straddler:
   * outward-typed for the approval gate, but its audience stamp is
   * "internal" so approved briefs publish to the feed and count the cap.)
   */
  outward: boolean;
  /**
   * The skill that produces this format on the feed-run's main generation
   * path, or null when production is triggered elsewhere (person-brief: the
   * salience detector, not the per-run miner roster).
   */
  miner: string | null;
  /**
   * Eligible for the harness's format-exploration slot — the internal feed
   * miner formats. person-brief publishes internally but is salience-
   * triggered, so the slot never nudges it.
   */
  explorable: boolean;
}

export const FORMAT_REGISTRY = {
  "insight-card": { label: "Insight", outward: false, miner: "extract-insights", explorable: true },
  article: { label: "Article", outward: false, miner: "write-article", explorable: true },
  podcast: { label: "Podcast", outward: false, miner: "make-podcast", explorable: true },
  digest: { label: "Digest", outward: false, miner: "write-digest", explorable: true },
  clip: { label: "Clip", outward: false, miner: "make-clip", explorable: true },
  "social-post": { label: "Social post", outward: true, miner: "banger-extractor", explorable: false },
  "investor-update-snippet": { label: "Investor snippet", outward: true, miner: "investor-snippet", explorable: false },
  "quote-card": { label: "Quote card", outward: true, miner: "quote-card", explorable: false },
  "person-brief": { label: "Person brief", outward: true, miner: null, explorable: false },
} as const satisfies Record<ArtifactType, FormatMeta>;

/** Outward-facing types gate at a human-approval step before they can ship. */
export const OUTWARD_ARTIFACT_TYPES: readonly ArtifactType[] = ARTIFACT_TYPES.filter(
  (t) => FORMAT_REGISTRY[t].outward,
);

export function isOutwardType(type: ArtifactType): boolean {
  return FORMAT_REGISTRY[type].outward;
}

/** The formats the exploration slot may nudge, as a literal union. */
export type ExplorableFormat = {
  [K in ArtifactType]: (typeof FORMAT_REGISTRY)[K]["explorable"] extends true ? K : never;
}[ArtifactType];

export const EXPLORABLE_FORMATS: readonly ExplorableFormat[] = ARTIFACT_TYPES.filter(
  (t): t is ExplorableFormat => FORMAT_REGISTRY[t].explorable,
);
