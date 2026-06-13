// digest.ts — deterministic helpers for the write-digest skill.
//
// Everything here is plumbing: validation and artifact persistence. The
// editorial judgment (thread selection, weaving, critic pass) belongs to the
// agent reading SKILL.md — no model calls happen in this file or in any
// script that imports it.

import {
  newArtifactId,
  validateArtifact,
  writeArtifact,
  type WrittenArtifact,
} from "../../_shared/lib/artifact.ts";

export { verifyArtifactQuotes, type QuoteFailure } from "../../_shared/lib/quotes.ts";

/**
 * Target editorial length; outside this range save warns (non-fatal). A
 * digest sits between an insight card and an article: one synthesis across
 * threads, no sections, no throat-clearing.
 */
export const TARGET_WORDS_MIN = 300;
export const TARGET_WORDS_MAX = 500;

export interface SavedDigest {
  written: WrittenArtifact;
  wordCount: number;
  warnings: string[];
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Normalize, validate, and persist a digest artifact. Writes
 * <outDir>/digest/<slug>/artifact.json plus body.md alongside it. Throws on
 * contract violations.
 *
 * Digest-specific rules on top of the shared contract:
 * - type must be "digest" (defaulted when missing);
 * - body is required (the digest *is* the body);
 * - at least 2 source_transcripts — a digest is a MULTI-thread roundup by
 *   definition; a single-transcript synthesis is an insight card's job;
 * - hero_image: null is stripped — illustrate-card fills it in later.
 */
export async function saveDigest(
  raw: Record<string, unknown>,
  opts: { outDir?: string } = {},
): Promise<SavedDigest> {
  raw.id ??= newArtifactId();
  raw.generated_at ??= new Date().toISOString();
  raw.type ??= "digest";
  if (raw.type !== "digest") {
    throw new Error(`write-digest only saves type "digest" (got "${String(raw.type)}")`);
  }
  if (raw.hero_image === null) delete raw.hero_image;

  if (typeof raw.body !== "string" || !raw.body.trim()) {
    throw new Error("digest artifacts require a non-empty markdown body");
  }
  if (!Array.isArray(raw.source_transcripts) || raw.source_transcripts.length < 2) {
    throw new Error(
      "digest artifacts require >= 2 source_transcripts — a digest weaves multiple threads; a single-transcript synthesis belongs to extract-insights",
    );
  }

  const result = validateArtifact(raw);
  if (!result.ok) {
    throw new Error(`Artifact failed contract validation:\n  - ${result.errors.join("\n  - ")}`);
  }

  const body = result.artifact.body ?? "";
  const wordCount = countWords(body);
  const warnings: string[] = [];
  if (wordCount < TARGET_WORDS_MIN || wordCount > TARGET_WORDS_MAX) {
    warnings.push(
      `body is ${wordCount} words; target is ~${TARGET_WORDS_MIN}-${TARGET_WORDS_MAX}`,
    );
  }

  const written = await writeArtifact(result.artifact, {
    outDir: opts.outDir,
    media: { "body.md": new TextEncoder().encode(body.endsWith("\n") ? body : body + "\n") },
  });
  return { written, wordCount, warnings };
}
