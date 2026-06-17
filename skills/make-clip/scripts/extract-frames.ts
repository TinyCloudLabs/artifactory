#!/usr/bin/env bun
// extract-frames.ts — deterministically pull N evenly-spaced frames + the
// audio track out of a clip, for the BLIND-RECONSTRUCTION CRITIC GATE. The
// gate is ~free: no generation, just ffmpeg sampling. A context-free reviewer
// then watches these frames + listens to the audio and narrates back what
// they perceive (see SKILL.md). No LLM here — this is pure plumbing.
//
// Usage:
//   bun skills/make-clip/scripts/extract-frames.ts clip.mp4 --out-dir frames/ \
//     [--count 8] [--fps N] [--audio frames/audio.aac]
//
// --count: evenly-spaced frames across the clip duration (default 8). Mutually
//          exclusive with --fps (which samples at a fixed rate instead).
// --audio: also copy the audio stream (codec-copy, untouched) to this path.

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface FrameExtractPlan {
  /** ffmpeg argv for the frame extraction (no leading "ffmpeg"). */
  frameArgs: string[];
  /** ffmpeg argv for the audio copy, or undefined when --audio not given. */
  audioArgs?: string[];
}

/**
 * Build the ffmpeg argv for frame + audio extraction. Pure so tests pin the
 * command shape without invoking ffmpeg.
 *
 * count mode: `-vf fps=count/duration` needs the duration; instead we use the
 * thumbnail-free `select` over evenly spaced timestamps via `-vf
 * "fps=COUNT/DURATION"` is brittle, so we sample with `-vf
 * "select='not(mod(n\,STEP))'"` only when we know the frame count. Simplest
 * robust approach that needs no probe: sample at a derived fps from the
 * known duration. We therefore require `durationSeconds` for count mode.
 */
export function buildFrameArgs(opts: {
  input: string;
  outDir: string;
  count?: number;
  fps?: number;
  durationSeconds?: number;
}): string[] {
  const pattern = join(opts.outDir, "f%03d.png");
  let vf: string;
  if (opts.fps !== undefined) {
    if (opts.fps <= 0) throw new Error("extract-frames: --fps must be > 0");
    vf = `fps=${opts.fps}`;
  } else {
    const count = opts.count ?? 8;
    if (count <= 0) throw new Error("extract-frames: --count must be > 0");
    if (!opts.durationSeconds || opts.durationSeconds <= 0) {
      throw new Error("extract-frames: count mode needs a positive durationSeconds");
    }
    // Evenly spaced: count frames across the duration → fps = count/duration.
    const rate = count / opts.durationSeconds;
    vf = `fps=${rate.toFixed(6)}`;
  }
  // prettier-ignore
  return [
    "-y", "-i", opts.input,
    "-vf", vf,
    "-vsync", "vfr",
    pattern,
  ];
}

/** Build the ffmpeg argv to copy the audio stream untouched. */
export function buildAudioArgs(input: string, audioOut: string): string[] {
  // prettier-ignore
  return [
    "-y", "-i", input,
    "-vn", "-acodec", "copy",
    audioOut,
  ];
}

/** Probe a clip's duration in seconds via ffprobe; undefined if unavailable. */
export function probeDurationSeconds(input: string): number | undefined {
  if (!Bun.which("ffprobe")) return undefined;
  const proc = Bun.spawnSync([
    "ffprobe", "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    input,
  ]);
  if (proc.exitCode !== 0) return undefined;
  const v = Number(proc.stdout.toString().trim());
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

function usage(): never {
  console.error(
    "usage: bun skills/make-clip/scripts/extract-frames.ts <clip.mp4> --out-dir DIR\n" +
      "         [--count N | --fps N] [--audio FILE] [--duration SECONDS]",
  );
  process.exit(2);
}

// Run only as a CLI (skip when imported by tests).
if (import.meta.main) {
  let input: string | undefined;
  let outDir: string | undefined;
  let count: number | undefined;
  let fps: number | undefined;
  let audioOut: string | undefined;
  let durationSeconds: number | undefined;

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--out-dir") { outDir = args[++i]; if (!outDir) usage(); }
    else if (arg === "--count") { count = Number(args[++i]); if (Number.isNaN(count)) usage(); }
    else if (arg === "--fps") { fps = Number(args[++i]); if (Number.isNaN(fps)) usage(); }
    else if (arg === "--audio") { audioOut = args[++i]; if (!audioOut) usage(); }
    else if (arg === "--duration") { durationSeconds = Number(args[++i]); if (Number.isNaN(durationSeconds)) usage(); }
    else if (arg.startsWith("--")) usage();
    else if (!input) input = arg;
    else usage();
  }
  if (!input || !outDir) usage();

  if (!Bun.which("ffmpeg")) {
    console.error("extract-frames: ffmpeg not found on PATH — install ffmpeg for the blind-test gate.");
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });

  if (count !== undefined && fps === undefined && durationSeconds === undefined) {
    durationSeconds = probeDurationSeconds(input);
    if (!durationSeconds) {
      console.error(
        "extract-frames: could not probe duration (install ffprobe) — pass --duration SECONDS or use --fps.",
      );
      process.exit(1);
    }
  }

  const frameArgs = buildFrameArgs({ input, outDir, count, fps, durationSeconds });
  const fp = Bun.spawnSync(["ffmpeg", ...frameArgs], { stdout: "ignore", stderr: "pipe" });
  if (fp.exitCode !== 0) {
    console.error(`ffmpeg frame extraction failed:\n${fp.stderr.toString().trim().split("\n").slice(-5).join("\n")}`);
    process.exit(1);
  }
  console.log(`Frames → ${outDir}`);

  if (audioOut) {
    await mkdir(dirname(audioOut), { recursive: true });
    const ap = Bun.spawnSync(["ffmpeg", ...buildAudioArgs(input, audioOut)], { stdout: "ignore", stderr: "pipe" });
    if (ap.exitCode !== 0) {
      console.error(`WARNING: audio copy failed:\n${ap.stderr.toString().trim().split("\n").slice(-3).join("\n")}`);
    } else {
      console.log(`Audio → ${audioOut}`);
    }
  }
  console.log("Now run the blind-reconstruction critic on these frames + audio (see SKILL.md).");
}
