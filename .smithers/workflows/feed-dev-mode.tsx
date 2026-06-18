// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Feed Dev Mode
// smithers-description: Probe the HTTPS Feed plus local Artifactory agent development setup.
// smithers-tags: dev, feed, observability
/** @jsxImportSource smithers-orchestrator */
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const inputSchema = z.object({
  feedRoot: z.string().default("../feed"),
  feedHost: z.string().default("https://feed.localhost:1355"),
  agentHost: z.string().default("https://agent.feed.localhost:1355"),
  devEnv: z.string().default("~/development.nosync/distillery/.env"),
});

const checkSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});

const devModeSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  checks: z.array(checkSchema),
  commands: z.array(z.string()),
  notes: z.array(z.string()),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  devMode: devModeSchema,
});

const execFileAsync = promisify(execFile);

function expandHome(path: string): string {
  return path === "~" ? process.env.HOME ?? path : path.replace(/^~\//, `${process.env.HOME ?? "~"}/`);
}

async function curlOk(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await execFileAsync("curl", ["-k", "-sS", "-m", "4", url], { timeout: 5_000 });
    const text = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
    return { ok: true, detail: text.slice(0, 240) };
  } catch (err) {
    const record = err as { stdout?: string; stderr?: string; code?: number };
    const text = `${record.stdout ?? ""}${record.stderr ?? ""}`.trim();
    return { ok: false, detail: text.slice(0, 240) || `exit ${record.code ?? "unknown"}` };
  }
}

export default smithers((ctx) => (
  <Workflow name="feed-dev-mode">
    <Task id="probe" output={outputs.devMode} retries={0}>
      {async () => {
        const cwd = process.cwd();
        const feedRootInput = typeof ctx.input.feedRoot === "string" ? ctx.input.feedRoot : "../feed";
        const feedHost = typeof ctx.input.feedHost === "string" ? ctx.input.feedHost : "https://feed.localhost:1355";
        const agentHost =
          typeof ctx.input.agentHost === "string" ? ctx.input.agentHost : "https://agent.feed.localhost:1355";
        const devEnvInput =
          typeof ctx.input.devEnv === "string" ? ctx.input.devEnv : "~/development.nosync/distillery/.env";
        const feedRoot = resolve(cwd, feedRootInput);
        const devEnv = expandHome(devEnvInput);
        const checks: z.infer<typeof checkSchema>[] = [];

        const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
        add("feed repo", existsSync(resolve(feedRoot, "package.json")), feedRoot);
        add("feed portless script", existsSync(resolve(feedRoot, "node_modules/.bin/portless")), "run `bun install` in ../feed if missing");
        add("agent launcher", existsSync(resolve(cwd, "scripts/artifact-agent-dev-https.sh")), "scripts/artifact-agent-dev-https.sh");
        add("local Gemini env", existsSync(devEnv), `${devEnv} (${existsSync(devEnv) ? "present" : "missing"})`);

        const agent = await curlOk(`${agentHost}/agent/info`);
        add("agent HTTPS endpoint", agent.ok, agent.detail);
        const feed = await curlOk(feedHost);
        add("feed HTTPS endpoint", feed.ok, feed.detail);

        const ok = checks.every((check) => check.ok);
        return {
          ok,
          summary: ok
            ? "Feed HTTPS dev mode is reachable and the local agent endpoint responds."
            : "Feed HTTPS dev mode is not fully ready; inspect failed checks before running generation.",
          checks,
          commands: [
            "cd ../feed && bun run dev",
            "AGENT_API_TOKEN=local-claude-dev PORTLESS_PORT=1355 bun run artifact:agent:dev:https",
            "bunx smithers-orchestrator workflow run feed-dev-mode",
          ],
          notes: [
            "Feed reads VITE_AGENT_CONFIG_OVERRIDE=1, VITE_AGENT_HOST, and VITE_AGENT_TOKEN from ../feed/.env.local.",
            "The agent launcher sources DEV_DISTILLERY_ENV or ~/development.nosync/distillery/.env for GEMINI_API_KEY without copying secrets into this repo.",
            "Long-term, move Gemini and other API keys into TinyCloud Secret Manager instead of local env files.",
          ],
        };
      }}
    </Task>
  </Workflow>
));
