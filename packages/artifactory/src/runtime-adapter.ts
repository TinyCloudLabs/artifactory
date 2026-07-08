// Local mirror of the ArtifactSkillRuntime contract owned by
// tinycloud-agents/packages/agent-client (branch: feat/artifact-skill-runtime-contract,
// file: src/artifact-skill-runtime.ts). TC-70/71 wires the CLI to the real
// adapter; until then we depend only on the interface and ship a stub.

import type {
  RuntimePolicy,
  SkillRunInput,
  SkillRunOutput,
} from "../../../skills/_shared/lib/feed-v1.ts";

export const RUN_ARTIFACT_SKILL = "RUN_ARTIFACT_SKILL" as const;
export type ArtifactSkillRuntimeTool = typeof RUN_ARTIFACT_SKILL;

export type ArtifactSkillRuntimeInput = SkillRunInput;
export type ArtifactSkillRuntimeOutput = SkillRunOutput;
export type ArtifactSkillRuntimePolicy = RuntimePolicy;

export type ArtifactSkillRuntime = {
  tool: ArtifactSkillRuntimeTool;
  run(input: ArtifactSkillRuntimeInput): Promise<ArtifactSkillRuntimeOutput>;
};

export function assertArtifactSkillRuntimeInput(input: ArtifactSkillRuntimeInput): void {
  if (!input.runId.trim()) throw new Error("runId is required");
  if (!Array.isArray(input.sourcePack.refs)) throw new Error("sourcePack.refs must be an array");
  if (!Array.isArray(input.sourcePack.excerpts)) throw new Error("sourcePack.excerpts must be an array");
  if (input.runtimePolicy.allowedTools.includes("tinycloud")) {
    throw new Error("runtime policy must not grant ambient tinycloud authority");
  }
  if (!input.runtimePolicy.disallowedTools.includes("tinycloud")) {
    throw new Error("runtime policy must explicitly disallow ambient tinycloud authority");
  }
  for (const secret of input.secretEnv ?? []) {
    if (secret.source !== "worker_injected" || secret.injection !== "env") {
      throw new Error("runtime secrets must be worker-injected env material only");
    }
    if (typeof secret.secretRef !== "string" || !secret.secretRef.trim()) {
      throw new Error("runtime secrets must include exact secret refs");
    }
  }
}

const SECRET_PATH_PATTERN = /(?:vault\/)?secrets\/[A-Za-z0-9._/-]+/gi;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;
const KEY_VALUE_PATTERN = /\b[A-Za-z0-9_]*(?:api[_-]?key|secret|token|password)=[^\s&]+/gi;
const SECRET_NAME_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?:_API_KEY|_API_TOKEN|_TOKEN|_SECRET|_PASSWORD|_KEY)\b/g;

export function redactArtifactSkillRuntimeText(text: string, sensitiveValues: readonly string[] = []): string {
  let redacted = text;
  for (const value of sensitiveValues) {
    if (!value) continue;
    redacted = redacted.replace(new RegExp(`\\b${escapeRegExp(value)}=([^\\s&]+)`, "g"), "[REDACTED]");
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted
    .replace(SECRET_PATH_PATTERN, "[REDACTED]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(KEY_VALUE_PATTERN, "[REDACTED]")
    .replace(SECRET_NAME_PATTERN, "[REDACTED]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactArtifactSkillRuntimeOutput<T>(value: T, sensitiveValues: readonly string[] = []): T {
  if (typeof value === "string") {
    return redactArtifactSkillRuntimeText(value, sensitiveValues) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactArtifactSkillRuntimeOutput(entry, sensitiveValues)) as T;
  }
  if (!value || typeof value !== "object") return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = redactArtifactSkillRuntimeOutput(entry, sensitiveValues);
  }
  return redacted as T;
}

export function createStubArtifactSkillRuntime(): ArtifactSkillRuntime {
  return {
    tool: RUN_ARTIFACT_SKILL,
    async run(input) {
      assertArtifactSkillRuntimeInput(input);
      return {
        candidates: [],
        trace: {
          procedureVersion: "stub.v1",
          modelCalls: 0,
          toolCalls: [],
          stageTrace: [
            {
              stageId: "stub",
              declaredCapabilities: [],
              grantedCapabilities: [],
              authorityUsed: false,
              deniedReasons: [],
            },
          ],
          droppedCandidates: [],
        },
      };
    },
  };
}
