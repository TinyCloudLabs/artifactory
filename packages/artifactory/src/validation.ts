// Validation + drop-audit seam. Wraps the FeedArtifact validators declared in
// skills/_shared/lib/feed-v1.ts and records the reason for each dropped
// candidate so runs can be replayed with the same audit trail.

import {
  validateCandidateArtifactEnvelope,
  type CandidateArtifactEnvelope,
} from "../../../skills/_shared/lib/feed-v1.ts";

export type DroppedCandidate = {
  reason: string;
  title?: string;
  localCandidateId?: string;
};

export type ValidationOutcome = {
  accepted: CandidateArtifactEnvelope[];
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

export function validateCandidates(
  candidates: unknown[],
  options: { runId: string; audit: DropAudit; maxAccepted: number },
): ValidationOutcome {
  const accepted: CandidateArtifactEnvelope[] = [];
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
    const result = validateCandidateArtifactEnvelope(raw);
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
    accepted.push(result.value);
  }

  return { accepted, dropped };
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
