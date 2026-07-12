import { createHash } from "node:crypto";
import {
  validateTranscriptSourceRef,
  type ArtifactInputRef,
  type DerivedAccessPolicy,
  type HashString,
  type SkillRunInput,
} from "../../../skills/_shared/lib/feed-v1.ts";

type ArtifactPack = NonNullable<SkillRunInput["artifactPack"]>;
type ArtifactPackRecord = ArtifactPack["artifacts"][number];

export type BoundArtifactPack = {
  digest: HashString;
  runtimePack: ArtifactPack;
  trustedParentArtifacts: ReadonlyMap<string, {
    ref: ArtifactInputRef;
    derivedAccess: DerivedAccessPolicy;
  }>;
};

export class ArtifactPackValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`artifactPack validation failed: ${errors.join("; ")}`);
    this.name = "ArtifactPackValidationError";
    this.errors = errors;
  }
}

export function artifactPackObservedHash(artifact: ArtifactPackRecord): HashString {
  return `sha256:${createHash("sha256").update(canonicalJson(artifact)).digest("hex")}`;
}

export function artifactPackDigest(value: unknown): HashString {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function bindArtifactPack(
  value: unknown,
  trustedDigest?: HashString,
): BoundArtifactPack | undefined {
  if (value === undefined) return undefined;
  const errors: string[] = [];
  const pack = exactRecord(value, ["refs", "artifacts", "maxInputTokens"], "artifactPack", errors);
  if (!pack) throw new ArtifactPackValidationError(errors);

  if (!Array.isArray(pack.refs)) errors.push("artifactPack.refs: required array");
  if (!Array.isArray(pack.artifacts)) errors.push("artifactPack.artifacts: required array");
  if (!Number.isSafeInteger(pack.maxInputTokens) || Number(pack.maxInputTokens) <= 0) {
    errors.push("artifactPack.maxInputTokens: required positive integer");
  }
  if (errors.length > 0) throw new ArtifactPackValidationError(errors);

  const refs = pack.refs as unknown[];
  const artifacts = pack.artifacts as unknown[];
  const parsedRefs = new Map<string, ArtifactInputRef>();
  for (const [index, valueRef] of refs.entries()) {
    const path = `artifactPack.refs[${index}]`;
    const ref = exactRecord(valueRef, ["kind", "artifactId", "artifactType", "observedHash", "observedAt"], path, errors);
    if (!ref) continue;
    if (ref.kind !== "feed_artifact") errors.push(`${path}.kind: must be feed_artifact`);
    requiredString(ref.artifactId, `${path}.artifactId`, errors);
    requiredString(ref.artifactType, `${path}.artifactType`, errors);
    if (!isSha256(ref.observedHash)) errors.push(`${path}.observedHash: required sha256 digest`);
    if (!isIso(ref.observedAt)) errors.push(`${path}.observedAt: required ISO date`);
    if (typeof ref.artifactId === "string") {
      if (parsedRefs.has(ref.artifactId)) errors.push(`${path}.artifactId: duplicate`);
      else parsedRefs.set(ref.artifactId, ref as unknown as ArtifactInputRef);
    }
  }

  const parsedArtifacts = new Map<string, ArtifactPackRecord>();
  for (const [index, valueArtifact] of artifacts.entries()) {
    const path = `artifactPack.artifacts[${index}]`;
    const artifact = exactRecord(
      valueArtifact,
      ["artifactId", "artifactType", "title", "summary", "body", "sourceRefs", "derivedAccess", "producedBy"],
      path,
      errors,
    );
    if (!artifact) continue;
    requiredString(artifact.artifactId, `${path}.artifactId`, errors);
    requiredString(artifact.artifactType, `${path}.artifactType`, errors);
    requiredString(artifact.title, `${path}.title`, errors);
    if (artifact.summary !== undefined && typeof artifact.summary !== "string") {
      errors.push(`${path}.summary: must be string`);
    }
    if (!("body" in artifact)) errors.push(`${path}.body: required`);
    if (!Array.isArray(artifact.sourceRefs) || artifact.sourceRefs.length === 0) {
      errors.push(`${path}.sourceRefs: required non-empty array`);
    } else {
      artifact.sourceRefs.forEach((source, sourceIndex) => {
        const result = validateTranscriptSourceRef(source);
        if (!result.ok) errors.push(...result.errors.map((error) => `${path}.sourceRefs[${sourceIndex}].${error}`));
      });
    }
    validateDerivedAccess(artifact.derivedAccess, `${path}.derivedAccess`, errors);
    validateProducedBy(artifact.producedBy, `${path}.producedBy`, errors);
    if (typeof artifact.artifactId === "string") {
      if (parsedArtifacts.has(artifact.artifactId)) errors.push(`${path}.artifactId: duplicate`);
      else parsedArtifacts.set(artifact.artifactId, artifact as unknown as ArtifactPackRecord);
    }
  }

  for (const [artifactId, ref] of parsedRefs) {
    const artifact = parsedArtifacts.get(artifactId);
    if (!artifact) {
      errors.push(`artifactPack.refs:${artifactId}: missing artifact record`);
      continue;
    }
    if (artifact.artifactType !== ref.artifactType) {
      errors.push(`artifactPack.refs:${artifactId}: artifactType mismatch`);
    }
    try {
      const actualHash = artifactPackObservedHash(artifact);
      if (ref.observedHash !== actualHash) {
        errors.push(`artifactPack.refs:${artifactId}: observedHash does not bind artifact content`);
      }
    } catch {
      errors.push(`artifactPack.artifacts:${artifactId}: content must be canonical JSON`);
    }
  }
  for (const artifactId of parsedArtifacts.keys()) {
    if (!parsedRefs.has(artifactId)) errors.push(`artifactPack.artifacts:${artifactId}: missing ref`);
  }
  if (errors.length > 0) throw new ArtifactPackValidationError(errors);

  let digest: HashString;
  try {
    digest = artifactPackDigest(value);
  } catch {
    throw new ArtifactPackValidationError(["artifactPack: content must be canonical JSON"]);
  }
  if (trustedDigest !== undefined && digest !== trustedDigest) {
    throw new ArtifactPackValidationError([
      `artifactPack: digest mismatch against reviewed package material (expected ${trustedDigest}, got ${digest})`,
    ]);
  }

  let runtimePack: ArtifactPack;
  try {
    runtimePack = structuredClone(value) as ArtifactPack;
  } catch {
    throw new ArtifactPackValidationError(["artifactPack: content must be cloneable JSON"]);
  }
  const trustedParentArtifacts = new Map<string, {
    ref: ArtifactInputRef;
    derivedAccess: DerivedAccessPolicy;
  }>();
  for (const ref of runtimePack.refs) {
    const artifact = runtimePack.artifacts.find((entry) => entry.artifactId === ref.artifactId)!;
    trustedParentArtifacts.set(ref.artifactId, structuredClone({ ref, derivedAccess: artifact.derivedAccess }));
  }
  return { digest, runtimePack, trustedParentArtifacts };
}

function validateDerivedAccess(value: unknown, path: string, errors: string[]): void {
  const access = exactRecord(value, ["releasePolicy", "lineage", "parentArtifacts", "audienceDids", "expiresAt"], path, errors);
  if (!access) return;
  if (!isReleasePolicy(access.releasePolicy)) errors.push(`${path}.releasePolicy: invalid`);
  if (!Array.isArray(access.lineage)) {
    errors.push(`${path}.lineage: required array`);
  } else {
    access.lineage.forEach((valueLineage, index) => {
      const entryPath = `${path}.lineage[${index}]`;
      const entry = exactRecord(valueLineage, ["sourceRefId", "lineageId", "releasePolicy"], entryPath, errors);
      if (!entry) return;
      requiredString(entry.sourceRefId, `${entryPath}.sourceRefId`, errors);
      if (entry.lineageId !== null && typeof entry.lineageId !== "string") errors.push(`${entryPath}.lineageId: must be string or null`);
      if (!isReleasePolicy(entry.releasePolicy)) errors.push(`${entryPath}.releasePolicy: invalid`);
    });
  }
  if (!Array.isArray(access.parentArtifacts)) {
    errors.push(`${path}.parentArtifacts: required array`);
  } else {
    access.parentArtifacts.forEach((valueParent, index) => {
      const entryPath = `${path}.parentArtifacts[${index}]`;
      const parent = exactRecord(valueParent, ["artifactId", "releasePolicy", "lineageIds"], entryPath, errors);
      if (!parent) return;
      requiredString(parent.artifactId, `${entryPath}.artifactId`, errors);
      if (!isReleasePolicy(parent.releasePolicy)) errors.push(`${entryPath}.releasePolicy: invalid`);
      if (!isStringArray(parent.lineageIds)) errors.push(`${entryPath}.lineageIds: required string array`);
    });
  }
  if (!isStringArray(access.audienceDids)) errors.push(`${path}.audienceDids: required string array`);
  if (access.expiresAt !== undefined && !isIso(access.expiresAt)) errors.push(`${path}.expiresAt: must be ISO date`);
}

function validateProducedBy(value: unknown, path: string, errors: string[]): void {
  const producedBy = exactRecord(value, [
    "packageId", "packageVersion", "packageDigest", "runId", "runtimeClass", "providerClass",
    "credentialOwner", "egressClass", "disclosure",
  ], path, errors);
  if (!producedBy) return;
  for (const field of ["packageId", "packageVersion", "packageDigest", "runId", "runtimeClass", "providerClass", "credentialOwner", "egressClass"]) {
    requiredString(producedBy[field], `${path}.${field}`, errors);
  }
  if (!record(producedBy.disclosure)) errors.push(`${path}.disclosure: required object`);
}

function exactRecord(value: unknown, allowed: string[], path: string, errors: string[]): Record<string, unknown> | null {
  const obj = record(value);
  if (!obj) {
    errors.push(`${path}: required object`);
    return null;
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) errors.push(`${path}.${key}: unsupported field`);
  }
  return obj;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || value.length === 0) errors.push(`${path}: required string`);
}

function isReleasePolicy(value: unknown): value is DerivedAccessPolicy["releasePolicy"] {
  return value === "private" || value === "delegated" || value === "public";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isSha256(value: unknown): value is HashString {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = record(value);
  if (!obj) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] !== undefined) out[key] = canonicalize(obj[key]);
  }
  return out;
}
