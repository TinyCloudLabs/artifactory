import { describe, expect, test } from "bun:test";
import { runCli } from "../../packages/artifactory/src/cli-entry.ts";
import { createArtifactory } from "../../packages/artifactory/src/artifactory.ts";
import type { ArtifactSkillRuntime, ArtifactSkillRuntimeInput, ArtifactSkillRuntimeOutput } from "../../packages/artifactory/src/runtime-adapter.ts";
import type { ListenResolverDriver } from "../../packages/artifactory/src/listen-resolver.ts";

const FIXTURE = new URL("./fixtures/listen.workflow.json", import.meta.url).pathname;

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

describe("listen-backed artifactory run", () => {
  test("resolves transcripts, windows them, and prints runtime candidate output", async () => {
    const driver: ListenResolverDriver = {
      async listRecent(limit, offset) {
        return [{ id: "conversation-1" }].slice(offset, offset + limit);
      },
      async loadMany(conversationIds) {
        return conversationIds.map((id) => ({ id }));
      },
      async loadTranscript(_conversationId: string) {
        return [
          { index: 0, text: "aaaa" },
          { index: 1, text: "bbbb" },
        ];
      },
    };

    const runtime: ArtifactSkillRuntime = {
      tool: "RUN_ARTIFACT_SKILL",
      async run(input: ArtifactSkillRuntimeInput): Promise<ArtifactSkillRuntimeOutput> {
        expect(input.sourcePack.refs).toHaveLength(1);
        expect(input.sourcePack.excerpts).toHaveLength(1);
        expect(input.sourcePack.excerpts[0]?.quoteLineRefs).toEqual(["0", "1"]);
        return {
          candidates: [
            {
              schemaVersion: "feed.candidate_artifact.v1",
              localCandidateId: "candidate-1",
              artifactType: "noop",
              renderShape: "short_form",
              title: "resolved candidate",
              body: { text: "resolved" },
              sourceRefs: input.sourcePack.refs,
              quality: { criticPass: true, quotesVerified: true },
              idempotency: {
                sourceFingerprint: "sha256:source",
                artifactFingerprint: "sha256:artifact",
                dedupeKey: "noop:source",
              },
              storage: { docKey: "artifacts/candidate-1.json" },
            },
          ],
          trace: {
            procedureVersion: "test.v1",
            modelCalls: 0,
            toolCalls: [],
            stageTrace: [],
            droppedCandidates: [],
          },
        };
      },
    };

    const artifactory = createArtifactory({
      runtime,
      listenResolverFactory: async () => driver,
    });
    const io = collectingIO();
    const result = await runCli({
      argv: ["run", FIXTURE, "--run-id", "run-listen", "--owner", "listen-owner"],
      io: io.io,
      artifactory,
      now: () => new Date("2026-07-02T00:00:00.000Z"),
    });

    expect(result.exitCode).toBe(0);
    expect(io.stderr).toEqual([]);
    const payload = JSON.parse(io.stdout.join("\n")) as {
      command: string;
      candidateOutput: { title: string }[];
      publishedArtifactIds: string[];
      status: string;
    };
    expect(payload.command).toBe("run");
    expect(payload.status).toBe("published");
    expect(payload.candidateOutput).toHaveLength(1);
    expect(payload.candidateOutput[0]?.title).toBe("resolved candidate");
    expect(payload.publishedArtifactIds).toEqual(["run-listen:candidate-1"]);
  });
});
