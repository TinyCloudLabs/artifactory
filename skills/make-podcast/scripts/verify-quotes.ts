#!/usr/bin/env bun
// verify-quotes.ts — prove every source_quote in a podcast artifact JSON
// exists verbatim (whitespace-insensitive) in its referenced transcript.
// The podcast script paraphrases for the ear, but each factual claim must
// still be anchored by a verbatim source_quote — this script is the
// deterministic half of that check.
//
// Usage:
//   bun skills/make-podcast/scripts/verify-quotes.ts <artifact.json> [--stamp]
//
// Exit 0: all quotes verified. Exit 1: at least one failed (listed).
// With --stamp, full verification success writes quality.quotes_verified=true
// back into the artifact JSON (atomic write) — the sanctioned way to set
// that flag. Never hand-set it. On failure nothing is stamped; zero quotes
// still exit 0 (suspicious but allowed for podcasts) without stamping.

import { readFile, rename, writeFile } from "node:fs/promises";
import { parseTranscript, verifyQuote, type Transcript } from "../../_shared/lib/transcript.ts";
import type { SourceQuote } from "../../_shared/lib/artifact.ts";

function usage(): never {
  console.error(
    "usage: bun skills/make-podcast/scripts/verify-quotes.ts <artifact.json> [--stamp]",
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
  console.log("No source_quotes present — nothing to verify.");
  console.log(
    "Note: podcast artifacts SHOULD anchor every factual claim with source_quotes; an empty list is suspicious.",
  );
  if (stampFlag) {
    console.log("--stamp skipped: nothing was verified, so nothing was stamped.");
  }
  process.exit(0);
}

const cache = new Map<string, Transcript>();
async function load(path: string): Promise<Transcript> {
  const hit = cache.get(path);
  if (hit) return hit;
  const t = parseTranscript(await readFile(path, "utf8"), path);
  cache.set(path, t);
  return t;
}

let failures = 0;
for (const [i, sq] of quotes.entries()) {
  try {
    const transcript = await load(sq.transcript);
    if (verifyQuote(transcript, sq.quote)) {
      console.log(`ok   [${i}] "${sq.quote.slice(0, 60)}..."`);
    } else {
      failures++;
      console.error(`FAIL [${i}] quote not found in ${sq.transcript}:`);
      console.error(`     "${sq.quote}"`);
    }
  } catch (e) {
    failures++;
    console.error(`FAIL [${i}] could not read ${sq.transcript}: ${(e as Error).message}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${quotes.length} quote(s) failed verification. Fix or drop them.`);
  process.exit(1);
}
console.log(`\nAll ${quotes.length} quote(s) verified.`);
if (stampFlag) await stamp(file);
