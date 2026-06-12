#!/usr/bin/env bun
// save.ts — validate an investor-snippet artifact JSON against the contract
// and persist it to <out-dir>/investor-update-snippet/<slug>/artifact.json.
//
// Usage:
//   bun skills/investor-snippet/scripts/save.ts <artifact.json> [--out-dir artifacts]
//
// The save FORCES the outward-facing invariants — audience "investors" and
// approval_status "pending" — regardless of what the draft says. Nothing
// outward-facing auto-publishes: approval is a human action taken on the
// saved artifact later, never granted by the generation step.

import { readFile } from "node:fs/promises";
import { saveSnippet } from "./snippet.ts";

function usage(): never {
  console.error(
    "usage: bun skills/investor-snippet/scripts/save.ts <artifact.json> [--out-dir DIR]",
  );
  process.exit(2);
}

let file: string | undefined;
let outDir: string | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--out-dir") {
    outDir = args[++i];
    if (!outDir) usage();
  } else if (arg.startsWith("--")) {
    usage();
  } else if (!file) {
    file = arg;
  } else {
    usage();
  }
}
if (!file) usage();

const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

try {
  const saved = await saveSnippet(raw, { outDir });
  for (const warning of saved.warnings) console.error(`warning: ${warning}`);
  console.log(
    `Saved: ${saved.written.jsonPath} (${saved.wordCount} words, audience=investors, approval_status=pending)`,
  );
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
