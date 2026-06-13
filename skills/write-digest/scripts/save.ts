#!/usr/bin/env bun
// save.ts — validate a digest artifact JSON against the contract and
// persist it to <out-dir>/digest/<slug>/artifact.json with body.md
// (the digest's markdown body) written alongside.
//
// Usage:
//   bun skills/write-digest/scripts/save.ts <artifact.json> [--out-dir artifacts]

import { readFile } from "node:fs/promises";
import { saveDigest } from "./digest.ts";

function usage(): never {
  console.error(
    "usage: bun skills/write-digest/scripts/save.ts <artifact.json> [--out-dir DIR]",
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
  const saved = await saveDigest(raw, { outDir });
  for (const warning of saved.warnings) console.error(`warning: ${warning}`);
  console.log(`Saved: ${saved.written.jsonPath} (${saved.wordCount} words, body.md alongside)`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
