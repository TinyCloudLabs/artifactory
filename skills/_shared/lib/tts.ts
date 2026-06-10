// Gemini TTS client for distillery skills (make-podcast).
//
// Request/response shapes are built from Google's official docs:
//   https://ai.google.dev/gemini-api/docs/speech-generation
// Verified against the docs on 2026-06-10, NOT yet against the live API
// (no key on the build machine). Per the docs:
//   - models: gemini-2.5-flash-preview-tts (default here),
//     gemini-2.5-pro-preview-tts, gemini-3.1-flash-tts-preview
//   - request: generateContent with generationConfig.responseModalities
//     ["AUDIO"] and generationConfig.speechConfig carrying either
//     voiceConfig.prebuiltVoiceConfig.voiceName (single speaker) or
//     multiSpeakerVoiceConfig.speakerVoiceConfigs (up to 2 speakers whose
//     names match the "Name:" labels in the script text)
//   - response: candidates[0].content.parts[0].inlineData.data = base64
//     raw PCM, signed 16-bit little-endian, 24 kHz, mono
// Raw PCM is unplayable as-is, so this module also ships a WAV wrapper.
//
// Keys resolve through the secrets fallback chain unless apiKey is passed.
// Kept separate from gemini.ts so image/text helpers stay untouched.

import { getSecret } from "./secrets.ts";

export const DEFAULT_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** One speaker in a dialogue script, mapped to a Gemini prebuilt voice. */
export interface SpeakerVoice {
  /** Must match the "Name:" turn labels used in the script text. */
  speaker: string;
  /** Prebuilt voice name, e.g. "Kore", "Puck" (30 listed in the docs). */
  voiceName: string;
}

export interface SynthesizeSpeechOptions {
  /** The full text to speak. For dialogue: "Name: line" turns. */
  script: string;
  /**
   * A single prebuilt voice name (monologue) or 1–2 SpeakerVoice entries
   * (multi-speaker; the API supports at most 2 speakers).
   */
  voices: string | SpeakerVoice[];
  /** Defaults to gemini-2.5-flash-preview-tts. */
  model?: string;
  apiKey?: string;
}

export interface SynthesizedSpeech {
  /** Audio bytes exactly as returned (raw PCM per the docs). */
  bytes: Uint8Array;
  /** e.g. "audio/L16;codec=pcm;rate=24000" (empty if API omits it). */
  mimeType: string;
}

const MAX_SPEAKERS = 2;

/**
 * Build the generateContent request body for a TTS call. Pure function so
 * tests can pin the request shape without any network.
 */
export function buildTtsRequestBody(
  script: string,
  voices: string | SpeakerVoice[],
): Record<string, unknown> {
  if (!script.trim()) throw new Error("tts: script must be non-empty");

  let speechConfig: Record<string, unknown>;
  if (typeof voices === "string") {
    if (!voices.trim()) throw new Error("tts: voice name must be non-empty");
    speechConfig = {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: voices } },
    };
  } else {
    if (voices.length === 0 || voices.length > MAX_SPEAKERS) {
      throw new Error(
        `tts: multi-speaker config takes 1-${MAX_SPEAKERS} speakers, got ${voices.length}`,
      );
    }
    for (const v of voices) {
      if (!v.speaker.trim() || !v.voiceName.trim()) {
        throw new Error("tts: each speaker needs a non-empty speaker and voiceName");
      }
    }
    speechConfig = {
      multiSpeakerVoiceConfig: {
        speakerVoiceConfigs: voices.map((v) => ({
          speaker: v.speaker,
          voiceConfig: { prebuiltVoiceConfig: { voiceName: v.voiceName } },
        })),
      },
    };
  }

  return {
    contents: [{ parts: [{ text: script }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig,
    },
  };
}

/**
 * Call Gemini TTS and return the audio bytes + mime type. The docs say the
 * payload is raw PCM (s16le, 24 kHz, mono) — wrap with pcmToWav to get a
 * playable file.
 */
export async function synthesizeSpeech(
  opts: SynthesizeSpeechOptions,
): Promise<SynthesizedSpeech> {
  const apiKey = opts.apiKey?.trim() || (await getSecret("GEMINI_API_KEY"));
  const model = opts.model ?? DEFAULT_TTS_MODEL;
  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent`;
  const body = buildTtsRequestBody(opts.script, opts.voices);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`gemini tts ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: unknown[] } }[];
  };
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = (part as { inlineData?: { data?: unknown; mimeType?: unknown } })
      ?.inlineData;
    if (inline?.data && typeof inline.data === "string") {
      return {
        bytes: Uint8Array.from(Buffer.from(inline.data, "base64")),
        mimeType: typeof inline.mimeType === "string" ? inline.mimeType : "",
      };
    }
  }
  const textOnly = parts
    .map((p) => (p as { text?: unknown })?.text)
    .find((t): t is string => typeof t === "string");
  throw new Error(
    `gemini tts: no audio in response${textOnly ? ` (text: ${textOnly.slice(0, 200)})` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// PCM → WAV
// ---------------------------------------------------------------------------

export interface PcmFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/** Gemini TTS output format per the docs: s16le PCM, 24 kHz, mono. */
export const GEMINI_TTS_PCM: PcmFormat = {
  sampleRate: 24000,
  channels: 1,
  bitsPerSample: 16,
};

/**
 * Derive the PCM format from an inlineData mime type like
 * "audio/L16;codec=pcm;rate=24000". Unknown/missing fields fall back to the
 * documented Gemini TTS defaults.
 */
export function pcmFormatFromMime(mimeType: string): PcmFormat {
  const fmt = { ...GEMINI_TTS_PCM };
  const rate = /rate=(\d+)/.exec(mimeType)?.[1];
  if (rate) fmt.sampleRate = Number(rate);
  const bits = /audio\/L(\d+)/i.exec(mimeType)?.[1];
  if (bits) fmt.bitsPerSample = Number(bits);
  return fmt;
}

/** True when the mime type looks like raw PCM needing a WAV wrapper. */
export function isRawPcmMime(mimeType: string): boolean {
  return /audio\/L\d+/i.test(mimeType) || /codec=pcm/i.test(mimeType);
}

/**
 * Wrap raw PCM bytes in a standard 44-byte RIFF/WAVE header so the result
 * plays anywhere (no ffmpeg dependency).
 */
export function pcmToWav(
  pcm: Uint8Array,
  fmt: PcmFormat = GEMINI_TTS_PCM,
): Uint8Array<ArrayBuffer> {
  const { sampleRate, channels, bitsPerSample } = fmt;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;

  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // audio format 1 = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** Duration implied by a raw-PCM byte length (bytes / byte-rate). */
export function pcmDurationSeconds(
  pcmByteLength: number,
  fmt: PcmFormat = GEMINI_TTS_PCM,
): number {
  const byteRate = (fmt.sampleRate * fmt.channels * fmt.bitsPerSample) / 8;
  return pcmByteLength / byteRate;
}
