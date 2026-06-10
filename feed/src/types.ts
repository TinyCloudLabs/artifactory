// Feed-side mirror of the distillery artifact contract
// (skills/_shared/lib/artifact.ts). Deliberately tolerant: the feed renders
// whatever artifacts the skills produce, including types it hasn't seen,
// so `type` is an open string here and most fields are optional.

export interface SourceQuote {
  quote: string;
  speaker?: string;
  transcript: string;
  timestamp?: string;
}

export interface ArtifactQuality {
  critic_pass: boolean;
  quotes_verified: boolean;
  notes?: string;
}

export interface Artifact {
  id: string;
  type: string;
  headline: string;
  body?: string;
  quote?: string;
  attribution?: string;
  tags: string[];
  source_transcripts: string[];
  source_quotes?: SourceQuote[];
  /** Media file names relative to the artifact's own folder. */
  hero_image?: string;
  audio?: string;
  generated_at: string; // ISO 8601
  generation_model?: string;
  quality?: ArtifactQuality;
}

/** What the API serves: artifact + addressing + resolved media URLs. */
export interface FeedCard extends Artifact {
  /** Directory name under artifacts/<type>/ — stable address for routing. */
  slug: string;
  hero_image_url?: string;
  audio_url?: string;
}

export interface CardsResponse {
  cards: FeedCard[];
  total: number;
  offset: number;
  hasMore: boolean;
}
