#!/usr/bin/env bun
// check-quote.ts — drafting-time quote checker, shared by all skills.
//
// Usage:
//   bun skills/_shared/scripts/check-quote.ts --quote "exact words" <transcript-path>...
//
// Checks the quote against each transcript (whitespace-insensitive,
// speech-segments semantics — the same shared verifyQuote the per-skill
// verify-quotes.ts scripts use, so AI-generated Summary / Action Items
// headers never count as spoken text). Paths may be .md/.txt files or
// directories (recursed).
//
// Prints a per-file verdict and, when found, the matching speaker turn.
// Exit 0: quote found in at least one transcript. Exit 1: found nowhere.
//
// Use this WHILE drafting — the moment you write a candidate quote — instead
// of waiting for the final verify-quotes pass to fail.

import {
  findQuoteTurn,
  loadTranscripts,
  verifyQuote,
} from "../lib/transcript.ts";

function usage(): never {
  console.error(
    'usage: bun skills/_shared/scripts/check-quote.ts --quote "exact words" <transcript-path>...',
  );
  process.exit(2);
}

let quote: string | undefined;
const paths: string[] = [];

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--quote") {
    quote = args[++i];
    if (quote === undefined) usage();
  } else if (arg.startsWith("--")) {
    usage();
  } else {
    paths.push(arg);
  }
}
if (!quote?.trim() || paths.length === 0) usage();

const transcripts = await loadTranscripts(paths);
if (transcripts.length === 0) {
  console.error(`No .md/.txt transcripts found under: ${paths.join(", ")}`);
  process.exit(1);
}

const MAX_TURN_PREVIEW = 600;

let found = false;
for (const t of transcripts) {
  if (!verifyQuote(t, quote)) {
    console.log(`not found  ${t.path}`);
    continue;
  }
  found = true;
  const match = findQuoteTurn(t, quote);
  if (match) {
    const label = match.turn.speaker ?? "(unattributed)";
    const stamp = match.turn.timestamp ? ` (${match.turn.timestamp})` : "";
    console.log(`FOUND      ${t.path}`);
    console.log(`  turn ${match.index} — ${label}${stamp}:`);
    const text =
      match.turn.text.length > MAX_TURN_PREVIEW
        ? match.turn.text.slice(0, MAX_TURN_PREVIEW) + " […]"
        : match.turn.text;
    for (const line of text.split("\n")) console.log(`  | ${line}`);
  } else {
    console.log(`FOUND      ${t.path} (spans multiple speaker turns)`);
  }
}

if (found) {
  console.log(
    "\nNote: a match proves the words exist in the spoken text — diarization speaker labels can still be wrong.",
  );
  process.exit(0);
}
console.error(`\nQuote not found in any of ${transcripts.length} transcript(s):`);
console.error(`  "${quote}"`);
process.exit(1);
