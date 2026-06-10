#!/usr/bin/env bun
// save.ts — validate a podcast artifact JSON against the contract and
// persist it to <out-dir>/podcast/<slug>/ together with its media:
// the audio file and the episode script (always saved as script.md).
//
// Usage:
//   bun skills/make-podcast/scripts/save.ts <artifact.json> \
//     --audio episode.wav --script script.md [--out-dir artifacts]

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  newArtifactId,
  validateArtifact,
  writeArtifact,
} from "../../_shared/lib/artifact.ts";

function usage(): never {
  console.error(
    "usage: bun skills/make-podcast/scripts/save.ts <artifact.json> --audio FILE --script FILE [--out-dir DIR]",
  );
  process.exit(2);
}

let file: string | undefined;
let audioFile: string | undefined;
let scriptFile: string | undefined;
let outDir: string | undefined;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--audio") {
    audioFile = args[++i];
    if (!audioFile) usage();
  } else if (arg === "--script") {
    scriptFile = args[++i];
    if (!scriptFile) usage();
  } else if (arg === "--out-dir") {
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
if (!file || !audioFile || !scriptFile) usage();

const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
// Convenience defaults the agent shouldn't have to invent:
raw.id ??= newArtifactId();
raw.type ??= "podcast";
raw.generated_at ??= new Date().toISOString();
// The audio field always names the media file we persist alongside.
const audioName = basename(audioFile);
raw.audio = audioName;

if (raw.type !== "podcast") {
  console.error(`make-podcast saves type "podcast" artifacts, got "${String(raw.type)}".`);
  process.exit(1);
}

const result = validateArtifact(raw);
if (!result.ok) {
  console.error("Artifact failed contract validation:");
  for (const err of result.errors) console.error(`  - ${err}`);
  process.exit(1);
}

const [audioBytes, scriptBytes] = await Promise.all([
  readFile(audioFile),
  readFile(scriptFile),
]);
if (audioBytes.length === 0) {
  console.error(`Audio file ${audioFile} is empty — refusing to save a silent episode.`);
  process.exit(1);
}

const written = await writeArtifact(result.artifact, {
  outDir,
  media: {
    [audioName]: new Uint8Array(audioBytes),
    "script.md": new Uint8Array(scriptBytes),
  },
});
console.log(`Saved: ${written.jsonPath}`);
console.log(`Media: ${audioName} (${audioBytes.length} bytes), script.md`);
