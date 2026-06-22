// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Feed Loop Orchestration
// smithers-description: Report the Smithers control-plane status for the Artifactory/Feed loop without spending on live generation.
// smithers-tags: feed, artifactory, smithers, orchestration, observability
/** @jsxImportSource smithers-orchestrator */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const repoRoot = resolve(import.meta.dir, "..", "..");
const execFileAsync = promisify(execFile);

const inputSchema = z.object({
  timeoutMs: z.number().int().min(1_000).max(10 * 60_000).default(180_000),
});

const checkSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  status: z.enum(["pass", "fail", "warn"]),
  detail: z.string(),
  command: z.string().optional(),
});

const feedLoopSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  reportPath: z.string(),
  checks: z.array(checkSchema),
  smithersOwned: z.array(z.string()),
  stillHttpOwned: z.array(z.string()),
  canonicalCommands: z.array(z.string()),
  nextMigrationSteps: z.array(z.string()),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  feedLoop: feedLoopSchema,
});

type Check = z.infer<typeof checkSchema>;

function detail(stdout?: string, stderr?: string, message?: string): string {
  return (`${stdout ?? ""}${stderr ?? ""}`.trim() || message || "").slice(-3_000);
}

function fileIncludes(path: string, snippets: string[]): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  return snippets.every((snippet) => text.includes(snippet));
}

function fileCheck(name: string, path: string, snippets: string[] = []): Check {
  if (!existsSync(path)) {
    return { name, ok: false, status: "fail", detail: `${path} is missing` };
  }
  if (snippets.length > 0 && !fileIncludes(path, snippets)) {
    return {
      name,
      ok: false,
      status: "fail",
      detail: `${path} exists but is missing expected marker(s): ${snippets.join(", ")}`,
    };
  }
  return { name, ok: true, status: "pass", detail: snippets.length ? `${path} contains expected markers` : `${path} exists` };
}

async function commandCheck(name: string, args: string[], timeoutMs: number): Promise<Check> {
  const command = `bun ${args.join(" ")}`;
  try {
    const res = await execFileAsync("bun", args, {
      cwd: repoRoot,
      timeout: timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
    });
    return { name, ok: true, status: "pass", command, detail: detail(res.stdout, res.stderr) || "passed" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { name, ok: false, status: "fail", command, detail: detail(e.stdout, e.stderr, e.message) };
  }
}

function packageScriptCheck(name: string, script: string): Check {
  const packagePath = resolve(repoRoot, "package.json");
  if (!existsSync(packagePath)) return { name, ok: false, status: "fail", detail: "package.json is missing" };
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
  const command = pkg.scripts?.[script];
  if (!command) return { name, ok: false, status: "fail", detail: `missing package script ${script}` };
  return { name, ok: true, status: "pass", detail: `${script}: ${command}` };
}

async function writeReport(report: z.infer<typeof feedLoopSchema>): Promise<string> {
  const reportsDir = resolve(repoRoot, ".smithers", "reports");
  await mkdir(reportsDir, { recursive: true });
  const file = resolve(reportsDir, `feed-loop-orchestration-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify({ ...report, reportPath: file }, null, 2) + "\n", "utf8");
  return file;
}

export default smithers((ctx) => (
  <Workflow name="feed-loop-orchestration">
    <Task id="feed-loop" output={outputs.feedLoop} timeoutMs={10 * 60_000}>
      {async () => {
        const timeoutMs = ctx.input.timeoutMs ?? 180_000;
        const checks: Check[] = [
          fileCheck("readiness workflow", resolve(repoRoot, ".smithers/workflows/feed-loop-readiness.tsx"), [
            "Feed Loop Readiness",
          ]),
          fileCheck("composition workflow", resolve(repoRoot, ".smithers/workflows/feed-composition-smoke.tsx"), [
            "Feed Composition Smoke",
          ]),
          fileCheck("staged live workflow", resolve(repoRoot, ".smithers/workflows/agent-run-staged.tsx"), [
            "preflight",
            "runListenReadStage",
            "runGenerateStage",
            "runPublishStage",
          ]),
          fileCheck("media proof workflow", resolve(repoRoot, ".smithers/workflows/full-media-generation-smoke.tsx"), [
            "full-media-generation-smoke",
          ]),
          fileCheck("runner stage exports", resolve(repoRoot, "harness/agent/src/runner.ts"), [
            "export async function runListenReadStage",
            "export async function runGenerateStage",
            "export async function runPublishStage",
          ]),
          packageScriptCheck("package script: smithers:feed-loop", "smithers:feed-loop"),
          packageScriptCheck("package script: smithers:readiness", "smithers:readiness"),
          packageScriptCheck("package script: smithers:composition", "smithers:composition"),
          packageScriptCheck("package script: smithers:agent-run:staged", "smithers:agent-run:staged"),
          packageScriptCheck("package script: smithers:media-smoke", "smithers:media-smoke"),
        ];

        checks.push(await commandCheck("deterministic feed composition gate", ["test", "tests/agent-runner.test.ts", "tests/feed-run.test.ts", "tests/preference-signal.test.ts"], timeoutMs));

        const stillHttpOwned = [
          "Feed-triggered production runs still enter through POST /agent/run in harness/agent/src/server.ts.",
          "The HTTP endpoint still calls the shared runner directly; Smithers is the operator/dev control plane, not the production HTTP executor.",
          "Browser sign-in/delegation remains OpenKey-owned and cannot be automated headlessly by Smithers.",
        ];
        const smithersOwned = [
          "No-spend readiness: smithers:readiness",
          "No-spend composition/backpressure gate: smithers:composition",
          "Stage-level delegated live runner: smithers:agent-run:staged",
          "Full rich-media plumbing proof: smithers:media-smoke",
          "Control-plane status report: smithers:feed-loop",
        ];
        const canonicalCommands = [
          "bun run smithers:feed-loop",
          "bun run smithers:readiness",
          "bun run smithers:composition",
          "bun run smithers:agent-run:staged -- --input '{\"artifactType\":\"clip\",\"logTail\":80}'",
          "bun run smithers:agent-run:staged -- --input '{\"artifactType\":\"podcast\",\"logTail\":80}'",
          "bun run smithers:agent-run:staged -- --input '{\"artifactType\":\"article\",\"logTail\":80}'",
          "bun run smithers:media-smoke -- --input '{\"publish\":true}'",
        ];
        const nextMigrationSteps = [
          "Decide whether production POST /agent/run should invoke Smithers tasks or remain on the shared runner with Smithers as the operator plane.",
          "If moving production onto Smithers, make /agent/run create/observe a Smithers agent-run-staged instance and translate node outputs back into the existing Feed run status shape.",
          "Add a persisted feed-mix policy artifact so Smithers, the HTTP runner, and Feed can explain why video/podcast/article/compact artifacts were selected or skipped.",
          "Add signed-in browser media checks for Feed card rendering; headless checks without the owner session stop at the Connect page.",
        ];
        const failed = checks.filter((check) => !check.ok && check.status === "fail");
        const report = {
          ok: failed.length === 0,
          summary:
            failed.length === 0
              ? "Smithers feed-loop control plane is present: readiness, composition, staged live runs, media proof, and this orchestration report are available."
              : `Smithers feed-loop control plane has failing checks: ${failed.map((check) => check.name).join(", ")}.`,
          reportPath: "",
          checks,
          smithersOwned,
          stillHttpOwned,
          canonicalCommands,
          nextMigrationSteps,
        };
        report.reportPath = await writeReport(report);
        return report;
      }}
    </Task>
  </Workflow>
));
