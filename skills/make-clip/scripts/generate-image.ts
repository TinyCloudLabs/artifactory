#!/usr/bin/env bun
// generate-image.ts — generate ONE make-clip reference image (the stage-1
// identity image OR the stage-2 storyboard sheet) via GPT Image 2 on fal.ai,
// write the bytes to --out, and print the request_id + size. No LLM here:
// the agent writes the prompt (from a template), this just spends.
//
// Usage:
//   bun skills/make-clip/scripts/generate-image.ts <prompt.md> --out identity.png \
//     [--size 1024x1024 | --size square_hd] [--quality high] [--smoke]
//
// --size accepts WxH (multiples of 16, max edge 3840) or a fal preset string.
//        Defaults to 1024x1024 (square). For a 16:9 storyboard sheet use e.g.
//        3840x2160 (the prototype's verified size; both edges are /16).
// --smoke generates a tiny 256x256 image first as a key/endpoint check — same
//        posture as make-podcast's TTS smoke test (spend a few cents, confirm
//        the pipe works before the high-quality roll).

import { writeFile } from "node:fs/promises";
import {
  FalError,
  generateImage,
  type ImageQuality,
  type ImageSize,
} from "../../_shared/lib/fal.ts";

function usage(): never {
  console.error(
    "usage: bun skills/make-clip/scripts/generate-image.ts <prompt.md> --out FILE\n" +
      "         [--size WxH | --size PRESET] [--quality auto|low|medium|high] [--smoke]",
  );
  process.exit(2);
}

let promptFile: string | undefined;
let outFile: string | undefined;
let sizeArg: string | undefined;
let quality: ImageQuality | undefined;
let smoke = false;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--out") {
    outFile = args[++i];
    if (!outFile) usage();
  } else if (arg === "--size") {
    sizeArg = args[++i];
    if (!sizeArg) usage();
  } else if (arg === "--quality") {
    const q = args[++i];
    if (q !== "auto" && q !== "low" && q !== "medium" && q !== "high") usage();
    quality = q;
  } else if (arg === "--smoke") {
    smoke = true;
  } else if (arg.startsWith("--")) {
    usage();
  } else if (!promptFile) {
    promptFile = arg;
  } else {
    usage();
  }
}
if (!promptFile || !outFile) usage();

function parseSize(s: string | undefined): ImageSize | undefined {
  if (!s) return undefined;
  const m = /^(\d+)x(\d+)$/i.exec(s.trim());
  if (m) return { width: Number(m[1]), height: Number(m[2]) };
  return s; // a fal preset string
}

const prompt = await Bun.file(promptFile).text();
if (!prompt.trim()) {
  console.error(`Prompt file ${promptFile} is empty.`);
  process.exit(1);
}

const imageSize = smoke ? { width: 256, height: 256 } : parseSize(sizeArg);
const effectiveQuality = smoke ? "low" : quality;

console.error(
  `Generating ${smoke ? "SMOKE " : ""}image from ${promptFile} ` +
    `(${typeof imageSize === "object" ? `${imageSize.width}x${imageSize.height}` : imageSize ?? "1024x1024"}, ` +
    `quality=${effectiveQuality ?? "high"})...`,
);

try {
  const result = await generateImage(
    { prompt, imageSize, quality: effectiveQuality },
    { onStatus: (s) => process.stderr.write(`\r  fal status: ${s}   `) },
  );
  process.stderr.write("\n");
  await writeFile(outFile, result.bytes);
  console.log(`Wrote ${outFile}: ${result.bytes.length} bytes (${result.contentType})`);
  console.log(`request_id: ${result.request_id}`);
  if (smoke) {
    console.log("Smoke OK — key + endpoint work. Re-run without --smoke for the real roll.");
  }
} catch (e) {
  if (e instanceof FalError && e.isAuth) {
    console.error(`FAL auth failed (${e.status}). Set FAL_KEY (TinyCloud Secret Manager).`);
    process.exit(3);
  }
  console.error(`Image generation failed: ${(e as Error).message}`);
  process.exit(1);
}
