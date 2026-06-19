#!/usr/bin/env bun
// save.ts — validate and persist a compact internal hot-take as insight-card.
//
// Usage:
//   bun skills/hot-take/scripts/save.ts <artifact.json> [--out-dir artifacts]

import { readFile } from "node:fs/promises";
import {
  newArtifactId,
  validateArtifact,
  writeArtifact,
} from "../../_shared/lib/artifact.ts";

const MAX_BODY_CHARS = 450;

function usage(): never {
  console.error("usage: bun skills/hot-take/scripts/save.ts <artifact.json> [--out-dir DIR]");
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
raw.id ??= newArtifactId();
raw.generated_at ??= new Date().toISOString();
raw.type ??= "insight-card";

const hotTakeErrors: string[] = [];
if (raw.type !== "insight-card") {
  hotTakeErrors.push('type: hot-take must save as "insight-card"');
}
if (typeof raw.body !== "string" || raw.body.trim().length === 0) {
  hotTakeErrors.push("body: required compact paragraph");
} else if (raw.body.length > MAX_BODY_CHARS) {
  hotTakeErrors.push(`body: must be ${MAX_BODY_CHARS} characters or fewer`);
}
if (!Array.isArray(raw.source_quotes) || raw.source_quotes.length === 0) {
  hotTakeErrors.push("source_quotes: at least one verified quote is required");
}
if (raw.audience === "public" || raw.audience === "investors") {
  hotTakeErrors.push("audience: hot-take is internal; use an outward skill for public/investor copy");
}
if (raw.approval_status === "pending") {
  hotTakeErrors.push("approval_status: hot-take is a publishable internal artifact, not a held draft");
}
if (raw.hero_image !== undefined) {
  hotTakeErrors.push("hero_image: hot-take must stay text-only");
}

const result = validateArtifact(raw);
if (!result.ok || hotTakeErrors.length > 0) {
  console.error("Hot-take failed validation:");
  for (const err of [...hotTakeErrors, ...(result.ok ? [] : result.errors)]) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

const written = await writeArtifact(result.artifact, { outDir });
console.log(`Saved: ${written.jsonPath}`);
