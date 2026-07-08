import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createArtifactory } from "../../packages/artifactory/src/artifactory.ts";
import { runCli } from "../../packages/artifactory/src/cli-entry.ts";
import { compileSkillPackage } from "../../packages/artifactory/src/package-compiler.ts";
import { PackageAdmissionError } from "../../packages/artifactory/src/package-policy.ts";
import { loadWorkflowFile } from "../../packages/artifactory/src/workflow.ts";
import type {
  ArtifactSkillRuntime,
  ArtifactSkillRuntimeInput,
  ArtifactSkillRuntimeOutput,
} from "../../packages/artifactory/src/runtime-adapter.ts";

const FIXTURE_ROOT = resolve(import.meta.dir, "./fixtures");
const DEFAULT_BUNDLE_DIR = join(FIXTURE_ROOT, "default-reviewed-bundle");
const DEFAULT_BUNDLE_WORKFLOW = join(FIXTURE_ROOT, "default-reviewed-bundle.workflow.json");
const DEFAULT_BUNDLE_EXPECTED = join(FIXTURE_ROOT, "default-reviewed-bundle.expected.json");
const DEFAULT_BUNDLE_EXPECTED_CANDIDATE = join(
  DEFAULT_BUNDLE_DIR,
  "fixtures/expected-candidate.json",
);
const DEFAULT_BUNDLE_SOURCE_PACK = join(DEFAULT_BUNDLE_DIR, "fixtures/source-pack.json");

function collectingIO() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
  };
}

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
      continue;
    }
    if (entry.isFile()) {
      await writeFile(targetPath, await readFile(sourcePath, "utf8"), "utf8");
    }
  }
}

async function makeTempBundleCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "artifactory-package-"));
  await copyTextTree(DEFAULT_BUNDLE_DIR, root);
  return root;
}

async function makeFrontmatterBundleCopy(): Promise<string> {
  const root = await makeTempBundleCopy();
  await rm(join(root, "skill.toml"), { force: true });
  const contract = await readFile(join(DEFAULT_BUNDLE_DIR, "skill.toml"), "utf8");
  const body = await readFile(join(DEFAULT_BUNDLE_DIR, "SKILL.md"), "utf8");
  await writeFile(join(root, "SKILL.md"), `---\n${contract.trimEnd()}\n---\n${body}`, "utf8");
  return root;
}

async function makeOverCapabilityBundleCopy(): Promise<string> {
  const root = await makeTempBundleCopy();
  const skillTomlPath = join(root, "skill.toml");
  let skillToml = await readFile(skillTomlPath, "utf8");
  skillToml = skillToml.replace('runtime_class = "stub"', 'runtime_class = "feed_hosted"');
  skillToml = skillToml.replace('provider_class = "none"', 'provider_class = "first_party"');
  skillToml = skillToml.replace('credential_mode = "none"', 'credential_mode = "feed_hosted"');
  skillToml = skillToml.replace('egress_class = "none"', 'egress_class = "model_provider"');
  skillToml = skillToml.replace("allowed_tools = []", 'allowed_tools = ["web_search"]');
  skillToml = skillToml.replace("max_model_calls = 0", "max_model_calls = 1");
  skillToml = skillToml.replace("max_output_bytes = 4096", "max_output_bytes = 8192");
  await writeFile(skillTomlPath, skillToml, "utf8");
  return root;
}

async function makeValidatorRefBundleCopy(): Promise<string> {
  const root = await makeTempBundleCopy();
  const skillTomlPath = join(root, "skill.toml");
  const skillToml = await readFile(skillTomlPath, "utf8");
  await mkdir(join(root, "validators"), { recursive: true });
  await writeFile(join(root, "validators/custom.ts"), "export const customValidator = true;\n", "utf8");
  await writeFile(
    skillTomlPath,
    skillToml.replace("validator_refs = []", 'validator_refs = ["schema", "validators/custom.ts"]'),
    "utf8",
  );
  return root;
}

async function makeRunWorkspace(options: { tamperDigest?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "artifactory-run-"));
  await copyTextTree(DEFAULT_BUNDLE_DIR, join(root, "default-reviewed-bundle"));
  const workflow = await readFile(DEFAULT_BUNDLE_WORKFLOW, "utf8");
  const parsed = JSON.parse(workflow) as Record<string, unknown>;
  if (options.tamperDigest) {
    parsed.digest = "sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const skillManifest = parsed.skillManifest as Record<string, unknown>;
    skillManifest.digest = parsed.digest;
  }
  await writeFile(join(root, "default-reviewed-bundle.workflow.json"), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return root;
}

function teardown(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true });
}

describe("package compiler", () => {
  test("produces the committed digest vector", async () => {
    const expected = await readJson<{
      manifestDigest: string;
      workflowDigest: string;
      packageDigest: string;
      materials: { path: string; kind: "binary" | "json" | "text" | "toml"; digest: string }[];
    }>(DEFAULT_BUNDLE_EXPECTED);
    const compiled = await compileSkillPackage(DEFAULT_BUNDLE_DIR);

    expect(compiled.manifest.digest).toBe(expected.manifestDigest);
    expect(compiled.package.digest).toBe(expected.packageDigest);
    expect(compiled.manifest.workflowDigest).toBe(expected.workflowDigest);
    expect(compiled.workflowPack.workflowId).toBe("default-reviewed-bundle");
    expect(compiled.policyDecision.ok).toBe(true);
    expect(compiled.policyDecision.reasons).toEqual([]);
    expect(compiled.materials).toEqual(expected.materials);
  });

  test("compiles the shorthand frontmatter form to the same digest", async () => {
    const root = await makeFrontmatterBundleCopy();
    try {
      const expected = await readJson<{ manifestDigest: string; workflowDigest: string; packageDigest: string }>(
        DEFAULT_BUNDLE_EXPECTED,
      );
      const compiled = await compileSkillPackage(root);
      expect(compiled.package.digest).toBe(expected.packageDigest);
      expect(compiled.manifest.digest).toBe(expected.manifestDigest);
      expect(compiled.manifest.workflowDigest).toBe(expected.workflowDigest);
    } finally {
      await teardown(root);
    }
  });

  test("rejects packages that exceed the reviewed bundle policy", async () => {
    const root = await makeOverCapabilityBundleCopy();
    try {
      let error: unknown;
      try {
        await compileSkillPackage(root);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(PackageAdmissionError);
      if (error instanceof PackageAdmissionError) {
        expect(error.reasons.some((reason) => reason.includes("runtimePolicy.runtimeClass"))).toBe(true);
        expect(error.reasons.some((reason) => reason.includes("runtimePolicy.maxOutputBytes"))).toBe(true);
        expect(error.reasons.some((reason) => reason.includes("runtimePolicy.maxModelCalls"))).toBe(true);
      }
    } finally {
      await teardown(root);
    }
  });

  test("resolves validator refs as platform ids before package files", async () => {
    const root = await makeValidatorRefBundleCopy();
    try {
      const compiled = await compileSkillPackage(root);
      expect(compiled.manifest.validatorRefs).toEqual(["schema@1", "validators/custom.ts"]);
      expect(compiled.materials.some((material) => material.path === "validators/custom.ts")).toBe(true);
      expect(compiled.materials.some((material) => material.path === "schema@1")).toBe(false);
      expect(compiled.policyDecision.ok).toBe(true);
    } finally {
      await teardown(root);
    }
  });
});

describe("default reviewed bundle run", () => {
  test("compiles and runs through the CLI against the stub runtime", async () => {
    const runRoot = await makeRunWorkspace();
    try {
      const workflowPath = join(runRoot, "default-reviewed-bundle.workflow.json");
      const workflow = await loadWorkflowFile(workflowPath);
      const sourcePack = await readJson<typeof workflow.sourcePack>(DEFAULT_BUNDLE_SOURCE_PACK);
      expect(workflow.sourcePack).toEqual(sourcePack);

      type ExpectedCandidate = {
        schemaVersion: "feed.candidate_artifact.v1";
        localCandidateId: string;
        artifactType: string;
        renderShape: "short_form";
        title: string;
        summary?: string;
        body: { text: string };
        sourceRefs: typeof workflow.sourcePack.refs;
        quality: {
          criticPass: boolean;
          quotesVerified: boolean;
          reasons: string[];
          warnings: string[];
        };
        idempotencyBasis: {
          sourceFingerprintMaterial: string[];
          artifactFingerprintMaterial: { text: string };
        };
      };
      const expectedCandidate = await readJson<ExpectedCandidate>(DEFAULT_BUNDLE_EXPECTED_CANDIDATE);

      let seenInput: ArtifactSkillRuntimeInput | undefined;
      const runtime: ArtifactSkillRuntime = {
        tool: "RUN_ARTIFACT_SKILL",
        async run(input: ArtifactSkillRuntimeInput): Promise<ArtifactSkillRuntimeOutput> {
          seenInput = input;
          return {
            candidates: [expectedCandidate],
            trace: {
              procedureVersion: "stub.test.v1",
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

      const io = collectingIO();
      const artifactory = createArtifactory({ runtime });
      const result = await runCli({
        argv: ["run", workflowPath, "--run-id", "run-reviewed-bundle", "--owner", "cli-owner", "--lease-ms", "60000"],
        io: io.io,
        artifactory,
        now: () => new Date("2026-07-02T00:00:00.000Z"),
      });

      expect(result.exitCode).toBe(0);
      expect(io.stderr).toEqual([]);
      const payload = JSON.parse(io.stdout.join("\n")) as {
        command: string;
        runId: string;
        status: string;
        candidateOutput: { title: string }[];
        publishedArtifactIds: string[];
      };
      expect(payload.command).toBe("run");
      expect(payload.runId).toBe("run-reviewed-bundle");
      expect(payload.status).toBe("published");
      expect(payload.candidateOutput).toHaveLength(1);
      expect(payload.candidateOutput[0]?.title).toBe(expectedCandidate.title);
      expect(payload.publishedArtifactIds).toEqual(["run-reviewed-bundle:candidate-1"]);
      expect(seenInput?.skillManifest.digest).toBe("sha256:0f5f8ef9566a58824e7f6008b2f047a4181d4be90a58f66aabe973b083e100b6");
      expect(seenInput?.skillManifest.workflowDigest).toBe("sha256:1949c691df27c44afc5818e88b0ce245b7c8de9e70583d1eff1a1d560f6a8f35");
      expect(seenInput?.runtimePolicy.runtimeClass).toBe("stub");
    } finally {
      await teardown(runRoot);
    }
  });

  test("refuses a tampered package digest before execution", async () => {
    const runRoot = await makeRunWorkspace({ tamperDigest: true });
    try {
      const workflowPath = join(runRoot, "default-reviewed-bundle.workflow.json");
      const io = collectingIO();
      const result = await runCli({
        argv: ["run", workflowPath, "--run-id", "run-tampered", "--owner", "cli-owner"],
        io: io.io,
        artifactory: createArtifactory(),
        now: () => new Date("2026-07-02T00:00:00.000Z"),
      });

      expect(result.exitCode).toBe(1);
      expect(io.stdout).toEqual([]);
      expect(io.stderr.join("\n")).toContain("run: failed (PackageSourceError); details redacted");
    } finally {
      await teardown(runRoot);
    }
  });
});
