import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "skills", "hot-take", "scripts", "save.ts");

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "distillery-hot-take-"));
  dirs.push(dir);
  return dir;
}

async function writeDraft(dir: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const draft = {
    headline: "The clock started too early",
    body: "The timeout bug was not the timeout length. It was that the timer started while work was still queued.",
    quote: "It was starting the timer when all the jobs went into the queue instead of when the process started.",
    attribution: "Hunter",
    tags: ["engineering"],
    source_transcripts: ["/tmp/transcript.md"],
    source_quotes: [
      {
        quote: "It was starting the timer when all the jobs went into the queue instead of when the process started.",
        speaker: "Hunter",
        transcript: "/tmp/transcript.md",
      },
    ],
    quality: {
      critic_pass: true,
      quotes_verified: true,
      notes: "[hot-take] compact, quote-anchored operating lesson",
    },
    ...overrides,
  };
  const path = join(dir, "draft.json");
  await writeFile(path, `${JSON.stringify(draft, null, 2)}\n`);
  return path;
}

function runSave(draft: string, outDir: string): { status: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", SCRIPT, draft, "--out-dir", outDir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("hot-take save", () => {
  test("saves a compact hot take as an insight-card", async () => {
    const dir = await tempDir();
    const out = join(dir, "artifacts");
    const draft = await writeDraft(dir);

    const res = runSave(draft, out);

    expect(res.status).toBe(0);
    const saved = join(out, "insight-card", "the-clock-started-too-early", "artifact.json");
    const artifact = JSON.parse(await readFile(saved, "utf8"));
    expect(artifact.type).toBe("insight-card");
    expect(artifact.headline).toBe("The clock started too early");
  });

  test("rejects oversized bodies", async () => {
    const dir = await tempDir();
    const draft = await writeDraft(dir, { body: "x".repeat(451) });

    const res = runSave(draft, join(dir, "artifacts"));

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("body: must be 450 characters or fewer");
  });

  test("rejects outward pending drafts", async () => {
    const dir = await tempDir();
    const draft = await writeDraft(dir, { audience: "public", approval_status: "pending" });

    const res = runSave(draft, join(dir, "artifacts"));

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("hot-take is internal");
    expect(res.stderr).toContain("not a held draft");
  });
});
