// Validation + drop-audit seam. Wraps the FeedArtifact validators declared in
// skills/_shared/lib/feed-v1.ts and records the reason for each dropped
// candidate so runs can be replayed with the same audit trail.

import {
  validateCandidateArtifactEnvelope,
  canonicalEvidenceTextHash,
  type CandidateArtifactEnvelope,
  type ArtifactInputRef,
  type DerivedAccessPolicy,
  type TranscriptSourceRef,
  type TrustedCandidateVerification,
} from "../../../skills/_shared/lib/feed-v1.ts";

export type DroppedCandidate = {
  reason: string;
  title?: string;
  localCandidateId?: string;
};

export type ValidationOutcome = {
  accepted: Array<{
    candidate: CandidateArtifactEnvelope;
    verification: TrustedCandidateVerification;
  }>;
  dropped: DroppedCandidate[];
};

export type DropAudit = {
  record(runId: string, entry: DroppedCandidate): void;
  list(runId: string): DroppedCandidate[];
};

export function createInMemoryDropAudit(): DropAudit {
  const byRun = new Map<string, DroppedCandidate[]>();
  return {
    record(runId, entry) {
      const current = byRun.get(runId) ?? [];
      current.push({ ...entry });
      byRun.set(runId, current);
    },
    list(runId) {
      return (byRun.get(runId) ?? []).map((entry) => ({ ...entry }));
    },
  };
}

export function serializeTranscriptSourceRef(ref: TranscriptSourceRef): string {
  return JSON.stringify({
    sourceRefId: ref.sourceRefId,
    sourceKind: ref.sourceKind,
    sourceId: ref.sourceId,
    observedPath: ref.observedPath,
    observedHash: ref.observedHash,
    observedAt: ref.observedAt,
    quoteLineRefs: ref.quoteLineRefs,
    authority: ref.authority,
  });
}

function serializeArtifactInputRef(ref: ArtifactInputRef): string {
  return JSON.stringify({
    kind: ref.kind,
    artifactId: ref.artifactId,
    artifactType: ref.artifactType,
    observedHash: ref.observedHash,
    observedAt: ref.observedAt,
  });
}

export function validateCandidates(
  candidates: unknown[],
  options: {
    runId: string;
    audit: DropAudit;
    maxAccepted: number;
    /** Trusted refs the worker actually observed. Candidate refs must match
     * these exactly, including authority metadata, and are reconstructed from
     * this map before publication. */
    trustedSourceRefs: ReadonlyMap<string, TranscriptSourceRef>;
    trustedParentArtifacts?: ReadonlyMap<string, {
      ref: ArtifactInputRef;
      derivedAccess: DerivedAccessPolicy;
    }>;
    sourceExcerpts?: ReadonlyMap<string, readonly string[]>;
  },
): ValidationOutcome {
  const accepted: ValidationOutcome["accepted"] = [];
  const dropped: DroppedCandidate[] = [];

  for (const raw of candidates) {
    if (accepted.length >= options.maxAccepted) {
      const drop: DroppedCandidate = {
        reason: "max_accepted_reached",
        localCandidateId: readLocalId(raw),
        title: readTitle(raw),
      };
      dropped.push(drop);
      options.audit.record(options.runId, drop);
      continue;
    }
    const result = validateCandidateArtifactEnvelope(raw, { context: "new_workflow_execution" });
    if (!result.ok) {
      const drop: DroppedCandidate = {
        reason: `validation:${result.errors.join(";")}`,
        localCandidateId: readLocalId(raw),
        title: readTitle(raw),
      };
      dropped.push(drop);
      options.audit.record(options.runId, drop);
      continue;
    }
    const trustedParents = result.value.parentArtifactRefs?.map((ref) =>
      options.trustedParentArtifacts?.get(ref.artifactId),
    ) ?? [];
    const untrustedParentIndex = trustedParents.findIndex((parent, index) =>
      !parent || serializeArtifactInputRef(parent.ref) !== serializeArtifactInputRef(result.value.parentArtifactRefs![index]!),
    );
    if (untrustedParentIndex !== -1) {
      const ref = result.value.parentArtifactRefs![untrustedParentIndex]!;
      const drop: DroppedCandidate = {
        reason: `provenance:parent_artifact_not_in_artifact_pack:${ref.artifactId}`,
        localCandidateId: result.value.localCandidateId,
        title: result.value.title,
      };
      dropped.push(drop);
      options.audit.record(options.runId, drop);
      continue;
    }
    const unknownRef = result.value.sourceRefs.find((ref) => {
      const trusted = options.trustedSourceRefs.get(ref.sourceRefId);
      return !trusted || serializeTranscriptSourceRef(trusted) !== serializeTranscriptSourceRef(ref);
    });
    if (unknownRef) {
      const drop: DroppedCandidate = {
        reason: `provenance:source_ref_not_in_source_pack:${unknownRef.sourceRefId}`,
        localCandidateId: result.value.localCandidateId,
        title: result.value.title,
      };
      dropped.push(drop);
      options.audit.record(options.runId, drop);
      continue;
    }
    const verification = verifyCandidateQuotes(
      result.value,
      options.trustedSourceRefs,
      options.sourceExcerpts,
    );
    if (!verification.ok) {
      const drop: DroppedCandidate = {
        reason: `provenance:${verification.reason}`,
        localCandidateId: result.value.localCandidateId,
        title: result.value.title,
      };
      dropped.push(drop);
      options.audit.record(options.runId, drop);
      continue;
    }
    accepted.push({
      candidate: result.value,
      verification: {
        ...verification.value,
        trustedSourceRefs: result.value.sourceRefs.map((ref) => options.trustedSourceRefs.get(ref.sourceRefId)!),
        trustedParentArtifacts: trustedParents.flatMap((parent) => parent ? [parent] : []),
      },
    });
  }

  return { accepted, dropped };
}

function normalizeQuoteText(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function verifyCandidateQuotes(
  candidate: CandidateArtifactEnvelope,
  trustedSourceRefs: ReadonlyMap<string, TranscriptSourceRef> | undefined,
  sourceExcerpts: ReadonlyMap<string, readonly string[]> | undefined,
): { ok: true; value: TrustedCandidateVerification } | { ok: false; reason: string } {
  const verifiedQuotes: TrustedCandidateVerification["verifiedQuotes"] = [];
  for (const post of candidate.posts ?? []) {
    for (const evidence of post.evidence) {
      if (evidence.kind !== "verified_quote") continue;
      const source = trustedSourceRefs?.get(evidence.sourceRefId);
      const quote = normalizeQuoteText(evidence.quote);
      const matched = sourceExcerpts?.get(evidence.sourceRefId)?.some((excerpt) =>
        normalizeQuoteText(excerpt).includes(quote),
      );
      if (!source || quote.length === 0 || !matched) {
        return { ok: false, reason: `verified_quote_not_in_source_pack:${evidence.evidenceId}` };
      }
      verifiedQuotes.push({
        evidenceId: evidence.evidenceId,
        sourceRefId: evidence.sourceRefId,
        sourceObservedHash: source.observedHash,
        quoteHash: canonicalEvidenceTextHash(evidence.quote),
      });
    }
  }
  return { ok: true, value: { verifiedQuotes } };
}

function readLocalId(value: unknown): string | undefined {
  if (value && typeof value === "object" && "localCandidateId" in value) {
    const id = (value as { localCandidateId: unknown }).localCandidateId;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

function readTitle(value: unknown): string | undefined {
  if (value && typeof value === "object" && "title" in value) {
    const title = (value as { title: unknown }).title;
    return typeof title === "string" ? title : undefined;
  }
  return undefined;
}
