#!/usr/bin/env bun
// verify-quotes.ts — prove every source_quote in a banger artifact JSON exists
// verbatim (whitespace-insensitive) in its referenced transcript's spoken text.
//
// Usage:
//   bun skills/banger-extractor/scripts/verify-quotes.ts <artifact.json> [--stamp]
//
// Exit 0: all quotes verified. Exit 1: at least one failed (listed), or
// source_quotes is empty — a banger asserts an EARNED SECRET someone actually
// SAID, so it ships with at least one anchoring quote; an empty list fails.
// With --stamp, full verification success writes quality.quotes_verified=true
// back into the artifact JSON (atomic write) — the sanctioned way to set that
// flag. Never hand-set it. On failure (including zero quotes) nothing stamps.
//
// Verification proves the quoted TEXT exists in the transcript — it cannot
// prove the speaker attribution; diarization labels can be wrong.

import { readFile, rename, writeFile } from "node:fs/promises";
import type { SourceQuote } from "../../_shared/lib/artifact.ts";
import { verifyArtifactQuotes } from "./banger.ts";

function usage(): never {
  console.error(
    "usage: bun skills/banger-extractor/scripts/verify-quotes.ts <artifact.json> [--stamp]",
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
    "No source_quotes present — a banger must anchor its earned secret to at " +
      "least one verbatim spoken quote. Add the anchor(s) and re-run.",
  );
  if (stampFlag) console.error("--stamp skipped: nothing verified, nothing stamped.");
  process.exit(1);
}

const failures = await verifyArtifactQuotes(quotes);
for (const [i, sq] of quotes.entries()) {
  const failed = failures.find((f) => f.index === i);
  if (failed) {
    console.error(`FAIL [${i}] ${failed.reason} (${sq.transcript}):`);
    console.error(`     "${sq.quote}"`);
  } else {
    console.log(`ok   [${i}] "${sq.quote.slice(0, 60)}..."`);
  }
}

if (failures.length > 0) {
  console.error(
    `\n${failures.length}/${quotes.length} quote(s) failed verification. Fix or drop them.`,
  );
  process.exit(1);
}
console.log(`\nAll ${quotes.length} quote(s) verified.`);
if (stampFlag) await stamp(file);
