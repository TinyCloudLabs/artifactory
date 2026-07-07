// Workflow definition loaded by the CLI. Trivially small on purpose — the
// full manifest lives in ArtifactorySkillManifest (feed-v1.ts); this shape is
// only what `artifactory run <workflow>` needs to prepare a SkillRunInput.

import { readFile } from "node:fs/promises";
import type {
  RuntimePolicy,
  TranscriptSourceRef,
  ArtifactorySkillManifest,
} from "../../../skills/_shared/lib/feed-v1.ts";

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
  settings: unknown;
  maxAcceptedArtifacts: number;
};

export async function loadWorkflowFile(path: string): Promise<WorkflowFixture> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return parseWorkflow(parsed);
}

export function parseWorkflow(value: unknown): WorkflowFixture {
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
  return obj as unknown as WorkflowFixture;
}
