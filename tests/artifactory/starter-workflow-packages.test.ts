import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  compileSkillPackage,
  PackageSourceError,
} from "../../packages/artifactory/src/package-compiler.ts";
import type { WorkflowTrigger } from "../../skills/_shared/lib/feed-v1.ts";

const SKILLS_ROOT = resolve(import.meta.dir, "../../skills");

const STARTER_WORKFLOWS = [
  {
    packageId: "feed-short-insights",
    format: "short_insights",
    artifactType: "insight_collection",
    triggerKind: "source_event",
  },
  {
    packageId: "feed-daily-brief",
    format: "daily_brief",
    artifactType: "daily_brief",
    triggerKind: "scheduled",
  },
  {
    packageId: "feed-exception-alert",
    format: "exception_alert",
    artifactType: "exception_alert",
    triggerKind: "source_event",
  },
  {
    packageId: "feed-synthesis-report",
    format: "synthesis_report",
    artifactType: "synthesis_report",
    triggerKind: "on_demand",
  },
  {
    packageId: "feed-decision-memo",
    format: "decision_memo",
    artifactType: "decision_memo",
    triggerKind: "on_demand",
  },
  {
    packageId: "feed-playbook",
    format: "playbook",
    artifactType: "playbook",
    triggerKind: "on_demand",
  },
] as const;

type StarterWorkflowPack = {
  schemaVersion: string;
  workflowId: string;
  format: string;
  category?: string;
  trigger: WorkflowTrigger;
  sourcePolicy: { window: string; quietResult: string };
  continuity: {
    keyTemplate: string;
    cursor: string;
    usesPriorArtifacts: boolean;
  };
  feedPostContract: {
    minPosts: number;
    maxPosts: number;
    distinctBodies: boolean;
    evidencePerPost: boolean;
    sectionTargetPerPost?: boolean;
  };
  stages: Array<{
    stageId: string;
    capabilities: string[];
    authority: string;
    egressClass: string;
    spendClass: string;
  }>;
};

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function copyTextTree(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyTextTree(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await writeFile(targetPath, await readFile(sourcePath, "utf8"), "utf8");
    }
  }
}

describe("starter workflow package registry", () => {
  test("contains six distinct reviewed formats including a non-intelligence playbook", async () => {
    expect(STARTER_WORKFLOWS).toHaveLength(6);
    expect(new Set(STARTER_WORKFLOWS.map((entry) => entry.packageId)).size).toBe(6);
    expect(new Set(STARTER_WORKFLOWS.map((entry) => entry.format)).size).toBe(6);
    expect(new Set(STARTER_WORKFLOWS.map((entry) => entry.artifactType)).size).toBe(6);

    const playbook = STARTER_WORKFLOWS.find((entry) => entry.packageId === "feed-playbook");
    expect(playbook?.format).toBe("playbook");
    const playbookRoot = join(SKILLS_ROOT, "feed-playbook");
    const workflow = await readJson<StarterWorkflowPack>(
      join(playbookRoot, "workflows/feed-playbook.stub.json"),
    );
    expect(workflow.category).toBe("operations");
    expect(await readFile(join(playbookRoot, "SKILL.md"), "utf8")).toContain(
      "operational knowledge",
    );
  });

  for (const entry of STARTER_WORKFLOWS) {
    test(`compiles ${entry.packageId} with explicit trigger, continuity, and quality contracts`, async () => {
      const root = join(SKILLS_ROOT, entry.packageId);
      const compiled = await compileSkillPackage(root);
      const workflow = compiled.workflowPack as StarterWorkflowPack;
      const outputSchema = await readJson<Record<string, unknown>>(
        join(root, "schemas/output.schema.json"),
      );
      const settingsSchema = await readJson<Record<string, unknown>>(
        join(root, "schemas/settings.schema.json"),
      );

      expect(compiled.package.packageId).toBe(entry.packageId);
      expect(compiled.package.admissionState).toBe("reviewed_first_party");
      expect(compiled.package.trigger).toEqual(workflow.trigger);
      expect(compiled.manifest.artifactTypes).toEqual([entry.artifactType]);
      expect(compiled.manifest.renderShapes).toEqual(["longform"]);
      expect(compiled.manifest.workflowExecutor).toBe("stub");
      expect(compiled.manifest.runtimePolicy).toMatchObject({
        runtimeClass: "stub",
        providerClass: "none",
        credentialMode: "none",
        egressClass: "none",
        allowedTools: [],
        maxModelCalls: 0,
      });
      expect(compiled.policyDecision).toEqual({
        ok: true,
        policyName: "reviewed-bundle-default",
        reasons: [],
      });

      expect(workflow.schemaVersion).toBe("feed.starter_workflow.v1");
      expect(workflow.workflowId).toBe(entry.packageId);
      expect(workflow.format).toBe(entry.format);
      expect(workflow.trigger.kind).toBe(entry.triggerKind);
      expect(workflow.trigger.cadence.length).toBeGreaterThan(0);
      expect(workflow.sourcePolicy.window.length).toBeGreaterThan(0);
      expect(workflow.sourcePolicy.quietResult).toBe("zero_artifacts");
      expect(workflow.continuity.keyTemplate).toContain("{actorId}");
      expect(workflow.continuity.keyTemplate).toContain(entry.packageId);
      expect(workflow.continuity.cursor.length).toBeGreaterThan(0);
      expect(workflow.continuity.usesPriorArtifacts).toBe(true);
      expect(workflow.feedPostContract.minPosts).toBeGreaterThan(0);
      expect(workflow.feedPostContract.maxPosts).toBeGreaterThanOrEqual(
        workflow.feedPostContract.minPosts,
      );
      expect(workflow.feedPostContract.distinctBodies).toBe(true);
      expect(workflow.feedPostContract.evidencePerPost).toBe(true);
      expect(workflow.stages).toEqual([
        {
          stageId: "stub",
          capabilities: [],
          authority: "none",
          egressClass: "none",
          spendClass: "none",
        },
      ]);

      expect(outputSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(outputSchema.type).toBe("object");
      expect(Array.isArray(outputSchema.required)).toBe(true);
      expect((outputSchema.required as unknown[]).length).toBeGreaterThan(0);
      expect(outputSchema.additionalProperties).toBe(false);
      expect(settingsSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(settingsSchema.type).toBe("object");
      expect(settingsSchema.additionalProperties).toBe(false);

      expect(compiled.materials.map((material) => material.path)).toEqual(
        expect.arrayContaining([
          "evaluators/quality.md",
          "schemas/output.schema.json",
          "schemas/settings.schema.json",
          `workflows/${entry.packageId}.stub.json`,
        ]),
      );
      expect(compiled.manifest.validatorRefs).toEqual([
        "schema@1",
        "source_refs@1",
        "critic_pass@1",
      ]);
    });
  }

  test("rejects a workflow changed after its review digest was pinned", async () => {
    const sourceRoot = join(SKILLS_ROOT, "feed-daily-brief");
    const tempRoot = await mkdtemp(join(tmpdir(), "feed-starter-tamper-"));
    try {
      await copyTextTree(sourceRoot, tempRoot);
      const workflowPath = join(tempRoot, "workflows/feed-daily-brief.stub.json");
      const workflow = await readJson<StarterWorkflowPack>(workflowPath);
      workflow.trigger.cadence = "hourly";
      await writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");

      let error: unknown;
      try {
        await compileSkillPackage(tempRoot);
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(PackageSourceError);
      expect((error as Error).message).toContain("workflow digest mismatch");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
