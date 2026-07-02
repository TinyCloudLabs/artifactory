// Argv-driven CLI. Kept small: `run <workflow>` executes a workflow file with
// the stub runtime; `status --run <id> --scope <scope>` prints ledger state.

import { createArtifactory, type Artifactory } from "./artifactory.ts";
import { loadWorkflowFile } from "./workflow.ts";

export type CliIO = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

export type CliOptions = {
  argv: string[];
  io: CliIO;
  artifactory?: Artifactory;
  now?: () => Date;
};

export type CliResult = { exitCode: number };

const USAGE = [
  "Usage:",
  "  @tinycloud/artifactory run <workflow.json> [--run-id <id>] [--owner <ownerId>] [--lease-ms <n>]",
  "  @tinycloud/artifactory status --run <runId> --scope <scope>",
  "  @tinycloud/artifactory --help",
].join("\n");

export async function runCli(options: CliOptions): Promise<CliResult> {
  const { argv, io } = options;
  const now = options.now ?? (() => new Date());
  const artifactory = options.artifactory ?? createArtifactory();

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    io.stdout(USAGE);
    return { exitCode: 0 };
  }

  const command = argv[0];
  if (command === "run") {
    return runCommand(argv.slice(1), artifactory, io, now);
  }
  if (command === "status") {
    return statusCommand(argv.slice(1), artifactory, io);
  }
  io.stderr(`unknown command: ${command}\n${USAGE}`);
  return { exitCode: 2 };
}

async function runCommand(
  args: string[],
  artifactory: Artifactory,
  io: CliIO,
  now: () => Date,
): Promise<CliResult> {
  const workflowPath = args[0];
  if (!workflowPath || workflowPath.startsWith("--")) {
    io.stderr("run: missing workflow file path");
    return { exitCode: 2 };
  }
  const flags = parseFlags(args.slice(1));
  const runId = flags["run-id"] ?? `run-${now().toISOString()}`;
  const ownerId = flags["owner"] ?? "artifactory-cli";
  const leaseMs = flags["lease-ms"] ? Number(flags["lease-ms"]) : 5 * 60 * 1000;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    io.stderr("run: --lease-ms must be a positive integer");
    return { exitCode: 2 };
  }
  const workflow = await loadWorkflowFile(workflowPath);
  const result = await artifactory.run({
    runId,
    ownerId,
    workflow,
    now: now(),
    leaseMs,
  });
  io.stdout(
    JSON.stringify(
      {
        command: "run",
        runId,
        status: result.status,
        candidateOutput: result.runtimeOutput.candidates,
        publishedArtifactIds: result.workflowRun.publishedArtifactIds,
        dropped: result.dropped,
      },
      null,
      2,
    ),
  );
  return { exitCode: result.status === "published" || result.status === "zero_artifacts" ? 0 : 1 };
}

async function statusCommand(
  args: string[],
  artifactory: Artifactory,
  io: CliIO,
): Promise<CliResult> {
  const flags = parseFlags(args);
  const runId = flags["run"];
  const scope = flags["scope"];
  if (!runId || !scope) {
    io.stderr("status: --run and --scope are required");
    return { exitCode: 2 };
  }
  const status = await artifactory.status({ runId, scope });
  io.stdout(JSON.stringify(status, null, 2));
  return { exitCode: 0 };
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || !arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}
