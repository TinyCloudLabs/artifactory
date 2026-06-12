#!/usr/bin/env bun
// lint.ts — run the two outward-facing safety linters over a snippet draft and
// print a combined report: LEAK flags (real private entities) + AI-slop tells.
//
// Usage:
//   bun skills/investor-snippet/scripts/lint.ts <artifact.json> [--source <transcript-path>...] [--format json|md]
//
// The leak detector checks the draft's headline + body for proper nouns,
// money, percentages, emails, and URLs, and marks which ones ALSO appear in
// the source transcripts (`inSource` — real private entities carried straight
// from the meeting, the highest-risk leaks). The slop linter reports AI-tell
// constructions with a density score. Both FLAG; neither rewrites — climbing
// the abstraction ladder and rewriting the prose is the agent's judgment.
//
// --source defaults to the artifact's own `source_transcripts`; pass explicit
// paths to override. Exit 0 always (this is a report, not a gate — the human
// approval gate is the gate); the agent reads the flags and decides.

import { readFile } from "node:fs/promises";
import { analyzeSnippet, renderSafetyReport } from "./snippet.ts";

function usage(): never {
  console.error(
    "usage: bun skills/investor-snippet/scripts/lint.ts <artifact.json> [--source <transcript-path>...] [--format json|md]",
  );
  process.exit(2);
}

let file: string | undefined;
const sourceOverride: string[] = [];
let format: "json" | "md" = "md";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--source") {
    // consume following non-flag args as source paths
    while (i + 1 < args.length && !args[i + 1]!.startsWith("--")) {
      sourceOverride.push(args[++i]!);
    }
    if (sourceOverride.length === 0) usage();
  } else if (arg === "--format") {
    const v = args[++i];
    if (v !== "json" && v !== "md") usage();
    format = v;
  } else if (arg.startsWith("--")) {
    usage();
  } else if (!file) {
    file = arg;
  } else {
    usage();
  }
}
if (!file) usage();

const artifact = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown> & {
  headline?: string;
  body?: string;
  source_transcripts?: string[];
};

// What an investor actually reads = the framing headline + the forwardable body.
const draftText = [artifact.headline ?? "", artifact.body ?? ""].filter(Boolean).join("\n");

const sourcePaths =
  sourceOverride.length > 0 ? sourceOverride : (artifact.source_transcripts ?? []);
const sourceTexts: string[] = [];
for (const p of sourcePaths) {
  try {
    sourceTexts.push(await readFile(p, "utf8"));
  } catch (e) {
    console.error(`warning: could not read source ${p}: ${(e as Error).message}`);
  }
}
const sourceText = sourceTexts.join("\n");

const report = analyzeSnippet(draftText, sourceText);

if (format === "json") {
  console.log(JSON.stringify(report, null, 2));
} else {
  process.stdout.write(renderSafetyReport(report) + "\n");
}

// Report-only: never exits non-zero. The human approval gate is the gate.
