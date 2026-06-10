#!/usr/bin/env bun
// verify-quotes.ts — prove every source_quote in an article artifact JSON
// exists verbatim (whitespace-insensitive) in its referenced transcript.
//
// Usage:
//   bun skills/write-article/scripts/verify-quotes.ts <artifact.json>
//
// Exit 0: all quotes verified. Exit 1: at least one failed (listed).
// The agent must run this (and see exit 0) before setting
// quality.quotes_verified.

import { readFile } from "node:fs/promises";
import type { SourceQuote } from "../../_shared/lib/artifact.ts";
import { verifyArtifactQuotes } from "./article.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: bun skills/write-article/scripts/verify-quotes.ts <artifact.json>");
  process.exit(2);
}

const artifact = JSON.parse(await readFile(file, "utf8")) as {
  source_quotes?: SourceQuote[];
};
const quotes = artifact.source_quotes ?? [];
if (quotes.length === 0) {
  console.error(
    "No source_quotes present. Articles must anchor every factual claim and pull quote to a transcript quote — an empty list fails verification.",
  );
  process.exit(1);
}

const failures = await verifyArtifactQuotes(quotes);
const failedIndexes = new Set(failures.map((f) => f.index));

for (const [i, sq] of quotes.entries()) {
  if (!failedIndexes.has(i)) {
    console.log(`ok   [${i}] "${sq.quote.slice(0, 60)}..."`);
  }
}
for (const f of failures) {
  console.error(`FAIL [${f.index}] ${f.reason} (${f.transcript}):`);
  console.error(`     "${f.quote}"`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length}/${quotes.length} quote(s) failed verification. Fix or drop them.`);
  process.exit(1);
}
console.log(`\nAll ${quotes.length} quote(s) verified.`);
