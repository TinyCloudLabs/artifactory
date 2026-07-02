import { describe, expect, test } from "bun:test";
import { runCli } from "../../packages/artifactory/src/cli-entry.ts";
import { createArtifactory } from "../../packages/artifactory/src/artifactory.ts";

const FIXTURE = new URL("./fixtures/noop.workflow.json", import.meta.url).pathname;

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

describe("artifactory CLI", () => {
  test("run <workflow> executes the deterministic pipeline end-to-end", async () => {
    const io = collectingIO();
    const artifactory = createArtifactory();
    const now = new Date("2026-07-02T00:00:00.000Z");
    const result = await runCli({
      argv: ["run", FIXTURE, "--run-id", "run-cli", "--owner", "cli-owner", "--lease-ms", "60000"],
      io: io.io,
      artifactory,
      now: () => now,
    });
    expect(result.exitCode).toBe(0);
    expect(io.stderr).toEqual([]);
    const payload = JSON.parse(io.stdout.join("\n"));
    expect(payload.command).toBe("run");
    expect(payload.runId).toBe("run-cli");
    expect(payload.status).toBe("zero_artifacts");
    expect(payload.publishedArtifactIds).toEqual([]);
  });

  test("status --run --scope reports lock and ledger state", async () => {
    const io = collectingIO();
    const artifactory = createArtifactory();
    const now = new Date("2026-07-02T00:00:00.000Z");
    await runCli({
      argv: ["run", FIXTURE, "--run-id", "run-status", "--owner", "cli-owner"],
      io: io.io,
      artifactory,
      now: () => now,
    });
    const statusIO = collectingIO();
    const statusResult = await runCli({
      argv: ["status", "--run", "run-status", "--scope", "noop-package"],
      io: statusIO.io,
      artifactory,
    });
    expect(statusResult.exitCode).toBe(0);
    const status = JSON.parse(statusIO.stdout.join("\n"));
    expect(status.runId).toBe("run-status");
    expect(status.lock).toBeNull();
    expect(status.sourceRefs.length).toBe(1);
    expect(Array.isArray(status.publishedArtifacts)).toBe(true);
  });

  test("--help prints usage", async () => {
    const io = collectingIO();
    const result = await runCli({ argv: ["--help"], io: io.io });
    expect(result.exitCode).toBe(0);
    expect(io.stdout.join("\n")).toContain("Usage:");
  });

  test("unknown command exits non-zero", async () => {
    const io = collectingIO();
    const result = await runCli({ argv: ["bogus"], io: io.io });
    expect(result.exitCode).toBe(2);
    expect(io.stderr.join("\n")).toContain("unknown command");
  });

  test("run missing workflow path errors", async () => {
    const io = collectingIO();
    const result = await runCli({ argv: ["run"], io: io.io });
    expect(result.exitCode).toBe(2);
    expect(io.stderr.join("\n")).toContain("missing workflow file path");
  });

  test("status missing --run errors", async () => {
    const io = collectingIO();
    const result = await runCli({ argv: ["status", "--scope", "x"], io: io.io });
    expect(result.exitCode).toBe(2);
    expect(io.stderr.join("\n")).toContain("--run and --scope are required");
  });
});
