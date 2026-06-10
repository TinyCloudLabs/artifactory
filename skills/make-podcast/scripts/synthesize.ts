#!/usr/bin/env bun
// synthesize.ts — turn an approved episode script into a playable audio
// file via Gemini TTS, then report the bytes/duration math so the agent can
// sanity-check the output before saving.
//
// Usage (monologue):
//   bun skills/make-podcast/scripts/synthesize.ts script.md --voice Kore --out episode.wav
// Usage (dialogue, names must match the "Name:" labels in the script):
//   bun skills/make-podcast/scripts/synthesize.ts script.md \
//     --speaker "Alex=Kore" --speaker "Sam=Puck" --out episode.wav
//
// Options: --model <id> (default gemini-2.5-flash-preview-tts).
//
// The whole script file is sent as the TTS text. Per the docs the API
// returns raw PCM (s16le 24kHz mono); this script wraps it into a WAV so
// the artifact folder holds a directly playable file. Request shape is
// grounded in https://ai.google.dev/gemini-api/docs/speech-generation —
// see SKILL.md for the "until live-verified" warning.

import { readFile, writeFile } from "node:fs/promises";
import {
  isRawPcmMime,
  pcmDurationSeconds,
  pcmFormatFromMime,
  pcmToWav,
  synthesizeSpeech,
  type SpeakerVoice,
} from "../../_shared/lib/tts.ts";

function usage(): never {
  console.error(
    "usage: bun skills/make-podcast/scripts/synthesize.ts <script.md>\n" +
      "         (--voice NAME | --speaker NAME=VOICE [--speaker NAME=VOICE])\n" +
      "         --out episode.wav [--model MODEL_ID]",
  );
  process.exit(2);
}

let scriptFile: string | undefined;
let voice: string | undefined;
const speakers: SpeakerVoice[] = [];
let outFile: string | undefined;
let model: string | undefined;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--voice") {
    voice = args[++i];
    if (!voice) usage();
  } else if (arg === "--speaker") {
    const pair = args[++i];
    const eq = pair?.indexOf("=") ?? -1;
    if (!pair || eq <= 0 || eq === pair.length - 1) usage();
    speakers.push({ speaker: pair.slice(0, eq), voiceName: pair.slice(eq + 1) });
  } else if (arg === "--out") {
    outFile = args[++i];
    if (!outFile) usage();
  } else if (arg === "--model") {
    model = args[++i];
    if (!model) usage();
  } else if (arg.startsWith("--")) {
    usage();
  } else if (!scriptFile) {
    scriptFile = arg;
  } else {
    usage();
  }
}
if (!scriptFile || !outFile) usage();
if ((voice ? 1 : 0) + (speakers.length > 0 ? 1 : 0) !== 1) {
  console.error("Pick exactly one mode: --voice (monologue) or --speaker pairs (dialogue).");
  usage();
}

const script = await readFile(scriptFile, "utf8");
const words = script.split(/\s+/).filter(Boolean).length;
console.error(`Synthesizing ${words} words from ${scriptFile}...`);

const result = await synthesizeSpeech({
  script,
  voices: voice ?? speakers,
  model,
});

let bytes = result.bytes;
let durationSeconds: number | undefined;
if (isRawPcmMime(result.mimeType) || result.mimeType === "") {
  // Raw PCM (the documented output) — wrap in a WAV header so it plays.
  const fmt = pcmFormatFromMime(result.mimeType);
  durationSeconds = pcmDurationSeconds(result.bytes.length, fmt);
  bytes = pcmToWav(result.bytes, fmt);
  console.error(
    `Raw PCM (${result.mimeType || "mime missing; assuming s16le 24kHz mono"}) → WAV.`,
  );
} else {
  console.error(`Note: non-PCM mime "${result.mimeType}" — writing bytes as-is.`);
}

await writeFile(outFile, bytes);

// Sanity-check math for the agent (quality loop step 6).
console.log(`Wrote ${outFile}: ${bytes.length} bytes`);
if (durationSeconds !== undefined) {
  const mins = Math.floor(durationSeconds / 60);
  const secs = Math.round(durationSeconds % 60);
  const wpm = words / (durationSeconds / 60);
  console.log(
    `Duration (bytes/byte-rate): ${durationSeconds.toFixed(1)}s (~${mins}m${String(secs).padStart(2, "0")}s)`,
  );
  console.log(`Pace: ${wpm.toFixed(0)} words/min for ${words} script words`);
  if (durationSeconds < 60 || durationSeconds > 360) {
    console.error(
      `WARNING: duration outside the 2-5 min micro-podcast target (allowing 1-6 min). Re-check the script length.`,
    );
  }
  if (wpm < 100 || wpm > 240) {
    console.error(
      `WARNING: implausible pace (${wpm.toFixed(0)} wpm). The audio may be truncated or padded — listen before saving.`,
    );
  }
} else {
  console.log("Duration unknown (non-PCM output) — verify by playing the file.");
}
