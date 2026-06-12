#!/usr/bin/env bun
// save.ts — validate a banger artifact JSON against the contract and persist it
// to <out-dir>/social-post/<slug>/artifact.json.
//
// Usage:
//   bun skills/banger-extractor/scripts/save.ts <artifact.json> [--out-dir artifacts]
//
// Forces type "social-post", platform "x" / audience "public" defaults, and
// approval_status "pending" — a banger NEVER ships pre-approved. An incoming
// approval_status other than "pending" is rejected outright; the human-approval
// gate lives downstream of this script, never inside it.

import { readFile } from "node:fs/promises";
import { saveBanger } from "./banger.ts";

function usage(): never {
  console.error(
    "usage: bun skills/banger-extractor/scripts/save.ts <artifact.json> [--out-dir DIR]",
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
  const saved = await saveBanger(raw, { outDir });
  for (const warning of saved.warnings) console.error(`warning: ${warning}`);
  console.log(
    `Saved: ${saved.written.jsonPath} (${saved.charCount} chars, approval_status=pending)`,
  );
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
