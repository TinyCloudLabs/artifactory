import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CredentialMode,
  EgressClass,
  ProviderClass,
  RuntimeClass,
  SpendClass,
} from "../../../skills/_shared/lib/feed-v1.ts";

export type ReviewedBundlePolicy = {
  name: string;
  allowedRuntimeClasses: RuntimeClass[];
  allowedProviderClasses: ProviderClass[];
  allowedCredentialModes: CredentialMode[];
  allowedEgressClasses: EgressClass[];
  allowedWorkflowExecutors: Array<"smithers" | "stub">;
  allowedStageAuthorities: Array<"none" | "worker_run_stage_scope">;
  allowedStageCapabilities: string[];
  allowedStageEgressClasses: EgressClass[];
  allowedStageSpendClasses: SpendClass[];
  allowedTools: string[];
  requiredDisallowedTools: string[];
  allowedExternalCapabilities: ReviewedExternalCapability[];
  maxModelCalls: number;
  timeoutMs: number;
  maxOutputBytes: number;
  maxAcceptedArtifacts: number;
  maxSourceRefs: number;
  maxInputTokens: number;
};

export type ReviewedExternalCapability = {
  kind: "model" | "media_generation" | "web_search" | "provider_tool";
  provider: string;
  credentialMode: CredentialMode;
  scopes: string[];
  spendClass: SpendClass;
  egressClass: EgressClass;
};

export type ReviewedStageCapability = {
  stageId: string;
  capabilities: string[];
  authority: "none" | "worker_run_stage_scope";
  egressClass?: EgressClass;
  spendClass?: SpendClass;
};

export type PackageAdmissionTarget = {
  packageId: string;
  workflowExecutor: "smithers" | "stub";
  runtimePolicy: {
    runtimeClass: RuntimeClass;
    providerClass: ProviderClass;
    credentialMode: CredentialMode;
    egressClass: EgressClass;
    allowedTools: string[];
    disallowedTools: string[];
    maxModelCalls: number;
    timeoutMs: number;
    maxOutputBytes: number;
    budgetId?: string;
    externalCapabilities?: ReviewedExternalCapability[];
  };
  limits: {
    maxAcceptedArtifacts: number;
    timeoutMs: number;
    maxOutputBytes: number;
    maxModelCalls: number;
    maxSourceRefs: number;
    maxInputTokens: number;
  };
  stageCapabilities: ReviewedStageCapability[];
};

export type PackageAdmissionDecision = {
  ok: boolean;
  policyName: string;
  reasons: string[];
};

export class PackageAdmissionError extends Error {
  readonly packageId: string;
  readonly policyName: string;
  readonly reasons: string[];

  constructor(packageId: string, policyName: string, reasons: string[]) {
    super(`package ${packageId} rejected by ${policyName}`);
    this.name = "PackageAdmissionError";
    this.packageId = packageId;
    this.policyName = policyName;
    this.reasons = reasons;
  }
}

export const DEFAULT_REVIEWED_BUNDLE_POLICY_PATH = resolve(
  import.meta.dir,
  "../policies/reviewed-bundle-policy.json",
);

export async function loadReviewedBundlePolicy(
  policyPath = DEFAULT_REVIEWED_BUNDLE_POLICY_PATH,
): Promise<ReviewedBundlePolicy> {
  const raw = await readFile(policyPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return normalizePolicy(parsed, policyPath);
}

export function normalizePolicy(value: unknown, policyPath = DEFAULT_REVIEWED_BUNDLE_POLICY_PATH): ReviewedBundlePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`reviewed bundle policy must be an object (${policyPath})`);
  }
  const obj = value as Record<string, unknown>;
  const policyName = readString(obj.name, "name", policyPath);
  return {
    name: policyName,
    allowedRuntimeClasses: readStringArray(obj.allowedRuntimeClasses, "allowedRuntimeClasses", policyPath) as RuntimeClass[],
    allowedProviderClasses: readStringArray(obj.allowedProviderClasses, "allowedProviderClasses", policyPath) as ProviderClass[],
    allowedCredentialModes: readStringArray(obj.allowedCredentialModes, "allowedCredentialModes", policyPath) as CredentialMode[],
    allowedEgressClasses: readStringArray(obj.allowedEgressClasses, "allowedEgressClasses", policyPath) as EgressClass[],
    allowedWorkflowExecutors: readStringArray(obj.allowedWorkflowExecutors, "allowedWorkflowExecutors", policyPath) as Array<"smithers" | "stub">,
    allowedStageAuthorities: readStringArray(obj.allowedStageAuthorities, "allowedStageAuthorities", policyPath) as Array<"none" | "worker_run_stage_scope">,
    allowedStageCapabilities: readStringArray(obj.allowedStageCapabilities, "allowedStageCapabilities", policyPath),
    allowedStageEgressClasses: readStringArray(obj.allowedStageEgressClasses, "allowedStageEgressClasses", policyPath) as EgressClass[],
    allowedStageSpendClasses: readStringArray(obj.allowedStageSpendClasses, "allowedStageSpendClasses", policyPath) as SpendClass[],
    allowedTools: readStringArray(obj.allowedTools, "allowedTools", policyPath),
    requiredDisallowedTools: readStringArray(obj.requiredDisallowedTools, "requiredDisallowedTools", policyPath),
    allowedExternalCapabilities: readArray(obj.allowedExternalCapabilities, "allowedExternalCapabilities", policyPath).map((entry, index) =>
      normalizeExternalCapability(entry, `${policyPath}:allowedExternalCapabilities[${index}]`),
    ),
    maxModelCalls: readFiniteNumber(obj.maxModelCalls, "maxModelCalls", policyPath),
    timeoutMs: readFiniteNumber(obj.timeoutMs, "timeoutMs", policyPath),
    maxOutputBytes: readFiniteNumber(obj.maxOutputBytes, "maxOutputBytes", policyPath),
    maxAcceptedArtifacts: readFiniteNumber(obj.maxAcceptedArtifacts, "maxAcceptedArtifacts", policyPath),
    maxSourceRefs: readFiniteNumber(obj.maxSourceRefs, "maxSourceRefs", policyPath),
    maxInputTokens: readFiniteNumber(obj.maxInputTokens, "maxInputTokens", policyPath),
  };
}

export function admitReviewedBundle(
  target: PackageAdmissionTarget,
  policy: ReviewedBundlePolicy,
): PackageAdmissionDecision {
  const reasons: string[] = [];

  if (!policy.allowedWorkflowExecutors.includes(target.workflowExecutor)) {
    reasons.push(
      `workflowExecutor=${target.workflowExecutor} is not allowed by reviewed bundle policy`,
    );
  }
  if (!policy.allowedRuntimeClasses.includes(target.runtimePolicy.runtimeClass)) {
    reasons.push(
      `runtimePolicy.runtimeClass=${target.runtimePolicy.runtimeClass} is not allowed by reviewed bundle policy`,
    );
  }
  if (!policy.allowedProviderClasses.includes(target.runtimePolicy.providerClass)) {
    reasons.push(
      `runtimePolicy.providerClass=${target.runtimePolicy.providerClass} is not allowed by reviewed bundle policy`,
    );
  }
  if (!policy.allowedCredentialModes.includes(target.runtimePolicy.credentialMode)) {
    reasons.push(
      `runtimePolicy.credentialMode=${target.runtimePolicy.credentialMode} is not allowed by reviewed bundle policy`,
    );
  }
  if (!policy.allowedEgressClasses.includes(target.runtimePolicy.egressClass)) {
    reasons.push(
      `runtimePolicy.egressClass=${target.runtimePolicy.egressClass} is not allowed by reviewed bundle policy`,
    );
  }
  if (target.runtimePolicy.allowedTools.some((tool) => !policy.allowedTools.includes(tool))) {
    const disallowed = target.runtimePolicy.allowedTools.filter((tool) => !policy.allowedTools.includes(tool));
    reasons.push(`runtimePolicy.allowedTools includes disallowed tool(s): ${disallowed.join(", ")}`);
  }
  for (const required of policy.requiredDisallowedTools) {
    if (!target.runtimePolicy.disallowedTools.includes(required)) {
      reasons.push(`runtimePolicy.disallowedTools is missing required guard ${required}`);
    }
  }

  if (target.runtimePolicy.maxModelCalls > policy.maxModelCalls) {
    reasons.push(
      `runtimePolicy.maxModelCalls=${target.runtimePolicy.maxModelCalls} exceeds reviewed bundle cap ${policy.maxModelCalls}`,
    );
  }
  if (target.runtimePolicy.timeoutMs > policy.timeoutMs) {
    reasons.push(
      `runtimePolicy.timeoutMs=${target.runtimePolicy.timeoutMs} exceeds reviewed bundle cap ${policy.timeoutMs}`,
    );
  }
  if (target.runtimePolicy.maxOutputBytes > policy.maxOutputBytes) {
    reasons.push(
      `runtimePolicy.maxOutputBytes=${target.runtimePolicy.maxOutputBytes} exceeds reviewed bundle cap ${policy.maxOutputBytes}`,
    );
  }

  if (target.limits.maxAcceptedArtifacts > policy.maxAcceptedArtifacts) {
    reasons.push(
      `limits.maxAcceptedArtifacts=${target.limits.maxAcceptedArtifacts} exceeds reviewed bundle cap ${policy.maxAcceptedArtifacts}`,
    );
  }
  if (target.limits.maxSourceRefs > policy.maxSourceRefs) {
    reasons.push(
      `limits.maxSourceRefs=${target.limits.maxSourceRefs} exceeds reviewed bundle cap ${policy.maxSourceRefs}`,
    );
  }
  if (target.limits.maxInputTokens > policy.maxInputTokens) {
    reasons.push(
      `limits.maxInputTokens=${target.limits.maxInputTokens} exceeds reviewed bundle cap ${policy.maxInputTokens}`,
    );
  }
  if (target.limits.maxOutputBytes > policy.maxOutputBytes) {
    reasons.push(
      `limits.maxOutputBytes=${target.limits.maxOutputBytes} exceeds reviewed bundle cap ${policy.maxOutputBytes}`,
    );
  }
  if (target.limits.maxModelCalls > policy.maxModelCalls) {
    reasons.push(
      `limits.maxModelCalls=${target.limits.maxModelCalls} exceeds reviewed bundle cap ${policy.maxModelCalls}`,
    );
  }
  if (target.limits.timeoutMs > policy.timeoutMs) {
    reasons.push(
      `limits.timeoutMs=${target.limits.timeoutMs} exceeds reviewed bundle cap ${policy.timeoutMs}`,
    );
  }

  for (const capability of target.runtimePolicy.externalCapabilities ?? []) {
    if (!policy.allowedExternalCapabilities.some((allowed) => sameExternalCapability(allowed, capability))) {
      reasons.push(
        `runtimePolicy.externalCapabilities includes disallowed capability ${stableJson(capability)}`,
      );
    }
  }

  for (const stage of target.stageCapabilities) {
    if (!policy.allowedStageAuthorities.includes(stage.authority)) {
      reasons.push(`stageCapabilities[${stage.stageId}].authority=${stage.authority} is not allowed`);
    }
    const egressClass = stage.egressClass ?? "none";
    if (!policy.allowedStageEgressClasses.includes(egressClass)) {
      reasons.push(
        `stageCapabilities[${stage.stageId}].egressClass=${egressClass} is not allowed`,
      );
    }
    const spendClass = stage.spendClass ?? "none";
    if (!policy.allowedStageSpendClasses.includes(spendClass)) {
      reasons.push(
        `stageCapabilities[${stage.stageId}].spendClass=${spendClass} is not allowed`,
      );
    }
    for (const capability of stage.capabilities) {
      if (!policy.allowedStageCapabilities.includes(capability)) {
        reasons.push(
          `stageCapabilities[${stage.stageId}].capabilities includes disallowed capability ${capability}`,
        );
      }
    }
  }

  return { ok: reasons.length === 0, policyName: policy.name, reasons };
}

export function raiseAdmissionError(target: PackageAdmissionTarget, policy: ReviewedBundlePolicy): never {
  const decision = admitReviewedBundle(target, policy);
  if (decision.ok) {
    throw new Error("raiseAdmissionError called for an admitted package");
  }
  throw new PackageAdmissionError(target.packageId, decision.policyName, decision.reasons);
}

function readString(value: unknown, field: string, policyPath: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${policyPath}.${field} must be a non-empty string`);
  }
  return value.trim();
}

function readFiniteNumber(value: unknown, field: string, policyPath: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${policyPath}.${field} must be a finite number`);
  }
  return value;
}

function readArray(value: unknown, field: string, policyPath: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${policyPath}.${field} must be an array`);
  }
  return value;
}

function readStringArray(value: unknown, field: string, policyPath: string): string[] {
  return readArray(value, field, policyPath).map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${policyPath}.${field}[${index}] must be a non-empty string`);
    }
    return entry.trim();
  });
}

function normalizeExternalCapability(
  value: unknown,
  policyPath: string,
): ReviewedExternalCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${policyPath} must be an object`);
  }
  const obj = value as Record<string, unknown>;
  return {
    kind: validateStringUnion(obj.kind, ["model", "media_generation", "web_search", "provider_tool"], `${policyPath}.kind`) as ReviewedExternalCapability["kind"],
    provider: readString(obj.provider, "provider", policyPath),
    credentialMode: validateStringUnion(
      obj.credential_mode ?? obj.credentialMode,
      ["feed_hosted", "user_byok_api_key", "user_oauth_token", "none"],
      `${policyPath}.credentialMode`,
    ) as CredentialMode,
    scopes: readStringArray(obj.scopes, "scopes", policyPath),
    spendClass: validateStringUnion(
      obj.spend_class ?? obj.spendClass,
      ["none", "model", "media", "tool"],
      `${policyPath}.spendClass`,
    ) as SpendClass,
    egressClass: validateStringUnion(
      obj.egress_class ?? obj.egressClass,
      ["none", "model_provider", "media_provider", "tool_provider"],
      `${policyPath}.egressClass`,
    ) as EgressClass,
  };
}

function validateStringUnion(value: unknown, allowed: string[], field: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function sameExternalCapability(
  left: ReviewedExternalCapability,
  right: ReviewedExternalCapability,
): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
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
