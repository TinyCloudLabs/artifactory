import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeSnippet,
  countWords,
  renderSafetyReport,
  saveSnippet,
  SNIPPET_WORDS_MAX,
  SNIPPET_WORDS_MIN,
} from "../skills/investor-snippet/scripts/snippet.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPTS = join(REPO_ROOT, "skills", "investor-snippet", "scripts");

// Synthetic fixture only — never real meeting content. Names a private
// customer + a dollar figure so leak detection has something real to catch.
const TRANSCRIPT = `# Synthetic GTM Sync
**Date:** 2026-06-02
**Participants:** ada@example.com, grace@example.com

## Summary
- Inbound from a logistics prospect after the conference talk.

## Transcript

**Ada Lovelace:**
Northwind Logistics reached out after my talk and wants a demo of the
enterprise tier this week.

**Grace Hopper:**
That's our first inbound enterprise demo. They mentioned a $400,000 budget
but that's their number, keep it internal.
`;

let dir: string;
let transcriptPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "distillery-investor-snippet-"));
  transcriptPath = join(dir, "gtm-sync.md");
  await writeFile(transcriptPath, TRANSCRIPT);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function snippetArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "test-id",
    type: "investor-update-snippet",
    headline: "First inbound enterprise demo, off one conference talk",
    body:
      "Early signal worth flagging: a mid-market logistics prospect reached out " +
      "after a conference talk and booked our first inbound enterprise demo this " +
      "week. One talk, one inbound enterprise pull. Early, but the motion is real.",
    tags: ["traction", "gtm"],
    source_transcripts: [transcriptPath],
    source_quotes: [
      {
        quote: "wants a demo of the\nenterprise tier this week",
        speaker: "Ada Lovelace",
        transcript: transcriptPath,
      },
    ],
    generated_at: "2026-06-10T12:00:00.000Z",
    generation_model: "test-agent",
    quality: { critic_pass: true, quotes_verified: false, notes: "synthetic test artifact" },
    ...overrides,
  };
}

async function writeDraft(name: string, artifact: Record<string, unknown>): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(artifact, null, 2) + "\n");
  return path;
}

function run(script: string, ...args: string[]) {
  const proc = Bun.spawnSync(["bun", join(SCRIPTS, script), ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("analyzeSnippet — combined leak + slop report", () => {
  test("flags a real customer name + dollar figure carried from the source", () => {
    const draft =
      "Northwind Logistics reached out and put a $400,000 budget on the table.";
    const report = analyzeSnippet(draft, TRANSCRIPT);

    const terms = report.leaks.flagged.map((f) => f.term.toLowerCase());
    expect(terms.some((t) => t.includes("northwind"))).toBe(true);
    expect(report.leaks.flagged.some((f) => f.kind === "money")).toBe(true);

    // Both are real entities from the source — the highest-risk subset.
    const fromSource = report.leaksFromSource.map((f) => f.term.toLowerCase());
    expect(fromSource.some((t) => t.includes("northwind"))).toBe(true);
    expect(report.leaksFromSource.some((f) => f.kind === "money")).toBe(true);
  });

  test("a properly-abstracted snippet leaks nothing from source", () => {
    const clean =
      "A mid-market logistics prospect booked our first inbound enterprise demo " +
      "after a conference talk. Early, but the motion is real.";
    const report = analyzeSnippet(clean, TRANSCRIPT);
    expect(report.leaksFromSource).toEqual([]);
  });

  test("catches AI-slop hype vocab and reports a non-zero score", () => {
    const hypey =
      "This is a game-changer. We're crushing it and the future of logistics is " +
      "ours to unlock — seamless, 10x, world-class.";
    const report = analyzeSnippet(hypey, TRANSCRIPT);
    expect(report.slop.tells.some((t) => t.type === "hype-vocab")).toBe(true);
    expect(report.slop.score).toBeGreaterThan(0);
  });

  test("renderSafetyReport surfaces the in-source warning", () => {
    const report = analyzeSnippet("Northwind Logistics is in.", TRANSCRIPT);
    const md = renderSafetyReport(report);
    expect(md).toContain("IN SOURCE");
    expect(md).toContain("WARNING");
  });
});

describe("saveSnippet — outward-facing contract", () => {
  test("forces audience=investors and approval_status=pending", async () => {
    // Draft lies: claims it's already approved and a public post. Save overrides.
    const written = await saveSnippet(
      snippetArtifact({ approval_status: "approved", audience: "public" }),
      { outDir: join(dir, "artifacts-1") },
    );
    const saved = JSON.parse(await readFile(written.written.jsonPath, "utf8"));
    expect(saved.audience).toBe("investors");
    expect(saved.approval_status).toBe("pending");
    expect(saved.type).toBe("investor-update-snippet");
  });

  test("rejects a wrong artifact type", async () => {
    await expect(
      saveSnippet(snippetArtifact({ type: "article" }), { outDir: join(dir, "artifacts-2") }),
    ).rejects.toThrow(/only saves type "investor-update-snippet"/);
  });

  test("rejects an empty body", async () => {
    await expect(
      saveSnippet(snippetArtifact({ body: "   " }), { outDir: join(dir, "artifacts-3") }),
    ).rejects.toThrow(/non-empty body/);
  });

  test("warns when the body is longer than a forwardable nugget", async () => {
    const longBody = Array.from({ length: SNIPPET_WORDS_MAX + 20 }, () => "word").join(" ");
    const saved = await saveSnippet(snippetArtifact({ body: longBody }), {
      outDir: join(dir, "artifacts-4"),
    });
    expect(saved.warnings.some((w) => w.includes("forwardable"))).toBe(true);
    expect(countWords(longBody)).toBeGreaterThan(SNIPPET_WORDS_MAX);
  });

  test("a nugget within the band saves without a length warning", async () => {
    const saved = await saveSnippet(snippetArtifact(), { outDir: join(dir, "artifacts-5") });
    expect(saved.wordCount).toBeGreaterThanOrEqual(SNIPPET_WORDS_MIN);
    expect(saved.wordCount).toBeLessThanOrEqual(SNIPPET_WORDS_MAX);
    expect(saved.warnings).toEqual([]);
  });
});

describe("survey.ts CLI", () => {
  test("emits a markdown digest for the transcript", () => {
    const res = run("survey.ts", transcriptPath, "--format", "md");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Article survey digest");
    expect(res.stdout).toContain("gtm-sync");
  });

  test("no paths exits 2 with usage", () => {
    const res = run("survey.ts");
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("usage:");
  });
});

describe("lint.ts CLI", () => {
  test("reports in-source leaks for a leaky draft using the artifact's own sources", async () => {
    const path = await writeDraft(
      "leaky.json",
      snippetArtifact({
        headline: "Northwind Logistics signs",
        body: "Northwind Logistics put $400,000 on the table after our talk.",
      }),
    );
    const res = run("lint.ts", path, "--format", "md");
    expect(res.exitCode).toBe(0); // report-only, never gates
    expect(res.stdout).toContain("IN SOURCE");
    expect(res.stdout.toLowerCase()).toContain("northwind");
  });

  test("a clean abstracted draft reports no in-source leaks and no slop", async () => {
    const path = await writeDraft("clean.json", snippetArtifact());
    const res = run("lint.ts", path, "--format", "md");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("No flagged term appears in the source transcript.");
    expect(res.stdout).toContain("(none) — reads clean.");
  });

  test("--format json emits machine-readable report", async () => {
    const path = await writeDraft("clean-json.json", snippetArtifact());
    const res = run("lint.ts", path, "--format", "json");
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toHaveProperty("leaks");
    expect(parsed).toHaveProperty("slop");
    expect(parsed).toHaveProperty("leaksFromSource");
  });
});

describe("verify-quotes.ts CLI", () => {
  test("exits 0 and stamps on a verbatim quote", async () => {
    const path = await writeDraft("verify-good.json", snippetArtifact());
    const res = run("verify-quotes.ts", path, "--stamp");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Stamped quality.quotes_verified=true");
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.quality.quotes_verified).toBe(true);
    expect(after.quality.critic_pass).toBe(true);
  });

  test("a paraphrased claim fails verification and does not stamp", async () => {
    const artifact = snippetArtifact();
    (artifact.source_quotes as { quote: string }[])[0]!.quote =
      "they would love a walkthrough of the top plan soon";
    const path = await writeDraft("verify-bad.json", artifact);
    const res = run("verify-quotes.ts", path, "--stamp");
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("FAIL");
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.quality.quotes_verified).toBe(false);
  });

  test("a quote lifted from the AI summary header fails (spoken-text only)", async () => {
    const artifact = snippetArtifact();
    // Present verbatim in the raw file's ## Summary, never spoken.
    (artifact.source_quotes as { quote: string }[])[0]!.quote =
      "Inbound from a logistics prospect after the conference talk.";
    const path = await writeDraft("verify-summary.json", artifact);
    const res = run("verify-quotes.ts", path, "--stamp");
    expect(res.exitCode).toBe(1);
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.quality.quotes_verified).toBe(false);
  });

  test("empty source_quotes exits 0 but refuses to stamp", async () => {
    const path = await writeDraft("verify-empty.json", snippetArtifact({ source_quotes: [] }));
    const res = run("verify-quotes.ts", path, "--stamp");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--stamp skipped");
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.quality.quotes_verified).toBe(false);
  });
});

describe("save.ts CLI", () => {
  test("saves to investor-update-snippet/<slug> with pending approval", async () => {
    const path = await writeDraft("save-good.json", snippetArtifact());
    const outDir = join(dir, "artifacts-cli");
    const res = run("save.ts", path, "--out-dir", outDir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("approval_status=pending");
    const slug = "first-inbound-enterprise-demo-off-one-conference-talk";
    const saved = JSON.parse(
      await readFile(join(outDir, "investor-update-snippet", slug, "artifact.json"), "utf8"),
    );
    expect(saved.audience).toBe("investors");
    expect(saved.approval_status).toBe("pending");
  });

  test("unknown flag exits 2 with usage", () => {
    const res = run("save.ts", "whatever.json", "--bogus");
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("usage:");
  });
});
