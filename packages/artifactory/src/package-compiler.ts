import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ArtifactorySkillManifest,
  CredentialMode,
  EgressClass,
  FeedWorkflowPackage,
  HashString,
  ProviderClass,
  RenderShape,
  RuntimePolicy,
  SpendClass,
  RuntimeClass,
} from "../../../skills/_shared/lib/feed-v1.ts";
import {
  DEFAULT_REVIEWED_BUNDLE_POLICY_PATH,
  admitReviewedBundle,
  loadReviewedBundlePolicy,
  PackageAdmissionError,
  type PackageAdmissionDecision,
  type ReviewedBundlePolicy,
  type ReviewedExternalCapability,
  type ReviewedStageCapability,
} from "./package-policy.ts";

export type PackageMaterial = {
  path: string;
  kind: "json" | "toml" | "text" | "binary";
  digest: HashString;
};

export type WorkflowPack = {
  workflowId: string;
  stages: ReviewedStageCapability[];
  [key: string]: unknown;
};

export type SkillPackageCompileOptions = {
  manifestKey?: string;
  policy?: ReviewedBundlePolicy;
  policyPath?: string;
};

export type CompiledSkillPackage = {
  manifest: ArtifactorySkillManifest;
  package: FeedWorkflowPackage;
  workflowPack: WorkflowPack;
  materials: PackageMaterial[];
  policyDecision: PackageAdmissionDecision;
  manifestJson: string;
};

type SkillContract = {
  schema: "feed.skill.v1";
  id: string;
  display_name: string;
  version: string;
  source: "first_party" | "user_local" | "generated" | "imported";
  admission: {
    tier: 1 | 2;
    default_state: "enabled" | "paused" | "disabled";
    review_status: "reviewed" | "candidate" | "blocked";
  };
  produces: {
    artifact_type: string;
    render_shape: RenderShape;
    label: string;
    output_schema: string;
    outward: boolean;
  }[];
  requires: {
    source_kinds: string[];
    artifact_kinds: string[];
    max_source_refs: number;
    max_input_tokens: number;
    needs_media: boolean;
  };
  runtime: {
    runtime_class: RuntimeClass;
    provider_class: ProviderClass;
    credential_mode: CredentialMode;
    egress_class: EgressClass;
    allowed_tools: string[];
    disallowed_tools: string[];
    external_capabilities?: ReviewedExternalCapability[];
  };
  workflow: {
    executor: "smithers" | "stub";
    ref: string;
    digest?: string;
  };
  limits: {
    max_accepted_artifacts: number;
    timeout_ms: number;
    max_output_bytes: number;
    max_model_calls: number;
  };
  settings?: {
    schema: string;
  };
  validation?: {
    validator_refs: string[];
    evaluator_refs: string[];
    require_quote_anchoring?: boolean;
  };
  disclosure: {
    user_copy: string;
  };
};

export class PackageSourceError extends Error {
  readonly packageId?: string;
  readonly sourcePath?: string;

  constructor(message: string, details: { packageId?: string; sourcePath?: string } = {}) {
    super(message);
    this.name = "PackageSourceError";
    this.packageId = details.packageId;
    this.sourcePath = details.sourcePath;
  }
}

export async function compileSkillPackage(
  rootDir: string,
  options: SkillPackageCompileOptions = {},
): Promise<CompiledSkillPackage> {
  const policy =
    options.policy ?? (await loadReviewedBundlePolicy(options.policyPath ?? DEFAULT_REVIEWED_BUNDLE_POLICY_PATH));
  const sourceRoot = resolve(rootDir);
  const contract = await loadSkillContract(sourceRoot);
  const skillMarkdown = await loadSkillMarkdownBody(sourceRoot);

  const workflowPath = resolvePackagePath(sourceRoot, contract.workflow.ref);
  const workflowPack = await loadWorkflowPack(workflowPath);
  const workflowDigest = digestJson(workflowPack);
  if (contract.workflow.digest && contract.workflow.digest !== workflowDigest) {
    throw new PackageSourceError(
      `workflow digest mismatch for ${contract.workflow.ref}: expected ${contract.workflow.digest}, got ${workflowDigest}`,
      { packageId: contract.id, sourcePath: workflowPath },
    );
  }

  const outputSchemaPath = resolvePackagePath(sourceRoot, contract.produces[0]!.output_schema);
  const settingsSchemaPath = contract.settings?.schema
    ? resolvePackagePath(sourceRoot, contract.settings.schema)
    : undefined;
  const validatorRefs = [...(contract.validation?.validator_refs ?? [])];
  // Validator refs are platform IDs/versions, not package files. They stay as
  // opaque digest inputs and are never resolved through the package tree.
  const explicitMaterialPaths = new Set<string>([
    workflowPath,
    outputSchemaPath,
    ...(settingsSchemaPath ? [settingsSchemaPath] : []),
    ...(contract.validation?.evaluator_refs ?? []).map((ref) => resolvePackagePath(sourceRoot, ref)),
  ]);

  const materialPaths = await collectPackageMaterialPaths(sourceRoot);
  for (const path of explicitMaterialPaths) materialPaths.add(path);

  const materials = await digestMaterials(sourceRoot, Array.from(materialPaths).sort());

  const runtimePolicy: RuntimePolicy = {
    runtimeClass: contract.runtime.runtime_class,
    providerClass: contract.runtime.provider_class,
    credentialMode: contract.runtime.credential_mode,
    egressClass: contract.runtime.egress_class,
    allowedTools: [...contract.runtime.allowed_tools],
    disallowedTools: [...contract.runtime.disallowed_tools],
    maxModelCalls: contract.limits.max_model_calls,
    timeoutMs: contract.limits.timeout_ms,
    maxOutputBytes: contract.limits.max_output_bytes,
    externalCapabilities: contract.runtime.external_capabilities?.map((entry) => ({ ...entry })),
  };

  const manifestBase = {
    schemaVersion: "feed.skill_manifest.v1" as const,
    packageId: contract.id,
    displayName: contract.display_name,
    version: contract.version,
    source: contract.source,
    tier: contract.admission.tier,
    admissionState: computeAdmissionState(contract),
    artifactTypes: contract.produces.map((entry) => entry.artifact_type),
    renderShapes: contract.produces.map((entry) => entry.render_shape),
    outputSchemaRef: normalizeRefPath(contract.produces[0]!.output_schema),
    settingsSchemaRef: contract.settings?.schema ? normalizeRefPath(contract.settings.schema) : undefined,
    validatorRefs,
    evaluatorRefs: [...(contract.validation?.evaluator_refs ?? [])],
    workflowRef: normalizeRefPath(contract.workflow.ref),
    workflowDigest,
    workflowExecutor: contract.workflow.executor,
    stageCapabilities: workflowPack.stages.map(normalizeStageCapability),
    runtimePolicy,
    limits: {
      maxAcceptedArtifacts: contract.limits.max_accepted_artifacts,
      timeoutMs: contract.limits.timeout_ms,
      maxOutputBytes: contract.limits.max_output_bytes,
      maxModelCalls: contract.limits.max_model_calls,
      maxSourceRefs: contract.requires.max_source_refs,
      maxInputTokens: contract.requires.max_input_tokens,
    },
    disclosure: {
      userCopy: normalizeText(contract.disclosure.user_copy),
      credentialOwner: contract.runtime.credential_mode,
      providerClass: contract.runtime.provider_class,
      egressClass: contract.runtime.egress_class,
    },
  } satisfies Omit<ArtifactorySkillManifest, "digest">;

  const digestInput = {
    ...manifestBase,
    skillMarkdown,
    materials,
  };
  const digest = digestJson(digestInput);

  const manifest: ArtifactorySkillManifest = {
    ...manifestBase,
    digest,
  };

  const packageState: FeedWorkflowPackage = {
    schemaVersion: "feed.workflow_package.v1",
    packageId: contract.id,
    displayName: contract.display_name,
    version: contract.version,
    digest,
    manifestKey: options.manifestKey ?? defaultManifestKey(contract.id),
    workflowRef: manifest.workflowRef,
    workflowDigest,
    admissionState: manifest.admissionState,
    disclosure: manifest.disclosure,
  };

  const policyDecision = admitReviewedBundle(
    {
      packageId: packageState.packageId,
      workflowExecutor: manifest.workflowExecutor,
      runtimePolicy,
      limits: manifest.limits,
      stageCapabilities: manifest.stageCapabilities,
    },
    policy,
  );

  if (!policyDecision.ok) {
    throw new PackageAdmissionError(packageState.packageId, policyDecision.policyName, policyDecision.reasons);
  }

  return {
    manifest,
    package: packageState,
    workflowPack,
    materials,
    policyDecision,
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

export async function compileSkillPackageManifestJson(
  rootDir: string,
  options: SkillPackageCompileOptions = {},
): Promise<string> {
  const compiled = await compileSkillPackage(rootDir, options);
  return compiled.manifestJson;
}

function defaultManifestKey(packageId: string): string {
  return `packages/${packageId}/manifest.json`;
}

async function loadSkillContract(rootDir: string): Promise<SkillContract> {
  const skillTomlPath = join(rootDir, "skill.toml");
  const skillMdPath = join(rootDir, "SKILL.md");
  const skillTomlExists = await exists(skillTomlPath);
  const skillMdExists = await exists(skillMdPath);
  if (!skillMdExists) {
    throw new PackageSourceError("package is missing SKILL.md", { sourcePath: skillMdPath });
  }

  const parsed = skillTomlExists
    ? Bun.TOML.parse(await readFile(skillTomlPath, "utf8"))
    : parseFrontmatter(await readFile(skillMdPath, "utf8")).frontmatter;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PackageSourceError("package contract must be a TOML object", {
      sourcePath: skillTomlExists ? skillTomlPath : skillMdPath,
    });
  }
  return normalizeSkillContract(
    parsed as Record<string, unknown>,
    skillTomlExists ? skillTomlPath : skillMdPath,
  );
}

async function loadSkillMarkdownBody(rootDir: string): Promise<string> {
  const skillMdPath = join(rootDir, "SKILL.md");
  const raw = await readFile(skillMdPath, "utf8");
  return normalizeText(parseFrontmatter(raw).body);
}

function normalizeSkillContract(
  value: Record<string, unknown>,
  sourcePath: string,
): SkillContract {
  const schema = requiredString(value.schema, "schema", sourcePath);
  if (schema !== "feed.skill.v1") {
    throw new PackageSourceError(`expected schema feed.skill.v1 (got ${schema})`, { sourcePath });
  }

  const produces = requiredArray(value.produces, "produces", sourcePath).map((entry, index) =>
    normalizeProduceEntry(entry, `${sourcePath}.produces[${index}]`),
  );
  if (produces.length === 0) {
    throw new PackageSourceError("produces must contain at least one entry", { sourcePath });
  }

  return {
    schema,
    id: requiredString(value.id, "id", sourcePath),
    display_name: requiredString(value.display_name, "display_name", sourcePath),
    version: requiredString(value.version, "version", sourcePath),
    source: validateStringUnion(
      value.source,
      ["first_party", "user_local", "generated", "imported"],
      `${sourcePath}.source`,
    ) as SkillContract["source"],
    admission: normalizeAdmission(value.admission, `${sourcePath}.admission`),
    produces,
    requires: normalizeRequires(value.requires, `${sourcePath}.requires`),
    runtime: normalizeRuntime(value.runtime, `${sourcePath}.runtime`),
    workflow: normalizeWorkflow(value.workflow, `${sourcePath}.workflow`),
    limits: normalizeLimits(value.limits, `${sourcePath}.limits`),
    settings: value.settings ? normalizeSettings(value.settings, `${sourcePath}.settings`) : undefined,
    validation: value.validation ? normalizeValidation(value.validation, `${sourcePath}.validation`) : undefined,
    disclosure: normalizeDisclosure(value.disclosure, `${sourcePath}.disclosure`),
  };
}

function normalizeAdmission(value: unknown, sourcePath: string): SkillContract["admission"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageSourceError("admission must be an object", { sourcePath });
  }
  const obj = value as Record<string, unknown>;
  return {
    tier: validateNumericUnion(obj.tier, [1, 2], `${sourcePath}.tier`) as 1 | 2,
    default_state: validateStringUnion(
      obj.default_state,
      ["enabled", "paused", "disabled"],
      `${sourcePath}.default_state`,
    ) as SkillContract["admission"]["default_state"],
    review_status: validateStringUnion(
      obj.review_status,
      ["reviewed", "candidate", "blocked"],
      `${sourcePath}.review_status`,
    ) as SkillContract["admission"]["review_status"],
  };
}

function normalizeProduceEntry(value: unknown, sourcePath: string): SkillContract["produces"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageSourceError("produces entry must be an object", { sourcePath });
  }
  const obj = value as Record<string, unknown>;
  return {
    artifact_type: requiredString(obj.artifact_type, "artifact_type", sourcePath),
    render_shape: validateStringUnion(
      obj.render_shape,
      ["short_form", "longform", "media"],
      `${sourcePath}.render_shape`,
    ) as RenderShape,
    label: requiredString(obj.label, "label", sourcePath),
    output_schema: requiredString(obj.output_schema, "output_schema", sourcePath),
    outward: requiredBoolean(obj.outward, "outward", sourcePath),
  };
}

function normalizeRequires(value: unknown, sourcePath: string): SkillContract["requires"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageSourceError("requires must be an object", { sourcePath });
  }
  const obj = value as Record<string, unknown>;
  return {
    source_kinds: requiredStringArray(obj.source_kinds, "source_kinds", sourcePath),
    artifact_kinds: requiredStringArray(obj.artifact_kinds, "artifact_kinds", sourcePath),
    max_source_refs: requiredPositiveInteger(obj.max_source_refs, "max_source_refs", sourcePath),
    max_input_tokens: requiredPositiveInteger(obj.max_input_tokens, "max_input_tokens", sourcePath),
    needs_media: requiredBoolean(obj.needs_media, "needs_media", sourcePath),
  };
}

function normalizeRuntime(value: unknown, sourcePath: string): SkillContract["runtime"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageSourceError("runtime must be an object", { sourcePath });
  }
  const obj = value as Record<string, unknown>;
  return {
    runtime_class: validateStringUnion(
      obj.runtime_class,
      ["feed_hosted", "hosted_private", "local", "stub"],
      `${sourcePath}.runtime_class`,
    ) as RuntimeClass,
    provider_class: validateStringUnion(
      obj.provider_class,
      ["first_party", "user_byok", "local", "none"],
      `${sourcePath}.provider_class`,
    ) as ProviderClass,
    credential_mode: validateStringUnion(
      obj.credential_mode,
      ["feed_hosted", "user_byok_api_key", "user_oauth_token", "none"],
      `${sourcePath}.credential_mode`,
    ) as CredentialMode,
    egress_class: validateStringUnion(
      obj.egress_class,
      ["none", "model_provider", "media_provider", "tool_provider"],
      `${sourcePath}.egress_class`,
    ) as EgressClass,
    allowed_tools: requiredStringArray(obj.allowed_tools, "allowed_tools", sourcePath),
    disallowed_tools: requiredStringArray(obj.disallowed_tools, "disallowed_tools", sourcePath),
    external_capabilities: obj.external_capabilities
      ? normalizeExternalCapabilities(obj.external_capabilities, `${sourcePath}.external_capabilities`)
      : undefined,
  };
}

function normalizeExternalCapabilities(value: unknown, sourcePath: string): ReviewedExternalCapability[] {
  if (!Array.isArray(value)) {
    throw new PackageSourceError("external_capabilities must be an array", { sourcePath });
  }
  return value.map((entry, index) => normalizeExternalCapability(entry, `${sourcePath}[${index}]`));
}

function normalizeExternalCapability(value: unknown, sourcePath: string): ReviewedExternalCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageSourceError("external capability must be an object", { sourcePath });
  }
  const obj = value as Record<string, unknown>;
  return {
    kind: validateStringUnion(
      obj.kind,
      ["model", "media_generation", "web_search", "provider_tool"],
      `${sourcePath}.kind`,
    ) as ReviewedExternalCapability["kind"],
    provider: requiredString(obj.provider, "provider", sourcePath),
    credentialMode: validateStringUnion(
      obj.credential_mode ?? obj.credentialMode,
      ["feed_hosted", "user_byok_api_key", "user_oauth_token", "none"],
      `${sourcePath}.credential_mode`,
    ) as CredentialMode,
    scopes: requiredStringArray(obj.scopes, "scopes", sourcePath),
    spendClass: validateStringUnion(
      obj.spend_class ?? obj.spendClass,
      ["none", "model", "media", "tool"],
      `${sourcePath}.spend_class`,
    ) as SpendClass,
    egressClass: validateStringUnion(
      obj.egress_class ?? obj.egressClass,
      ["none", "model_provider", "media_provider", "tool_provider"],
      `${sourcePath}.egress_class`,
    ) as EgressClass,
  };
}

function normalizeWorkflow(value: unknown, sourcePath: string): SkillContract["workflow"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageSourceError("workflow must be an object", { sourcePath });
  }
  const obj = value as Record<string, unknown>;
  return {
    executor: validateStringUnion(obj.executor, ["smithers", "stub"], `${sourcePath}.executor`) as SkillContract["workflow"]["executor"],
    ref: requiredString(obj.ref, "ref", sourcePath),
    digest: typeof obj.digest === "string" && obj.digest.trim() ? obj.digest.trim() : undefined,
  };
}

function normalizeLimits(value: unknown, sourcePath: string): SkillContract["limits"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageSourceError("limits must be an object", { sourcePath });
  }
  const obj = value as Record<string, unknown>;
  return {
    max_accepted_artifacts: requiredPositiveInteger(obj.max_accepted_artifacts, "max_accepted_artifacts", sourcePath),
    timeout_ms: requiredPositiveInteger(obj.timeout_ms, "timeout_ms", sourcePath),
    max_output_bytes: requiredPositiveInteger(obj.max_output_bytes, "max_output_bytes", sourcePath),
    max_model_calls: requiredNonNegativeInteger(obj.max_model_calls, "max_model_calls", sourcePath),
  };
}

function normalizeSettings(value: unknown, sourcePath: string): SkillContract["settings"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageSourceError("settings must be an object", { sourcePath });
  }
  const obj = value as Record<string, unknown>;
  return {
    schema: requiredString(obj.schema, "schema", sourcePath),
  };
}

function normalizeValidation(value: unknown, sourcePath: string): SkillContract["validation"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageSourceError("validation must be an object", { sourcePath });
  }
  const obj = value as Record<string, unknown>;
  return {
    validator_refs: requiredStringArray(obj.validator_refs, "validator_refs", sourcePath),
    evaluator_refs: requiredStringArray(obj.evaluator_refs, "evaluator_refs", sourcePath),
    require_quote_anchoring: typeof obj.require_quote_anchoring === "boolean" ? obj.require_quote_anchoring : undefined,
  };
}

function normalizeDisclosure(value: unknown, sourcePath: string): SkillContract["disclosure"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageSourceError("disclosure must be an object", { sourcePath });
  }
  const obj = value as Record<string, unknown>;
  return {
    user_copy: requiredString(obj.user_copy, "user_copy", sourcePath),
  };
}

function computeAdmissionState(contract: SkillContract): ArtifactorySkillManifest["admissionState"] {
  if (contract.admission.review_status === "blocked") return "blocked";
  if (contract.source === "first_party" && contract.admission.review_status === "reviewed") {
    return "reviewed_first_party";
  }
  if (contract.source === "user_local" || contract.source === "generated") return "candidate";
  return "candidate";
}

function normalizeStageCapability(value: ReviewedStageCapability): ReviewedStageCapability {
  return {
    stageId: value.stageId.trim(),
    capabilities: value.capabilities.map((entry) => entry.trim()),
    authority: value.authority,
    egressClass: value.egressClass,
    spendClass: value.spendClass,
  };
}

async function loadWorkflowPack(workflowPath: string): Promise<WorkflowPack> {
  const raw = await readFile(workflowPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PackageSourceError("workflow pack must be a JSON object", { sourcePath: workflowPath });
  }
  const obj = parsed as Record<string, unknown>;
  const workflowId = requiredString(obj.workflowId, "workflowId", workflowPath);
  const stages = requiredArray(obj.stages, "stages", workflowPath).map((entry, index) =>
    normalizeWorkflowStage(entry, `${workflowPath}.stages[${index}]`),
  );
  if (stages.length === 0) {
    throw new PackageSourceError("workflow pack must declare at least one stage", { sourcePath: workflowPath });
  }
  return {
    ...obj,
    workflowId,
    stages,
  };
}

function normalizeWorkflowStage(value: unknown, sourcePath: string): ReviewedStageCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PackageSourceError("workflow stage must be an object", { sourcePath });
  }
  const obj = value as Record<string, unknown>;
  return {
    stageId: requiredString(obj.stageId, "stageId", sourcePath),
    capabilities: requiredStringArray(obj.capabilities, "capabilities", sourcePath),
    authority: validateStringUnion(obj.authority, ["none", "worker_run_stage_scope"], `${sourcePath}.authority`) as ReviewedStageCapability["authority"],
    egressClass: obj.egressClass
      ? (validateStringUnion(
          obj.egressClass,
          ["none", "model_provider", "media_provider", "tool_provider"],
          `${sourcePath}.egressClass`,
        ) as EgressClass)
      : undefined,
    spendClass: obj.spendClass
      ? (validateStringUnion(obj.spendClass, ["none", "model", "media", "tool"], `${sourcePath}.spendClass`) as SpendClass)
      : undefined,
  };
}

async function collectPackageMaterialPaths(rootDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const file of ["CHANGELOG.md"]) {
    const path = join(rootDir, file);
    if (await exists(path)) out.add(path);
  }
  for (const dir of ["schemas", "fixtures", "evaluators", "templates", "workflows", "scripts"]) {
    const path = join(rootDir, dir);
    if (! (await exists(path))) continue;
    for (const entry of await walkFiles(path)) out.add(entry);
  }
  return out;
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path)));
      continue;
    }
    if (entry.isFile()) files.push(path);
  }
  return files;
}

async function digestMaterials(rootDir: string, paths: string[]): Promise<PackageMaterial[]> {
  const materials = await Promise.all(
    paths.map(async (absolutePath) => {
      const kind = inferMaterialKind(absolutePath);
      const raw = await readMaterialFile(absolutePath, kind);
      const rel = relative(rootDir, absolutePath);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new PackageSourceError(`material escapes package root: ${absolutePath}`, { sourcePath: absolutePath });
      }
      return {
        path: normalizeRefPath(rel),
        kind,
        digest: digestContent(kind, raw),
      } satisfies PackageMaterial;
    }),
  );
  return materials.sort((left, right) => left.path.localeCompare(right.path));
}

async function readMaterialFile(path: string, kind: PackageMaterial["kind"]): Promise<string | Buffer> {
  if (kind === "binary") return await readFile(path);
  return await readFile(path, "utf8");
}

function digestContent(kind: PackageMaterial["kind"], content: string | Buffer): HashString {
  if (kind === "binary") {
    return sha256(content);
  }
  if (kind === "json") {
    return sha256(canonicalJson(JSON.parse(String(content))));
  }
  if (kind === "toml") {
    return sha256(canonicalJson(Bun.TOML.parse(String(content))));
  }
  return sha256(normalizeText(String(content)));
}

function digestJson(value: unknown): HashString {
  return sha256(canonicalJson(value));
}

function sha256(value: string | Buffer): HashString {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const entry = obj[key];
    if (entry !== undefined) out[key] = canonicalize(entry);
  }
  return out;
}

function normalizeText(value: string): string {
  const stripped = value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (stripped.length === 0) return "";
  return stripped.replace(/\n+$/, "") + "\n";
}

function parseFrontmatter(raw: string): { frontmatter?: Record<string, unknown>; body: string } {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = /^(---|\+\+\+)\n([\s\S]*?)\n\1\n?/.exec(normalized);
  if (!match?.[2]) return { body: normalized };
  return {
    frontmatter: Bun.TOML.parse(match[2]) as Record<string, unknown>,
    body: normalized.slice(match[0].length),
  };
}

function normalizeRefPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function resolvePackagePath(rootDir: string, ref: string): string {
  const normalized = normalizeRefPath(ref);
  const resolved = resolve(rootDir, normalized);
  const rel = relative(rootDir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PackageSourceError(`reference escapes package root: ${ref}`, { sourcePath: resolved });
  }
  return resolved;
}

function inferMaterialKind(path: string): PackageMaterial["kind"] {
  const ext = extname(path).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".toml") return "toml";
  if ([".md", ".txt", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"].includes(ext)) return "text";
  return "binary";
}

function requiredString(value: unknown, field: string, sourcePath: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PackageSourceError(`${sourcePath}.${field} must be a non-empty string`, { sourcePath });
  }
  return value.trim();
}

function requiredBoolean(value: unknown, field: string, sourcePath: string): boolean {
  if (typeof value !== "boolean") {
    throw new PackageSourceError(`${sourcePath}.${field} must be a boolean`, { sourcePath });
  }
  return value;
}

function requiredArray(value: unknown, field: string, sourcePath: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new PackageSourceError(`${sourcePath}.${field} must be an array`, { sourcePath });
  }
  return value;
}

function requiredStringArray(value: unknown, field: string, sourcePath: string): string[] {
  return requiredArray(value, field, sourcePath).map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new PackageSourceError(`${sourcePath}.${field}[${index}] must be a non-empty string`, {
        sourcePath,
      });
    }
    return entry.trim();
  });
}

function requiredPositiveInteger(value: unknown, field: string, sourcePath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new PackageSourceError(`${sourcePath}.${field} must be a positive integer`, { sourcePath });
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, field: string, sourcePath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new PackageSourceError(`${sourcePath}.${field} must be a non-negative integer`, { sourcePath });
  }
  return value;
}

function validateStringUnion(value: unknown, allowed: string[], field: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new PackageSourceError(`${field} must be one of ${allowed.join(", ")}`, { sourcePath: field });
  }
  return value;
}

function validateNumericUnion(value: unknown, allowed: number[], field: string): number {
  if (typeof value !== "number" || !allowed.includes(value)) {
    throw new PackageSourceError(`${field} must be one of ${allowed.join(", ")}`, { sourcePath: field });
  }
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() || info.isDirectory();
  } catch {
    return false;
  }
}
