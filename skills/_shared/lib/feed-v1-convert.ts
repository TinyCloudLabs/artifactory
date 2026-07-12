// Convert a legacy Artifactory artifact (skills/_shared/lib/artifact.ts) into
// the Feed v1 contract (feed-v1.ts). Shared by the dev publish script and the
// feed-v1 worker so both bridges produce identical FeedArtifact documents.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Artifact } from "./artifact.ts";
import type { FeedArtifact, TranscriptSourceRef } from "./feed-v1.ts";
import { validateFeedArtifact } from "./feed-v1.ts";

export type FeedV1ConvertOptions = {
  // Legacy skill that produced the artifact, e.g. "extract-insights".
  skill?: string;
  // Stable run id; defaults to a digest-derived dev run id.
  runId?: string;
  // Disclosure copy shown to the user for this producer path.
  disclosureCopy?: string;
};

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function hashTranscript(path: string): Promise<string> {
  try {
    return sha256(await readFile(path, "utf8"));
  } catch {
    return sha256(path);
  }
}

function compactId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizeArtifactType(type: string): string {
  return type.replaceAll("-", "_");
}

function bodyForFeed(artifact: Artifact): Record<string, unknown> {
  return {
    markdown: artifact.body ?? artifact.quote ?? "",
    quote: artifact.quote,
    attribution: artifact.attribution,
    tags: artifact.tags,
    sourceQuotes: artifact.source_quotes ?? [],
    legacyArtifactId: artifact.id,
    legacyArtifactType: artifact.type,
  };
}

function summaryFor(artifact: Artifact): string | undefined {
  const source = artifact.body ?? artifact.quote;
  if (!source) return undefined;
  return source.replace(/\s+/g, " ").trim().slice(0, 240);
}

async function sourceRefsFor(artifact: Artifact, observedAt: string): Promise<TranscriptSourceRef[]> {
  return Promise.all(
    artifact.source_transcripts.map(async (path) => {
      const observedHash = await hashTranscript(path);
      return {
        sourceRefId: `local-transcript:${compactId(path)}`,
        sourceKind: "listen_conversation",
        sourceId: path,
        observedPath: "sql_transcript_text",
        observedHash,
        observedAt,
        quoteLineRefs: artifact.source_quotes
          ?.filter((quote) => quote.transcript === path)
          .map((quote) => quote.timestamp || quote.quote.slice(0, 80)),
      };
    }),
  );
}

export async function toFeedArtifact(artifact: Artifact, options: FeedV1ConvertOptions = {}): Promise<FeedArtifact> {
  const skill = options.skill ?? "extract-insights";
  const packageId = `artifactory.${skill}`;
  const now = new Date().toISOString();
  const createdAt = Number.isNaN(Date.parse(artifact.generated_at)) ? now : artifact.generated_at;
  const runId = options.runId ?? `run-dev-${skill}-${compactId(`${artifact.id}:${createdAt}`)}`;
  const packageDigest = sha256(`${packageId}@dev`);
  const sourceRefs = await sourceRefsFor(artifact, createdAt);
  const body = bodyForFeed(artifact);
  const sourceFingerprint = sha256(JSON.stringify(sourceRefs.map((source) => [source.sourceId, source.observedHash])));
  const artifactFingerprint = sha256(JSON.stringify({ headline: artifact.headline, body, generatedAt: artifact.generated_at }));
  const feedArtifact: FeedArtifact = {
    schemaVersion: "feed.artifact.v1",
    artifactId: `${runId}:${artifact.id}`,
    artifactType: normalizeArtifactType(artifact.type),
    renderShape: artifact.type === "article" || artifact.type === "digest" ? "longform" : "short_form",
    title: artifact.headline,
    summary: summaryFor(artifact),
    body,
    renderHints: { legacySkill: skill },
    sourceRefs,
    producedBy: {
      packageId,
      packageVersion: "dev",
      packageDigest,
      runId,
      runtimeClass: "local",
      providerClass: "none",
      credentialOwner: "none",
      egressClass: "none",
      disclosure: {
        userCopy: options.disclosureCopy ?? `Local dev import from the Artifactory ${skill} skill.`,
        credentialOwner: "none",
        providerClass: "none",
        egressClass: "none",
      },
    },
    freshness: {
      label: "fresh",
      asOf: createdAt,
      lastCheckedAt: now,
    },
    idempotency: {
      sourceFingerprint,
      artifactFingerprint,
      dedupeKey: sha256(`${packageDigest}:${sourceFingerprint}:${artifactFingerprint}`),
    },
    storage: {
      docKey: `runs/${runId}/${artifact.id}.json`,
    },
    createdAt,
    updatedAt: now,
  };

  const result = validateFeedArtifact(feedArtifact);
  if (!result.ok) {
    throw new Error(`Converted Feed artifact is invalid:\n  - ${result.errors.join("\n  - ")}`);
  }
  return result.value;
}
