#!/usr/bin/env bun
// save.ts — validate a person-brief artifact JSON against the contract and
// persist it to <out-dir>/person-brief/<slug>/artifact.json with brief.md
// (the dossier markdown body) written alongside.
//
// Usage:
//   bun skills/person-brief/scripts/save.ts <artifact.json> [--out-dir artifacts]

import { readFile } from "node:fs/promises";
import { saveBrief } from "./person-brief.ts";

function usage(): never {
  console.error(
    "usage: bun skills/person-brief/scripts/save.ts <artifact.json> [--out-dir DIR]",
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
  const saved = await saveBrief(raw, { outDir });
  for (const warning of saved.warnings) console.error(`warning: ${warning}`);
  console.log(`Saved: ${saved.written.jsonPath} (brief.md alongside)`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
