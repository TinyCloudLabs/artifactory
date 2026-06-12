#!/usr/bin/env bun
// gather.ts — scan a transcript corpus for a named person and emit the raw
// dossier survey (the turns they spoke, the turns that name them, participant-
// header appearances, co-speakers). Deterministic plumbing: NO model calls, NO
// conclusions. The agent reads this and does the grounding judgment.
//
// Usage:
//   bun skills/person-brief/scripts/gather.ts --name "Samuel Gbafa" <transcript-path>... [--format md|json] [--out dossier.md]
//
// Accepts .md/.txt files or directories (recursed) — paths are always passed
// in, nothing is hardcoded to any machine.

import { writeFile } from "node:fs/promises";
import { loadTranscripts } from "../../_shared/lib/transcript.ts";
import { gatherPersonMentions, renderDossierMarkdown } from "./person-brief.ts";

function usage(): never {
  console.error(
    'usage: bun skills/person-brief/scripts/gather.ts --name "Full Name" <transcript-path>... [--format md|json] [--out FILE]',
  );
  process.exit(2);
}

let name: string | undefined;
let format: "md" | "json" = "md";
let outPath: string | undefined;
const paths: string[] = [];

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--name") {
    name = args[++i];
    if (!name) usage();
  } else if (arg === "--format") {
    const f = args[++i];
    if (f !== "md" && f !== "json") usage();
    format = f;
  } else if (arg === "--out") {
    outPath = args[++i];
    if (!outPath) usage();
  } else if (arg.startsWith("--")) {
    usage();
  } else {
    paths.push(arg);
  }
}
if (!name || paths.length === 0) usage();

const transcripts = await loadTranscripts(paths);
const dossier = gatherPersonMentions(transcripts, name);

const rendered =
  format === "json" ? JSON.stringify(dossier, null, 2) : renderDossierMarkdown(dossier);

if (outPath) {
  await writeFile(outPath, rendered.endsWith("\n") ? rendered : rendered + "\n");
  console.error(`Wrote dossier to ${outPath}`);
} else {
  console.log(rendered);
}

// Counts to stderr (so stdout stays pipeable) — raw numbers, not conclusions.
console.error(
  `Evidence: ${dossier.totals.transcriptsWithEvidence} transcript(s)` +
    ` · spoke in ${dossier.totals.transcriptsSpoken}` +
    ` · ${dossier.totals.spokenTurns} spoken turn(s)` +
    ` · ${dossier.totals.mentionTurns} mention turn(s).`,
);
if (dossier.totals.transcriptsWithEvidence === 0) {
  console.error(
    "No evidence found — a grounded brief is not possible. Do not fabricate; output nothing.",
  );
}
