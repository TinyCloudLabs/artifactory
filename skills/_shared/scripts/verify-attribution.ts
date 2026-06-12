#!/usr/bin/env bun
// verify-attribution.ts — prove every IDENTITY/ROLE/AFFILIATION claim an
// artifact makes about a REAL PERSON is supported by its source transcript.
// The analog of verify-quotes: verify-quotes proves the QUOTES are real, this
// proves the framing AROUND them is real too. Shared by all generation skills
// (extract-insights, write-article, make-podcast).
//
// Usage:
//   bun skills/_shared/scripts/verify-attribution.ts <artifact.json> [--stamp]
//
// Scans the artifact's prose (headline/body/quote/attribution) for person+
// descriptor claims ("<Name> — <descriptor>", "<Org>'s <Name>", "<Name> of
// <Org>", …) and checks each descriptor's key terms (org/place names, role
// nouns) against the source transcript(s), case/whitespace-insensitively.
//
// Exit 0: no ungrounded person-claims. Exit 1: at least one ungrounded claim
// (listed with its missing terms) — STRIP or CORRECT it before publishing.
// Deterministic + NO LLM; it over-flags on paraphrase by design and FLAGS for
// the agent/critic to judge — it never auto-deletes.
//
// With --stamp, a fully-grounded result writes quality.attributions_grounded=
// true back into the artifact JSON (atomic tmp + rename) — the sanctioned way
// to set that flag. On any flagged claim, nothing is stamped. Never hand-set it.

import { readFile, rename, writeFile } from "node:fs/promises";
import { artifactProse, checkAttribution } from "../lib/attribution.ts";

function usage(): never {
  console.error(
    "usage: bun skills/_shared/scripts/verify-attribution.ts <artifact.json> [--stamp]",
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
  headline?: string;
  body?: string;
  quote?: string;
  attribution?: string;
  source_transcripts?: string[];
};

const sources = artifact.source_transcripts ?? [];
if (sources.length === 0) {
  console.error("No source_transcripts present — cannot ground person-claims. Fix the artifact.");
  process.exit(1);
}

// Concatenate every source transcript: a claim grounded in ANY of the
// artifact's sources is supported (an artifact may draw from a collection).
let sourceText = "";
for (const path of sources) {
  try {
    sourceText += "\n" + (await readFile(path, "utf8"));
  } catch (e) {
    console.error(`FAIL could not read source transcript ${path}: ${(e as Error).message}`);
    process.exit(1);
  }
}

const prose = artifactProse(artifact);
const claims = checkAttribution(prose, sourceText);

if (claims.length === 0) {
  console.log("No person+descriptor claims detected in the artifact's prose.");
} else {
  for (const c of claims) {
    if (c.grounded) {
      console.log(`ok   ${c.person} — "${c.descriptor.slice(0, 60)}" [${c.pattern}]`);
    }
  }
}

const flagged = claims.filter((c) => !c.grounded);
for (const c of flagged) {
  console.error(`FLAG ${c.person} — "${c.descriptor.slice(0, 80)}" [${c.pattern}]`);
  console.error(`     ungrounded terms (not in source): ${JSON.stringify(c.missingTerms)}`);
}

if (flagged.length > 0) {
  console.error(
    `\n${flagged.length} ungrounded person-claim(s). These describe a REAL person's ` +
      `identity/role/affiliation/location with terms absent from the source. STRIP or ` +
      `CORRECT each (refer to the person ONLY by transcript-grounded action), then re-run. ` +
      `Some flags are paraphrase false-positives — judge each; do not ship any you can't ground.`,
  );
  process.exit(1);
}

console.log(`\nAll ${claims.length} person-claim(s) grounded in source.`);

if (stampFlag) {
  const quality =
    typeof artifact.quality === "object" && artifact.quality !== null && !Array.isArray(artifact.quality)
      ? (artifact.quality as Record<string, unknown>)
      : {};
  (artifact as Record<string, unknown>).quality = { ...quality, attributions_grounded: true };
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(artifact, null, 2) + "\n");
  await rename(tmp, file);
  console.log(`Stamped quality.attributions_grounded=true in ${file}`);
}
