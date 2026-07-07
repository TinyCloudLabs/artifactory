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
