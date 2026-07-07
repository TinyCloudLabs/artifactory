// Workflow definition loaded by the CLI. The loader accepts the legacy inline
// fixture shape for existing tests and the package-backed shape used by the
// reviewed-bundle pipeline.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  ArtifactorySkillManifest,
  RuntimePolicy,
  TranscriptSourceRef,
} from "../../../skills/_shared/lib/feed-v1.ts";
import { compileSkillPackage, PackageSourceError } from "./package-compiler.ts";
import type { ListenResolution } from "./listen-resolver.ts";

export type WorkflowFixture = {
  workflowId: string;
  packageId: string;
  version: string;
  digest: string;
  skillManifest: ArtifactorySkillManifest;
  runtimePolicy: RuntimePolicy;
  sourcePack: {
    refs: TranscriptSourceRef[];
    excerpts: { sourceRefId: string; text: string; quoteLineRefs?: string[] }[];
    maxInputTokens: number;
  };
  listenResolution?: ListenResolution;
  settings: unknown;
  maxAcceptedArtifacts: number;
  packageRoot?: string;
};

export async function loadWorkflowFile(path: string): Promise<WorkflowFixture> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const fixture = parseWorkflow(parsed, path);
  if (!fixture.packageRoot) {
    return fixture;
  }

  const packageRoot = resolve(dirname(path), fixture.packageRoot);
  const compiled = await compileSkillPackage(packageRoot);
  assertCompatiblePackageFixture(
    fixture,
    compiled.manifest,
    compiled.workflowPack.workflowId,
    compiled.package.packageId,
    compiled.package.version,
  );

  return {
    ...fixture,
    packageRoot,
    packageId: compiled.package.packageId,
    version: compiled.package.version,
    digest: compiled.package.digest,
    workflowId: compiled.workflowPack.workflowId,
    skillManifest: compiled.manifest,
    maxAcceptedArtifacts: compiled.manifest.limits.maxAcceptedArtifacts,
  };
}

export function parseWorkflow(value: unknown, sourcePath = "workflow file"): WorkflowFixture {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workflow file must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  for (const field of [
    "workflowId",
    "packageId",
    "version",
    "digest",
    "skillManifest",
    "runtimePolicy",
    "sourcePack",
    "settings",
    "maxAcceptedArtifacts",
  ]) {
    if (!(field in obj)) throw new Error(`workflow file missing required field: ${field}`);
  }
  if ("packageRoot" in obj && typeof obj.packageRoot !== "string") {
    throw new Error(`${sourcePath} packageRoot must be a string when provided`);
  }
  return obj as unknown as WorkflowFixture;
}

function assertCompatiblePackageFixture(
  fixture: WorkflowFixture,
  manifest: ArtifactorySkillManifest,
  workflowId: string,
  packageId: string,
  version: string,
): void {
  if (fixture.packageId !== packageId) {
    throw new PackageSourceError(`packageId mismatch for ${fixture.packageId}: expected ${packageId}`);
  }
  if (fixture.version !== version) {
    throw new PackageSourceError(`version mismatch for ${fixture.packageId}: expected ${version}`);
  }
  if (fixture.digest !== manifest.digest) {
    throw new PackageSourceError(`digest mismatch for ${fixture.packageId}: expected ${manifest.digest}, got ${fixture.digest}`);
  }
  if (fixture.workflowId !== workflowId) {
    throw new PackageSourceError(`workflowId mismatch for ${fixture.packageId}: expected ${workflowId}, got ${fixture.workflowId}`);
  }
  if (fixture.skillManifest.digest !== manifest.digest) {
    throw new PackageSourceError(
      `skillManifest digest mismatch for ${fixture.packageId}: expected ${manifest.digest}, got ${fixture.skillManifest.digest}`,
    );
  }
  if (fixture.skillManifest.workflowRef !== manifest.workflowRef) {
    throw new PackageSourceError(
      `skillManifest workflowRef mismatch for ${fixture.packageId}: expected ${manifest.workflowRef}, got ${fixture.skillManifest.workflowRef}`,
    );
  }
  if (fixture.skillManifest.workflowDigest !== manifest.workflowDigest) {
    throw new PackageSourceError(
      `skillManifest workflowDigest mismatch for ${fixture.packageId}: expected ${manifest.workflowDigest}, got ${fixture.skillManifest.workflowDigest}`,
    );
  }
  if (fixture.skillManifest.packageId !== manifest.packageId) {
    throw new PackageSourceError(
      `skillManifest packageId mismatch for ${fixture.packageId}: expected ${manifest.packageId}, got ${fixture.skillManifest.packageId}`,
    );
  }
  if (fixture.maxAcceptedArtifacts !== manifest.limits.maxAcceptedArtifacts) {
    throw new PackageSourceError(
      `maxAcceptedArtifacts mismatch for ${fixture.packageId}: expected ${manifest.limits.maxAcceptedArtifacts}, got ${fixture.maxAcceptedArtifacts}`,
    );
  }
  assertCompatibleRuntimePolicy(fixture.runtimePolicy, manifest.runtimePolicy, fixture.packageId);
  assertSourcePackWithinLimits(fixture, manifest);
}

function assertCompatibleRuntimePolicy(
  runtimePolicy: RuntimePolicy,
  manifestPolicy: RuntimePolicy,
  packageId: string,
): void {
  for (const field of ["runtimeClass", "providerClass", "credentialMode", "egressClass", "maxModelCalls", "timeoutMs", "maxOutputBytes"] as const) {
    if (runtimePolicy[field] !== manifestPolicy[field]) {
      throw new PackageSourceError(
        `runtimePolicy.${field} mismatch for ${packageId}: expected ${manifestPolicy[field]}, got ${runtimePolicy[field]}`,
      );
    }
  }

  if (!sameJson(runtimePolicy.allowedTools, manifestPolicy.allowedTools)) {
    throw new PackageSourceError(`runtimePolicy.allowedTools mismatch for ${packageId}`);
  }
  if (!sameJson(runtimePolicy.disallowedTools, manifestPolicy.disallowedTools)) {
    throw new PackageSourceError(`runtimePolicy.disallowedTools mismatch for ${packageId}`);
  }
  if (!sameJson(runtimePolicy.externalCapabilities ?? [], manifestPolicy.externalCapabilities ?? [])) {
    throw new PackageSourceError(`runtimePolicy.externalCapabilities mismatch for ${packageId}`);
  }
}

function assertSourcePackWithinLimits(fixture: WorkflowFixture, manifest: ArtifactorySkillManifest): void {
  if (fixture.sourcePack.refs.length > manifest.limits.maxSourceRefs) {
    throw new PackageSourceError(
      `sourcePack.refs exceeds maxSourceRefs for ${fixture.packageId}: ${fixture.sourcePack.refs.length} > ${manifest.limits.maxSourceRefs}`,
    );
  }
  if (fixture.sourcePack.maxInputTokens > manifest.limits.maxInputTokens) {
    throw new PackageSourceError(
      `sourcePack.maxInputTokens exceeds maxInputTokens for ${fixture.packageId}: ${fixture.sourcePack.maxInputTokens} > ${manifest.limits.maxInputTokens}`,
    );
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortValue(left)) === JSON.stringify(sortValue(right));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortValue(entry));
  }
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const entry = obj[key];
    if (entry !== undefined) out[key] = sortValue(entry);
  }
  return out;
}
