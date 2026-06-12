import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTranscripts } from "../skills/_shared/lib/transcript.ts";
import { slugify, type Artifact } from "../skills/_shared/lib/artifact.ts";
import {
  MAX_POST_CHARS,
  buildBangerSurvey,
  checkBanger,
  renderBangerCheck,
  renderBangerSurveyMarkdown,
  saveBanger,
  verifyArtifactQuotes,
} from "../skills/banger-extractor/scripts/banger.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPTS = join(REPO_ROOT, "skills", "banger-extractor", "scripts");

// Synthetic fixture only — never real meeting content. A real earned-secret
// moment: a deal post-mortem naming a customer (Northwind) and a dollar figure
// ($240,000). The abstracted banger drops both; the source-carried name/number
// is what the safety check must flag as IN-SOURCE.
const DEAL_POSTMORTEM = `# Northwind Deal Post-Mortem
**Date:** 2026-04-02
**Participants:** ada@example.com, grace@example.com

## Transcript

**Grace Hopper:**
So why did we actually lose Northwind after six months of work?

**Ada Lovelace:**
The champion who loved us left, and we had never sold the economic buyer. We mistook one enthusiastic user for organizational buy-in, and the $240,000 deal evaporated the day he resigned.

**Grace Hopper:**
So the lesson is a single champion isn't a deal.

**Ada Lovelace:**
Right. If only one person can describe the ROI, you do not have a deal, you have a fan.
`;

let dir: string;
let transcriptPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "distillery-banger-"));
  transcriptPath = join(dir, "northwind-postmortem.md");
  await writeFile(transcriptPath, DEAL_POSTMORTEM);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// The abstracted banger: lesson lifted, customer + dollar figure stripped, one
// concrete detail kept ("a fan"). Clean on both mechanical checks.
const BANGER_LINE =
  "If only one person at the account can explain the business case, you do not have a deal. You have a fan who will leave the day they do.";

function bangerArtifact(overrides: Partial<Artifact> = {}): Record<string, unknown> {
  return {
    type: "social-post",
    headline: "champion-is-not-a-deal",
    body: BANGER_LINE,
    tags: ["sales", "earned-secret"],
    source_transcripts: [transcriptPath],
    source_quotes: [
      {
        quote:
          "If only one person can describe the ROI, you do not have a deal, you have a fan.",
        speaker: "Ada Lovelace",
        transcript: transcriptPath,
      },
    ],
    platform: "x",
    audience: "public",
    approval_status: "pending",
    generated_at: "2026-06-12T12:00:00.000Z",
    generation_model: "agent-judgment",
    quality: {
      critic_pass: true,
      quotes_verified: true,
      notes: "synthetic test artifact; [novelty] lead=single-voice",
    },
    ...overrides,
  };
}

function runScript(script: string, ...args: string[]) {
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

describe("buildBangerSurvey", () => {
  test("single mode: metadata, speaker stats, and chunk text present", async () => {
    const transcripts = await loadTranscripts([transcriptPath]);
    const survey = buildBangerSurvey(transcripts);
    expect(survey.mode).toBe("single");
    expect(survey.transcriptCount).toBe(1);
    expect(survey.transcripts[0]?.title).toBe("Northwind Deal Post-Mortem");
    expect(survey.transcripts[0]?.turnCount).toBe(4);
    const speakers = survey.transcripts[0]?.speakers ?? [];
    expect(speakers.find((s) => s.speaker === "Ada Lovelace")?.turns).toBe(2);
    expect(speakers.find((s) => s.speaker === "Grace Hopper")?.turns).toBe(2);
    // The banger lives in the chunk text — it must be carried verbatim.
    const joined = survey.chunks.map((c) => c.text).join("\n");
    expect(joined).toContain("you have a fan");
  });

  test("collection mode for 2+ transcripts", async () => {
    const second = join(dir, "second.md");
    await writeFile(second, DEAL_POSTMORTEM.replace("Northwind", "Acme"));
    const transcripts = await loadTranscripts([transcriptPath, second]);
    expect(buildBangerSurvey(transcripts).mode).toBe("collection");
  });

  test("is deterministic", async () => {
    const transcripts = await loadTranscripts([transcriptPath]);
    expect(JSON.stringify(buildBangerSurvey(transcripts))).toBe(
      JSON.stringify(buildBangerSurvey(transcripts)),
    );
  });
});

describe("renderBangerSurveyMarkdown", () => {
  test("renders metadata, speaker counts, and chunks", async () => {
    const transcripts = await loadTranscripts([transcriptPath]);
    const md = renderBangerSurveyMarkdown(buildBangerSurvey(transcripts));
    expect(md).toContain("# Banger survey");
    expect(md).toContain("- mode: single");
    expect(md).toContain("## Transcript: Northwind Deal Post-Mortem");
    expect(md).toContain("- Ada Lovelace: 2");
    expect(md).toContain("## Chunks");
    expect(md).toContain("you have a fan");
  });
});

describe("checkBanger — the two deterministic checks", () => {
  test("a clean abstracted line passes both checks", async () => {
    const source = DEAL_POSTMORTEM;
    const check = checkBanger(BANGER_LINE, source);
    expect(check.clean).toBe(true);
    expect(check.safety.fromSource).toEqual([]);
    expect(check.slop.tells).toEqual([]);
  });

  test("flags an IN-SOURCE customer name and dollar figure (a leak)", () => {
    const leaky = "Northwind walked away from a $240,000 deal when their champion quit.";
    const check = checkBanger(leaky, DEAL_POSTMORTEM);
    expect(check.clean).toBe(false);
    const fromSourceTerms = check.safety.fromSource.map((f) => f.term);
    expect(fromSourceTerms).toContain("Northwind");
    expect(check.safety.fromSource.some((f) => f.kind === "money")).toBe(true);
  });

  test("a not-in-source proper noun flags but does not by itself fail clean", () => {
    // "Tuesday" is a capitalized word the slop allowlist drops; an invented
    // generic name like "Globex" is flagged but is NOT in this source.
    const line = "A founder told us their whole pipeline was one Globex relationship.";
    const check = checkBanger(line, DEAL_POSTMORTEM);
    const globex = check.safety.flagged.find((f) => f.term === "Globex");
    expect(globex?.inSource).toBe(false);
    // No in-source flag and no slop tell → clean is true despite the invented name.
    expect(check.safety.fromSource).toEqual([]);
    expect(check.clean).toBe(true);
  });

  test("flags AI-slop tells in a hyped line", () => {
    const slop = "This isn't just a sales lesson, it's a game-changer that will 10x your pipeline.";
    const check = checkBanger(slop, DEAL_POSTMORTEM);
    expect(check.clean).toBe(false);
    const tellTypes = check.slop.tells.map((t) => t.type);
    expect(tellTypes).toContain("hype-vocab");
    expect(tellTypes).toContain("negative-parallelism");
  });

  test("without source text, no flag can be marked in-source", () => {
    const leaky = "Northwind walked away from a $240,000 deal.";
    const check = checkBanger(leaky, "");
    expect(check.safety.flagged.length).toBeGreaterThan(0);
    expect(check.safety.fromSource).toEqual([]);
    // Still clean=true here: clean only trips on in-source flags or slop, and
    // with no source nothing is in-source. (The CLI passes source to avoid this.)
    expect(check.clean).toBe(true);
  });

  test("renderBangerCheck shows the IN-SOURCE marker and the verdict", () => {
    const leaky = "Northwind lost us a $240,000 deal.";
    const rendered = renderBangerCheck(checkBanger(leaky, DEAL_POSTMORTEM));
    expect(rendered).toContain("clean: NO");
    expect(rendered).toContain("IN SOURCE");
  });
});

describe("scrub-check.ts CLI", () => {
  test("exit 0 on a clean line with source passed", () => {
    const res = runScript("scrub-check.ts", "--line", BANGER_LINE, transcriptPath);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("clean: yes");
  });

  test("exit 1 on an in-source leak, with the IN-SOURCE marker", () => {
    const res = runScript(
      "scrub-check.ts",
      "--line",
      "Northwind walked from a $240,000 deal.",
      transcriptPath,
    );
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("IN SOURCE");
  });

  test("exit 1 on a slop-laden line", () => {
    const res = runScript(
      "scrub-check.ts",
      "--line",
      "This is a total game-changer that will 10x your pipeline.",
      transcriptPath,
    );
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("hype-vocab");
  });

  test("--format json emits the structured check", () => {
    const res = runScript("scrub-check.ts", "--line", BANGER_LINE, transcriptPath, "--format", "json");
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.clean).toBe(true);
    expect(parsed.line).toBe(BANGER_LINE);
  });

  test("exits 2 without --line and on bad --format", () => {
    expect(runScript("scrub-check.ts").exitCode).toBe(2);
    expect(runScript("scrub-check.ts", "--line", BANGER_LINE, "--format", "xml").exitCode).toBe(2);
  });
});

describe("verifyArtifactQuotes", () => {
  test("passes the verbatim anchor, fails a paraphrase and a bad path", async () => {
    const ok = await verifyArtifactQuotes([
      { quote: "you have a fan", transcript: transcriptPath },
    ]);
    expect(ok).toEqual([]);

    const bad = await verifyArtifactQuotes([
      { quote: "a single fan is not the same as a signed deal", transcript: transcriptPath },
      { quote: "anything", transcript: join(dir, "missing.md") },
    ]);
    expect(bad).toHaveLength(2);
    expect(bad[0]?.reason).toContain("not found");
    expect(bad[1]?.reason).toContain("could not read");
  });
});

describe("verify-quotes.ts CLI", () => {
  test("exit 0 when the anchor verifies verbatim", async () => {
    const artifactPath = join(dir, "good.json");
    await writeFile(artifactPath, JSON.stringify(bangerArtifact(), null, 2));
    const res = runScript("verify-quotes.ts", artifactPath);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("All 1 quote(s) verified.");
  });

  test("exit 1 on an empty source_quotes — an unanchored banger doesn't ship", async () => {
    const artifactPath = join(dir, "unanchored.json");
    await writeFile(artifactPath, JSON.stringify(bangerArtifact({ source_quotes: [] })));
    const res = runScript("verify-quotes.ts", artifactPath);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("anchor");
  });

  test("--stamp on success sets quotes_verified=true, preserving the rest", async () => {
    const artifactPath = join(dir, "stamp.json");
    await writeFile(
      artifactPath,
      JSON.stringify(
        bangerArtifact({ quality: { critic_pass: true, quotes_verified: false, notes: "pre" } }),
        null,
        2,
      ),
    );
    const res = runScript("verify-quotes.ts", artifactPath, "--stamp");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Stamped");
    const after = JSON.parse(await readFile(artifactPath, "utf8"));
    expect(after.quality.quotes_verified).toBe(true);
    expect(after.quality.notes).toBe("pre");
    expect(after.body).toBe(BANGER_LINE);
  });

  test("--stamp with empty source_quotes exits 1 and never stamps", async () => {
    const artifactPath = join(dir, "stamp-empty.json");
    await writeFile(
      artifactPath,
      JSON.stringify(
        bangerArtifact({ source_quotes: [], quality: { critic_pass: true, quotes_verified: false } }),
      ),
    );
    const res = runScript("verify-quotes.ts", artifactPath, "--stamp");
    expect(res.exitCode).toBe(1);
    const after = JSON.parse(await readFile(artifactPath, "utf8"));
    expect(after.quality.quotes_verified).toBe(false);
  });
});

describe("saveBanger", () => {
  test("writes artifacts/social-post/<slug>/artifact.json, forcing pending + x/public", async () => {
    const outDir = join(dir, "out-save");
    const artifact = bangerArtifact();
    const saved = await saveBanger(artifact, { outDir });
    expect(saved.written.jsonPath).toBe(
      join(outDir, "social-post", slugify(artifact.headline as string), "artifact.json"),
    );
    const roundTrip = JSON.parse(await readFile(saved.written.jsonPath, "utf8"));
    expect(roundTrip.type).toBe("social-post");
    expect(roundTrip.approval_status).toBe("pending");
    expect(roundTrip.platform).toBe("x");
    expect(roundTrip.audience).toBe("public");
    expect(roundTrip.body).toBe(BANGER_LINE);
  });

  test("defaults platform/audience/pending when absent and fills id/generated_at", async () => {
    const outDir = join(dir, "out-defaults");
    const artifact = bangerArtifact();
    delete artifact.id;
    delete artifact.generated_at;
    delete artifact.platform;
    delete artifact.audience;
    delete artifact.approval_status;
    const saved = await saveBanger(artifact, { outDir });
    const roundTrip = JSON.parse(await readFile(saved.written.jsonPath, "utf8"));
    expect(typeof roundTrip.id).toBe("string");
    expect(Number.isNaN(Date.parse(roundTrip.generated_at))).toBe(false);
    expect(roundTrip.platform).toBe("x");
    expect(roundTrip.audience).toBe("public");
    expect(roundTrip.approval_status).toBe("pending");
  });

  test("REFUSES to save a pre-approved artifact — the cardinal rule", async () => {
    const outDir = join(dir, "out-approved");
    expect(saveBanger(bangerArtifact({ approval_status: "approved" }), { outDir })).rejects.toThrow(
      "refuses to save a pre-approved",
    );
  });

  test("rejects non-social-post types and missing bodies", async () => {
    const outDir = join(dir, "out-reject");
    expect(saveBanger(bangerArtifact({ type: "article" }), { outDir })).rejects.toThrow(
      'only saves type "social-post"',
    );
    const noBody = bangerArtifact();
    delete noBody.body;
    expect(saveBanger(noBody, { outDir })).rejects.toThrow("non-empty body");
  });

  test("warns (non-fatally) when the line exceeds the X char limit", async () => {
    const outDir = join(dir, "out-long");
    const long = "x".repeat(MAX_POST_CHARS + 50);
    const saved = await saveBanger(bangerArtifact({ body: long }), { outDir });
    expect(saved.warnings.some((w) => w.includes("X limit"))).toBe(true);
  });
});

describe("save.ts CLI", () => {
  test("end-to-end: banger JSON in, social-post artifact.json on disk (pending)", async () => {
    const outDir = join(dir, "out-cli");
    await mkdir(outDir, { recursive: true });
    const artifactPath = join(dir, "cli.json");
    const artifact = bangerArtifact();
    await writeFile(artifactPath, JSON.stringify(artifact, null, 2));

    const res = runScript("save.ts", artifactPath, "--out-dir", outDir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("approval_status=pending");

    const slug = slugify(artifact.headline as string);
    const json = JSON.parse(
      await readFile(join(outDir, "social-post", slug, "artifact.json"), "utf8"),
    );
    expect(json.approval_status).toBe("pending");
    expect(json.body).toBe(BANGER_LINE);
  });

  test("exits 1 when handed a pre-approved artifact", async () => {
    const artifactPath = join(dir, "cli-approved.json");
    await writeFile(artifactPath, JSON.stringify(bangerArtifact({ approval_status: "approved" })));
    const res = runScript("save.ts", artifactPath, "--out-dir", join(dir, "out-cli-approved"));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("refuses to save a pre-approved");
  });

  test("exits 1 on contract-invalid artifacts", async () => {
    const artifactPath = join(dir, "cli-invalid.json");
    await writeFile(artifactPath, JSON.stringify(bangerArtifact({ tags: undefined })));
    const res = runScript("save.ts", artifactPath, "--out-dir", join(dir, "out-cli-bad"));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("tags");
  });
});
