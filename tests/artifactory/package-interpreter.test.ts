import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileOutputBodySchema } from "../../packages/artifactory/src/output-schema.ts";
import {
  assertFeedPostContract,
  executePackageProfile,
  loadPackageExecutionProfile,
  type AssembledPackagePrompt,
} from "../../harness/feed-v1-worker/package-execution.ts";
import { REVIEWED_STARTER_PACKAGES } from "../../skills/_shared/lib/starter-packages.ts";
import { validateFeedArtifact, type TranscriptSourceRef } from "../../skills/_shared/lib/feed-v1.ts";
import type { GenerationSource } from "../../harness/feed-v1-worker/generate.ts";
import { ArtifactQualityRejectedError } from "../../harness/feed-v1-worker/generate.ts";

const FIXTURE_PATH = resolve(import.meta.dir, "fixtures/package-interpreter/source-batch.json");

type PackageEvalFixture = {
  requestPrompt: string;
  sources: GenerationSource[];
};

async function fixture(): Promise<PackageEvalFixture> {
  return JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as PackageEvalFixture;
}

function sourceRefs(sources: GenerationSource[]): TranscriptSourceRef[] {
  return sources.map((source) => ({
    sourceRefId: `fixture:${source.sourceId}`,
    sourceKind: "listen_conversation",
    sourceId: source.sourceId,
    observedPath: "host_source_api",
    observedHash: source.transcriptSha256,
    observedAt: source.startedAt ?? "2026-08-09T14:00:00.000Z",
  }));
}

describe("starter package execution interpreter eval", () => {
  test("all six reviewed starters produce valid, contracted, attributable output with distinct prompts", async () => {
    const shared = await fixture();
    const prompts = new Map<string, AssembledPackagePrompt>();

    for (const declared of REVIEWED_STARTER_PACKAGES) {
      const profile = await loadPackageExecutionProfile(declared.packageId);
      const result = await executePackageProfile({
        profile,
        requestId: `eval-${declared.packageId}`,
        runId: `eval-${declared.packageId}`,
        prompt: shared.requestPrompt,
        settings: {},
        transcriptDirs: [],
        sources: shared.sources,
        sourceRefs: sourceRefs(shared.sources),
        model: "stub",
        generator: "stub",
        producer: {
          runtimeClass: "stub",
          providerClass: "none",
          credentialOwner: "none",
          egressClass: "none",
        },
        onPrompt: (assembled) => prompts.set(declared.packageId, assembled),
      });

      expect(compileOutputBodySchema(profile.outputSchema)(result.feedArtifact.body)).toEqual([]);
      expect(assertFeedPostContract(result.feedArtifact.posts ?? [], profile.feedPostContract)).toEqual([]);
      expect(validateFeedArtifact(result.feedArtifact).ok).toBe(true);
      expect(result.feedArtifact.producedBy).toMatchObject({
        packageId: declared.packageId,
        packageVersion: declared.version,
        packageDigest: declared.digest,
        disclosure: declared.disclosure,
      });
      expect(result.feedArtifact.posts?.length).toBeGreaterThanOrEqual(profile.feedPostContract.minPosts);
      expect(result.feedArtifact.posts?.length).toBeLessThanOrEqual(profile.feedPostContract.maxPosts);
    }

    expect(prompts.size).toBe(6);
    expect(new Set([...prompts.values()].map((prompt) => prompt.system)).size).toBe(6);
    expect(new Set([...prompts.values()].map((prompt) => prompt.user)).size).toBe(6);
    for (const [packageId, prompt] of prompts) {
      expect(prompt.system).toContain(packageId);
      expect(prompt.system).toContain("SKILL.md contract");
      expect(prompt.user).toContain("Settings defaults");
      expect(prompt.user).toContain("Launch readiness review");
    }
  });

  test("refuses unknown packages while reserving the legacy default for fallback", async () => {
    await expect(loadPackageExecutionProfile("not-reviewed")).rejects.toThrow("unknown reviewed starter package");
    await expect(loadPackageExecutionProfile("artifactory.extract-insights")).rejects.toThrow("legacy default workflow");
  });

  test("treats package-schema failures as a two-attempt quality rejection", async () => {
    const shared = await fixture();
    const profile = await loadPackageExecutionProfile("feed-daily-brief");
    const quote = "The launch date stays Friday only if the migration rehearsal finishes by Wednesday and the rollback owner signs off.";
    let attempts = 0;
    const execution = executePackageProfile({
      profile,
      requestId: "eval-invalid-body",
      runId: "eval-invalid-body",
      prompt: shared.requestPrompt,
      transcriptDirs: [],
      sources: shared.sources,
      sourceRefs: sourceRefs(shared.sources),
      model: "stub",
      generator: "stub",
      producer: { runtimeClass: "stub", providerClass: "none", credentialOwner: "none", egressClass: "none" },
      packageDraftGenerator: ({ attempt }) => {
        attempts = attempt;
        return {
          title: "Daily Brief: invalid package body",
          body: {},
          posts: [{
            kind: "daily_brief",
            body: "A grounded but schema-invalid daily brief post.",
            evidenceSourceIds: ["conversation-package-eval"],
            sectionId: "priority-1",
          }],
          card: {
            markdown: Array.from({ length: 160 }, (_, index) => `grounded${index + 1}`).join(" "),
            quote,
            attribution: "Avery",
            tags: ["daily", "operations"],
            sourceQuotes: [{ transcript: "listen:conversation-package-eval", quote, speaker: "Avery" }],
          },
        };
      },
    });
    await expect(execution).rejects.toBeInstanceOf(ArtifactQualityRejectedError);
    expect(attempts).toBe(2);
  });
});
