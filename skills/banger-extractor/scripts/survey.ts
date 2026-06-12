#!/usr/bin/env bun
// survey.ts — parse transcripts and emit the banger survey.
//
// Usage:
//   bun skills/banger-extractor/scripts/survey.ts <transcript-path>... [--max-chunk 8000] [--format json|md] [--out file]
//
// Paths may be .md/.txt files or directories (recursed). Deterministic
// plumbing only: no model calls, no line selection. The survey gives the agent
// reading SKILL.md the spoken turns (where the banger lives) + a who-said-what
// hint. The judgment — which single line is the earned secret, or whether there
// is none — belongs to the agent.
//
// --format json (default) emits machine-readable JSON; --format md emits the
// same survey as a readable markdown document — usually the better read.

import { writeFile } from "node:fs/promises";
import { loadTranscripts } from "../../_shared/lib/transcript.ts";
import { buildBangerSurvey, renderBangerSurveyMarkdown } from "./banger.ts";

function usage(): never {
  console.error(
    "usage: bun skills/banger-extractor/scripts/survey.ts <transcript-path>... [--max-chunk N] [--format json|md] [--out file]",
  );
  process.exit(2);
}

const paths: string[] = [];
let maxChunk = 8000;
let outFile: string | undefined;
let format: "json" | "md" = "json";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--max-chunk") {
    const v = Number(args[++i]);
    if (!Number.isFinite(v) || v <= 0) usage();
    maxChunk = v;
  } else if (arg === "--out") {
    outFile = args[++i];
    if (!outFile) usage();
  } else if (arg === "--format") {
    const v = args[++i];
    if (v !== "json" && v !== "md") usage();
    format = v;
  } else if (arg.startsWith("--")) {
    usage();
  } else {
    paths.push(arg);
  }
}
if (paths.length === 0) usage();

const transcripts = await loadTranscripts(paths);
if (transcripts.length === 0) {
  console.error(`No .md/.txt transcripts found under: ${paths.join(", ")}`);
  process.exit(1);
}

const survey = buildBangerSurvey(transcripts, maxChunk);

const rendered =
  format === "md" ? renderBangerSurveyMarkdown(survey) : JSON.stringify(survey, null, 2) + "\n";
if (outFile) {
  await writeFile(outFile, rendered);
  console.error(
    `Wrote ${survey.mode}-mode ${format} banger survey (${survey.transcriptCount} transcript(s), ${survey.chunks.length} chunks) to ${outFile}`,
  );
} else {
  process.stdout.write(rendered);
}
