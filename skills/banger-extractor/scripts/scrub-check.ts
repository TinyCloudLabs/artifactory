#!/usr/bin/env bun
// scrub-check.ts — run the two deterministic checks over a candidate banger
// line: leak-safety flags (abstraction.ts) + AI-slop tells (slop-scrubber.ts).
//
// Usage:
//   bun skills/banger-extractor/scripts/scrub-check.ts --line "the one postable line" [<transcript-path>...] [--format text|json]
//
// Pass the source transcript path(s) so the safety check can mark which flagged
// specifics ALSO appear in the source (real private entities carried straight
// from the meeting — the highest-risk leaks). Without sources, every flag
// reports inSource:false and the check is weaker.
//
// REPORTS only — never rewrites or redacts. Exit 0 when the line is clean on
// BOTH mechanical checks; exit 1 otherwise. A clean exit is NECESSARY, not
// sufficient: the agent still owns the abstraction-ladder + 4-question judgment,
// and the artifact still saves as approval_status:pending for a human gate.

import { loadTranscripts } from "../../_shared/lib/transcript.ts";
import { checkBanger, renderBangerCheck } from "./banger.ts";

function usage(): never {
  console.error(
    'usage: bun skills/banger-extractor/scripts/scrub-check.ts --line "the line" [<transcript-path>...] [--format text|json]',
  );
  process.exit(2);
}

let line: string | undefined;
let format: "text" | "json" = "text";
const paths: string[] = [];

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--line") {
    line = args[++i];
    if (line === undefined) usage();
  } else if (arg === "--format") {
    const v = args[++i];
    if (v !== "text" && v !== "json") usage();
    format = v;
  } else if (arg.startsWith("--")) {
    usage();
  } else {
    paths.push(arg);
  }
}
if (!line?.trim()) usage();

let sourceText = "";
if (paths.length > 0) {
  const transcripts = await loadTranscripts(paths);
  if (transcripts.length === 0) {
    console.error(`No .md/.txt transcripts found under: ${paths.join(", ")}`);
    process.exit(1);
  }
  // The spoken turns are the source; AI-generated summary/action headers don't
  // count (same stance as verifyQuote — only what was actually said).
  sourceText = transcripts
    .flatMap((t) => t.turns.map((turn) => turn.text))
    .join("\n");
}

const check = checkBanger(line, sourceText);

if (format === "json") {
  process.stdout.write(JSON.stringify(check, null, 2) + "\n");
} else {
  console.log(renderBangerCheck(check));
}

process.exit(check.clean ? 0 : 1);
