// smithers-source: local
// smithers-metadata-version: 1
// smithers-display-name: Full Media Generation Smoke
// smithers-description: Generate one video, one podcast, and one image-backed editorial artifact through the real Artifactory skills.
// smithers-tags: smithers, artifactory, video, podcast, image, publish, smoke
/** @jsxImportSource smithers-orchestrator */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dir, "..", "..");

const inputSchema = z.object({
  publish: z.boolean().default(false),
  duration: z.enum(["4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "auto"]).default("4"),
  resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
  aspect: z.enum(["1:1", "9:16", "16:9"]).default("1:1"),
  envFile: z.string().default(process.env.DEV_DISTILLERY_ENV ?? "~/development.nosync/distillery/.env"),
});

const artifactSchema = z.object({
  kind: z.enum(["clip", "podcast", "article"]),
  dir: z.string(),
  jsonPath: z.string(),
  media: z.array(z.string()),
  commandNotes: z.array(z.string()),
});

const mediaSummarySchema = z.object({
  heroImages: z.number().int().nonnegative(),
  audio: z.number().int().nonnegative(),
  video: z.number().int().nonnegative(),
});

const publishedSchema = z.object({
  type: z.string(),
  slug: z.string(),
  media: z
    .object({
      heroImage: z.boolean(),
      audio: z.boolean(),
      video: z.boolean(),
    })
    .optional(),
});

const smokeSchema = z.object({
  ok: z.boolean(),
  command: z.string(),
  reportPath: z.string(),
  outDir: z.string().optional(),
  artifacts: z.array(artifactSchema),
  publish: z.union([
    z.object({ skipped: z.literal(true), reason: z.string() }),
    z.object({
      runId: z.string(),
      statusFile: z.string(),
      published: z.array(publishedSchema),
      held: z.array(z.object({ type: z.string(), slug: z.string(), reason: z.string() })),
      media: mediaSummarySchema,
      log: z.array(z.string()),
    }),
  ]),
  error: z.string().optional(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  smoke: smokeSchema,
});

function tail(text: string, max = 3000): string {
  return text.length > max ? `...${text.slice(-max)}` : text;
}

function wantsPublish(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

export default smithers((ctx) => (
  <Workflow name="full-media-generation-smoke">
    <Task
      id="smoke"
      output={outputs.smoke}
      timeoutMs={60 * 60_000}
      heartbeatTimeoutMs={35 * 60_000}
      maxAttempts={1}
    >
      {async () => {
        const args = [
          "scripts/full-media-smoke.ts",
          "--env-file",
          ctx.input.envFile ?? "~/development.nosync/distillery/.env",
          "--duration",
          ctx.input.duration ?? "4",
          "--resolution",
          ctx.input.resolution ?? "480p",
          "--aspect",
          ctx.input.aspect ?? "1:1",
        ];
        if (wantsPublish(ctx.input.publish)) args.push("--publish");
        const command = `bun ${args.join(" ")}`;

        try {
          const res = await execFileAsync("bun", args, {
            cwd: repoRoot,
            timeout: 60 * 60_000,
            maxBuffer: 20 * 1024 * 1024,
          });
          const printed = JSON.parse(res.stdout.trim()) as { reportPath: string };
          const report = JSON.parse(await readFile(printed.reportPath, "utf8")) as Record<string, unknown>;
          return {
            ok: report.ok === true,
            command,
            reportPath: printed.reportPath,
            outDir: typeof report.outDir === "string" ? report.outDir : undefined,
            artifacts: Array.isArray(report.artifacts) ? report.artifacts : [],
            publish: report.publish ?? { skipped: true, reason: "missing publish report" },
            ...(typeof report.error === "string" ? { error: report.error } : {}),
          };
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message?: string };
          const message = tail(`${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`.trim());
          let reportPath = "";
          try {
            const parsed = JSON.parse(e.stderr?.trim() || e.stdout?.trim() || "{}") as { reportPath?: unknown };
            if (typeof parsed.reportPath === "string") reportPath = parsed.reportPath;
          } catch {
            // fall through to inline error output
          }
          return {
            ok: false,
            command,
            reportPath,
            artifacts: [],
            publish: { skipped: true, reason: "workflow failed before publish" },
            error: message || "unknown full-media-smoke failure",
          };
        }
      }}
    </Task>
  </Workflow>
));
