import { createHash } from "node:crypto";
import {
  type CandidateArtifactEnvelope,
  type FeedArtifact,
  type FeedArtifactProjection,
  type FeedPost,
  type FeedItemProjection,
  type CandidateFeedPostEvidence,
  type FeedPostEvidence,
  type TranscriptSourceRef,
  type TrustedCandidateVerification,
  type FeedWorkflowPackage,
  type FeedWorkflowRun,
  type HashString,
  validateCandidateArtifactEnvelope,
  validateFeedArtifact,
  validateFeedItemProjection,
  canonicalFeedPostIdentity,
  canonicalEvidenceTextHash,
  deriveAccessPolicy,
} from "./feed-v1.ts";

export type SqlSeedRow = {
  table: string;
  values: Record<string, string | number | null>;
};

export type FeedV1Seed = {
  artifacts: SqlSeedRow[];
  feed: SqlSeedRow[];
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function legacyShape(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.raw_artifact !== undefined ||
    record.render_type !== undefined ||
    record.source_transcripts !== undefined ||
    record.artifact_id !== undefined ||
    record.action !== undefined
  );
}

export function assertNotLegacyFeedShape(value: unknown): void {
  if (legacyShape(value)) {
    throw new Error("legacy artifact/interactions shape is not accepted as native Feed v1 input");
  }
}

export function artifactIndexRow(artifact: FeedArtifact): SqlSeedRow {
  assertNotLegacyFeedShape(artifact);
  const validated = validateFeedArtifact(artifact);
  if (!validated.ok) throw new Error(`invalid FeedArtifact: ${validated.errors.join("; ")}`);
  return {
    table: "artifact_index",
    values: {
      artifact_id: artifact.artifactId,
      artifact_type: artifact.artifactType,
      package_id: artifact.producedBy.packageId,
      package_version: artifact.producedBy.packageVersion,
      package_digest: artifact.producedBy.packageDigest,
      run_id: artifact.producedBy.runId,
      source_fingerprint: artifact.idempotency.sourceFingerprint,
      artifact_fingerprint: artifact.idempotency.artifactFingerprint,
      dedupe_key: artifact.idempotency.dedupeKey,
      doc_key: artifact.storage.docKey,
      media_keys_json: json(artifact.storage.mediaKeys ?? []),
      created_at: artifact.createdAt,
      updated_at: artifact.updatedAt,
      published_at: artifact.createdAt,
    },
  };
}

export function projectionRow(projection: FeedArtifactProjection): SqlSeedRow {
  assertNotLegacyFeedShape(projection);
  return {
    table: "feed_artifact_projection",
    values: {
      artifact_id: projection.artifactId,
      rank_score: projection.rankScore,
      disposition: projection.disposition,
      visibility: projection.visibility,
      freshness_label: projection.freshnessLabel,
      reason_codes_json: json(projection.reasonCodes),
      package_id: projection.packageId,
      source_fingerprint: projection.sourceFingerprint,
      published_at: projection.publishedAt,
      updated_at: projection.updatedAt,
    },
  };
}

// Shared-spec serialization for migration fixtures only. Feed owns runtime
// projection, ranking, dual-write, and reconciliation behavior.
export function feedItemProjectionRow(projection: FeedItemProjection): SqlSeedRow {
  const validated = validateFeedItemProjection(projection);
  if (!validated.ok) throw new Error(`invalid FeedItemProjection: ${validated.errors.join("; ")}`);
  const postId = projection.target.kind === "post" ? projection.target.postId : null;
  return {
    table: "feed_item_projection",
    values: {
      feed_item_id: projection.feedItemId,
      target_kind: projection.target.kind,
      artifact_id: projection.target.artifactId,
      post_id: postId,
      rank_score: projection.rankScore,
      disposition: projection.disposition,
      visibility: projection.visibility,
      freshness_label: projection.freshnessLabel,
      reason_codes_json: json(projection.reasonCodes),
      package_id: projection.packageId,
      source_fingerprint: projection.sourceFingerprint,
      published_at: projection.publishedAt,
      updated_at: projection.updatedAt,
    },
  };
}

export function packageStateRow(pkg: FeedWorkflowPackage, updatedAt: string): SqlSeedRow {
  return {
    table: "workflow_package_state",
    values: {
      package_id: pkg.packageId,
      display_name: pkg.displayName,
      version: pkg.version,
      digest: pkg.digest,
      manifest_key: pkg.manifestKey,
      workflow_ref: pkg.workflowRef,
      workflow_digest: pkg.workflowDigest,
      admission_state: pkg.admissionState,
      disclosure_json: json(pkg.disclosure),
      enabled_at: pkg.admissionState === "enabled_local" || pkg.admissionState === "reviewed_first_party" ? updatedAt : null,
      paused_at: null,
      updated_at: updatedAt,
    },
  };
}

export function workflowRunRow(run: FeedWorkflowRun): SqlSeedRow {
  return {
    table: "workflow_run_index",
    values: {
      run_id: run.runId,
      package_id: run.packageId,
      package_digest: run.packageDigest,
      status: run.status,
      source_refs_json: json(run.sourceRefs),
      published_artifact_ids_json: json(run.publishedArtifactIds),
      dropped_candidates_json: json(run.droppedCandidates),
      spend_json: json(run.spend),
      error_json: run.error ? json(run.error) : null,
      started_at: run.startedAt,
      finished_at: run.finishedAt ?? null,
    },
  };
}

function sha256(value: string): HashString {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function copyEvidence(
  value: CandidateFeedPostEvidence,
  sourceRefs: TranscriptSourceRef[],
  verification: TrustedCandidateVerification,
): FeedPostEvidence {
  switch (value.kind) {
    case "verified_quote":
      const source = sourceRefs.find((ref) => ref.sourceRefId === value.sourceRefId);
      if (!source) throw new Error(`verified quote source not observed: ${value.sourceRefId}`);
      const proof = verification.verifiedQuotes.find((entry) =>
        entry.evidenceId === value.evidenceId &&
        entry.sourceRefId === value.sourceRefId &&
        entry.sourceObservedHash === source.observedHash &&
        entry.quoteHash === canonicalEvidenceTextHash(value.quote),
      );
      if (!proof) throw new Error(`verified quote lacks trusted worker proof: ${value.evidenceId}`);
      return {
        kind: value.kind,
        evidenceId: value.evidenceId,
        sourceRefId: value.sourceRefId,
        quote: value.quote,
        loc: value.loc,
        verification: {
          method: "worker_source_quote_match",
          sourceObservedHash: source.observedHash,
        },
      };
    case "located_source":
      return {
        kind: value.kind,
        evidenceId: value.evidenceId,
        sourceRefId: value.sourceRefId,
        loc: value.loc,
        excerpt: value.excerpt,
      };
    case "parent_artifact":
      return {
        kind: value.kind,
        evidenceId: value.evidenceId,
        artifactId: value.artifactId,
        sectionId: value.sectionId,
      };
    case "analytic_inference":
      return {
        kind: value.kind,
        evidenceId: value.evidenceId,
        rationale: value.rationale,
        supportedBy: [...value.supportedBy],
      };
  }
}

export function deriveFeedPosts(
  candidate: CandidateArtifactEnvelope,
  artifactId: string,
  verification: TrustedCandidateVerification,
): FeedPost[] | undefined {
  const sourceRefs = verification.trustedSourceRefs ?? candidate.sourceRefs;
  const parentArtifactRefs = verification.trustedParentArtifacts?.map(({ ref }) => ref) ?? candidate.parentArtifactRefs;
  return candidate.posts?.map((post) => {
    // Explicit construction is a trust boundary: unknown model-supplied
    // fields (including storage/media keys and durable IDs) are discarded.
    const safeFeedPost = {
      kind: post.kind,
      title: post.title,
      body: post.body,
      evidence: post.evidence.map((evidence) => copyEvidence(evidence, sourceRefs, verification)),
    };
    const identity = canonicalFeedPostIdentity(safeFeedPost, {
      sourceRefs,
      parentArtifactRefs,
    });
    return {
      ...safeFeedPost,
      ...identity,
      expansionTarget: {
        artifactId,
        sectionId: post.sectionId,
      },
    };
  });
}

// Worker-side idempotency assignment (spec §Idempotency): the skill supplies
// fingerprint material only; the Worker derives the durable keys, and
// dedupe_key = sha256(packageDigest + sourceFingerprint + artifactFingerprint).
export function assignCandidateIdempotency(
  candidate: CandidateArtifactEnvelope,
  packageDigest: string,
  verification: TrustedCandidateVerification = { verifiedQuotes: [] },
): FeedArtifact["idempotency"] {
  const sourceRefs = verification.trustedSourceRefs ?? candidate.sourceRefs;
  const parentArtifactRefs = verification.trustedParentArtifacts?.map(({ ref }) => ref) ?? candidate.parentArtifactRefs;
  const sourceFingerprint = sha256(JSON.stringify(candidate.idempotencyBasis.sourceFingerprintMaterial));
  const postFingerprints = (candidate.posts ?? [])
    .map((post) => canonicalFeedPostIdentity(post, {
      sourceRefs,
      parentArtifactRefs,
    }).postFingerprint)
    .sort();
  const artifactFingerprint = sha256(JSON.stringify({
    artifactFingerprintMaterial: candidate.idempotencyBasis.artifactFingerprintMaterial,
    postFingerprints,
  }));
  return {
    sourceFingerprint,
    artifactFingerprint,
    dedupeKey: sha256(packageDigest + sourceFingerprint + artifactFingerprint),
  };
}

export function candidateToArtifact(
  candidate: CandidateArtifactEnvelope,
  producedBy: FeedArtifact["producedBy"],
  now: string,
  verification: TrustedCandidateVerification = { verifiedQuotes: [] },
): FeedArtifact {
  const result = validateCandidateArtifactEnvelope(candidate);
  if (!result.ok) throw new Error(`invalid candidate artifact: ${result.errors.join("; ")}`);
  const artifactId = `${producedBy.runId}:${candidate.localCandidateId}`;
  const sourceRefs = verification.trustedSourceRefs ?? candidate.sourceRefs;
  const trustedParents = verification.trustedParentArtifacts ?? [];
  const parentArtifactRefs = verification.trustedParentArtifacts
    ? trustedParents.map(({ ref, derivedAccess }) => ({
      artifactId: ref.artifactId,
      artifactType: ref.artifactType,
      observedHash: ref.observedHash,
      derivedAccess,
    }))
    : candidate.parentArtifactRefs?.map((ref) => ({
      artifactId: ref.artifactId,
      artifactType: ref.artifactType,
      observedHash: ref.observedHash,
    }));
  return {
    schemaVersion: "feed.artifact.v1",
    artifactId,
    artifactType: candidate.artifactType,
    renderShape: candidate.renderShape,
    title: candidate.title,
    summary: candidate.summary,
    body: candidate.body,
    renderHints: candidate.renderHints,
    sourceRefs,
    feedSurface: candidate.feedSurface,
    derivedAccess: deriveAccessPolicy(sourceRefs, trustedParents.map(({ ref, derivedAccess }) => ({
      artifactId: ref.artifactId,
      derivedAccess,
    }))),
    posts: deriveFeedPosts(candidate, artifactId, verification),
    parentArtifactRefs,
    producedBy,
    freshness: { label: "fresh", asOf: now },
    idempotency: assignCandidateIdempotency(candidate, producedBy.packageDigest, verification),
    storage: { docKey: `runs/${producedBy.runId}/${candidate.localCandidateId}.json` },
    createdAt: now,
    updatedAt: now,
  };
}

export function buildGreenfieldSeed(input: {
  pkg: FeedWorkflowPackage;
  run: FeedWorkflowRun;
  artifact: FeedArtifact;
  projection: FeedArtifactProjection;
}): FeedV1Seed {
  return {
    artifacts: [
      packageStateRow(input.pkg, input.artifact.updatedAt),
      workflowRunRow(input.run),
      artifactIndexRow(input.artifact),
    ],
    feed: [projectionRow(input.projection)],
  };
}
