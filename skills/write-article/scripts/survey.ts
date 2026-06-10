#!/usr/bin/env bun
// survey.ts — parse transcripts and emit the article-survey digest.
//
// Usage:
//   bun skills/write-article/scripts/survey.ts <transcript-path>... [--max-chunk 8000] [--format json|md] [--out digest.json]
//
// Paths may be .md/.txt files or directories (recursed). Deterministic
// plumbing only: no model calls, no angle selection. The digest gives the
// agent reading SKILL.md what it needs to pick an editorial angle:
// per-transcript metadata + per-speaker turn counts, cross-transcript shared
// speakers and recurring terms (collection mode), and the full chunked text.
//
// --format json (default) emits machine-readable JSON; --format md emits the
// same digest as a readable markdown document (metadata + chunks as plain
// text sections) — far easier to read in one pass than a large JSON blob.

import { writeFile } from "node:fs/promises";
import { loadTranscripts } from "../../_shared/lib/transcript.ts";
import { buildDigest, renderDigestMarkdown } from "./article.ts";

function usage(): never {
  console.error(
    "usage: bun skills/write-article/scripts/survey.ts <transcript-path>... [--max-chunk N] [--format json|md] [--out file]",
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

const digest = buildDigest(transcripts, maxChunk);

const rendered =
  format === "md" ? renderDigestMarkdown(digest) : JSON.stringify(digest, null, 2) + "\n";
if (outFile) {
  await writeFile(outFile, rendered);
  console.error(
    `Wrote ${digest.mode}-mode ${format} digest (${digest.transcriptCount} transcript(s), ${digest.chunks.length} chunks) to ${outFile}`,
  );
} else {
  process.stdout.write(rendered);
}
