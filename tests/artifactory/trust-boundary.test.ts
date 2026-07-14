import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createArtifactory } from "../../packages/artifactory/src/artifactory.ts";
import { compileSkillPackage } from "../../packages/artifactory/src/package-compiler.ts";
import {
  loadReviewedBundlePolicy,
  PackageAdmissionError,
} from "../../packages/artifactory/src/package-policy.ts";
import { loadWorkflowFile } from "../../packages/artifactory/src/workflow.ts";
import type { CandidateArtifactEnvelope } from "../../skills/_shared/lib/feed-v1.ts";

const ROOT = resolve(import.meta.dir, "./fixtures/default-reviewed-bundle");
const WORKFLOW = resolve(import.meta.dir, "./fixtures/default-reviewed-bundle.workflow.json");
const CANDIDATE = resolve(ROOT, "fixtures/expected-candidate.json");

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("reviewed package trust boundary", () => {
  test("exposes normalized, content-addressed execution material and enforces exact optional pins", async () => {
    const compiled = await compileSkillPackage(ROOT);
    expect(compiled.executionBundle.packageDigest).toBe(compiled.package.digest);
    expect(compiled.executionBundle.instructions).toEndWith("\n");
    expect(compiled.executionBundle.outputSchema).toMatchObject({ type: "object" });
    expect(compiled.executionBundle.evaluators[0]).toMatchObject({ ref: "evaluators/review.md" });
    expect(compiled.executionBundle.materialDigests.some((entry) => entry.path === "SKILL.md")).toBe(true);

    const policy = await loadReviewedBundlePolicy();
    const pinnedPolicy = {
      ...policy,
      reviewedPackagePins: { [compiled.package.packageId]: [compiled.package.digest] },
    };
    expect((await compileSkillPackage(ROOT, { policy: pinnedPolicy })).policyDecision.ok).toBe(true);

    await expect(compileSkillPackage(ROOT, {
      policy: {
        ...policy,
        reviewedPackagePins: { [compiled.package.packageId]: ["sha256:not-the-reviewed-package"] },
      },
    })).rejects.toBeInstanceOf(PackageAdmissionError);
  });

  test("passes trusted execution and request context while dropping contract violations", async () => {
    const workflow = await loadWorkflowFile(WORKFLOW);
    const valid = await json<CandidateArtifactEnvelope>(CANDIDATE);
    valid.quality.quotesVerified = false;
    const invalidBody = structuredClone(valid);
    invalidBody.localCandidateId = "invalid-body";
    invalidBody.body = { wrong: true };
    const invalidType = structuredClone(valid);
    invalidType.localCandidateId = "invalid-type";
    invalidType.artifactType = "undeclared";
    const invalidShape = structuredClone(valid);
    invalidShape.localCandidateId = "invalid-shape";
    invalidShape.renderShape = "longform";
    const failedCritic = structuredClone(valid);
    failedCritic.localCandidateId = "failed-critic";
    failedCritic.quality.criticPass = false;

    const requestContext = {
      scope: { packageId: workflow.packageId, sourceRefId: "src-default" },
      prompt: "Compare the two options for the human reviewer.",
    };
    const artifactory = createArtifactory({
      runtime: {
        tool: "RUN_ARTIFACT_SKILL",
        async run(input) {
          expect(input.executionBundle?.packageDigest).toBe(workflow.digest);
          expect(input.executionBundle?.evaluators[0]?.instructions).toContain("review");
          expect(input.requestContext).toEqual(requestContext);
          return {
            candidates: [invalidBody, invalidType, invalidShape, failedCritic, valid],
            trace: { procedureVersion: "trust-boundary.v1", modelCalls: 0, toolCalls: [], stageTrace: [], droppedCandidates: [] },
          };
        },
      },
    });
    const result = await artifactory.run({
      runId: "run-trust-boundary",
      ownerId: "worker-trust-boundary",
      workflow,
      requestContext,
      now: new Date("2026-07-14T00:00:00.000Z"),
      leaseMs: 60_000,
    });

    expect(result.status).toBe("published");
    expect(result.publishedArtifacts).toHaveLength(1);
    expect(result.dropped.map((entry) => entry.reason).join("\n")).toContain("required property 'text'");
    expect(result.dropped.map((entry) => entry.reason).join("\n")).toContain("artifactType: not declared");
    expect(result.dropped.map((entry) => entry.reason).join("\n")).toContain("renderShape: not declared");
    expect(result.dropped.map((entry) => entry.reason).join("\n")).toContain("quality.criticPass: must be true");
  });
});
