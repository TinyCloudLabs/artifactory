// Audio compression: WAV → AAC in an .m4a container, via a graceful tool
// fallback chain. Raw Gemini TTS output saved as PCM WAV is ~9MB for a
// 3-minute episode; AAC is ~12x smaller and plays natively in browsers,
// so every artifact consumer (review page, feed, sharing) gets a small
// web-playable file for free.
//
// Chain (in order):
//   1. ffmpeg     — cross-platform, commonly installed
//   2. afconvert  — macOS built-in (no install needed)
//   3. neither    — caller keeps the WAV and warns; never a hard failure
//
// Agent-agnostic by design: no hard dependency on either tool.

import { stat } from "node:fs/promises";

export type AudioCompressor = "ffmpeg" | "afconvert";

/** Preferred tool order. */
export const COMPRESSOR_CHAIN: readonly AudioCompressor[] = ["ffmpeg", "afconvert"];

/** Which tools from the chain are actually on PATH, in chain order. */
export function availableCompressors(
  chain: readonly AudioCompressor[] = COMPRESSOR_CHAIN,
): AudioCompressor[] {
  return chain.filter((tool) => Bun.which(tool) !== null);
}

function commandFor(tool: AudioCompressor, wavPath: string, m4aPath: string): string[] {
  switch (tool) {
    case "ffmpeg":
      // 64k AAC is transparent for mono 24kHz speech; +faststart fronts the
      // moov atom so browsers can start playback before the full download.
      // prettier-ignore
      return [
        "ffmpeg", "-y", "-i", wavPath,
        "-c:a", "aac", "-b:a", "64k",
        "-movflags", "+faststart",
        m4aPath,
      ];
    case "afconvert":
      // Verified working: `afconvert -f m4af -d aac in.wav out.m4a`.
      return ["afconvert", "-f", "m4af", "-d", "aac", wavPath, m4aPath];
  }
}

export type CompressResult =
  | { ok: true; tool: AudioCompressor; bytes: number }
  | { ok: false; reason: string };

/**
 * Compress a WAV file to AAC (.m4a) using the first tool in the chain that
 * is installed AND succeeds. Never throws for missing/failing tools —
 * returns { ok: false, reason } so callers can degrade to the WAV.
 */
export async function compressWavToM4a(
  wavPath: string,
  m4aPath: string,
  chain: readonly AudioCompressor[] = COMPRESSOR_CHAIN,
): Promise<CompressResult> {
  const tools = availableCompressors(chain);
  if (tools.length === 0) {
    return {
      ok: false,
      reason: `no audio compressor found (tried: ${chain.join(", ")})`,
    };
  }

  const failures: string[] = [];
  for (const tool of tools) {
    const proc = Bun.spawnSync(commandFor(tool, wavPath, m4aPath), {
      stdout: "ignore",
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      try {
        const { size } = await stat(m4aPath);
        if (size > 0) return { ok: true, tool, bytes: size };
        failures.push(`${tool}: produced an empty file`);
      } catch {
        failures.push(`${tool}: exited 0 but wrote no output file`);
      }
    } else {
      const err = proc.stderr.toString().trim().split("\n").at(-1) ?? "";
      failures.push(`${tool}: exit ${proc.exitCode}${err ? ` (${err})` : ""}`);
    }
  }
  return { ok: false, reason: failures.join("; ") };
}
