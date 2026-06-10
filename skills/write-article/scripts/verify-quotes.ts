#!/usr/bin/env bun
// verify-quotes.ts — prove every source_quote in an article artifact JSON
// exists verbatim (whitespace-insensitive) in its referenced transcript.
//
// Usage:
//   bun skills/write-article/scripts/verify-quotes.ts <artifact.json> [--stamp]
//
// Exit 0: all quotes verified. Exit 1: at least one failed (listed), or
// source_quotes is empty — articles without anchors don't ship.
// With --stamp, full verification success writes quality.quotes_verified=true
// back into the artifact JSON (atomic write) — the sanctioned way to set
// that flag. Never hand-set it. On failure (including zero quotes) nothing
// is stamped.
//
// Verification proves the quoted TEXT exists in the transcript — it cannot
// prove the speaker attribution; diarization labels can be wrong.

import { readFile, rename, writeFile } from "node:fs/promises";
import type { SourceQuote } from "../../_shared/lib/artifact.ts";
import { verifyArtifactQuotes } from "./article.ts";

function usage(): never {
  console.error(
    "usage: bun skills/write-article/scripts/verify-quotes.ts <artifact.json> [--stamp]",
  );
  process.exit(2);
}

let file: string | undefined;
let stampFlag = false;
for (const arg of process.argv.slice(2)) {
  if (arg === "--stamp") {
    stampFlag = true;
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
  source_quotes?: SourceQuote[];
};

/** Set quality.quotes_verified=true and persist atomically (tmp + rename). */
async function stamp(path: string): Promise<void> {
  const quality =
    typeof artifact.quality === "object" && artifact.quality !== null && !Array.isArray(artifact.quality)
      ? (artifact.quality as Record<string, unknown>)
      : {};
  artifact.quality = { ...quality, quotes_verified: true };
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(artifact, null, 2) + "\n");
  await rename(tmp, path);
  console.log(`Stamped quality.quotes_verified=true in ${path}`);
}

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
if (stampFlag) await stamp(file);
