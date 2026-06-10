import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TTS_MODEL,
  GEMINI_TTS_PCM,
  buildTtsRequestBody,
  isRawPcmMime,
  pcmDurationSeconds,
  pcmFormatFromMime,
  pcmToWav,
  synthesizeSpeech,
} from "../skills/_shared/lib/tts.ts";
import { writeArtifact, type Artifact } from "../skills/_shared/lib/artifact.ts";

// ---------------------------------------------------------------------------
// Request-shape construction (no network) — pinned to the official docs:
// https://ai.google.dev/gemini-api/docs/speech-generation
// ---------------------------------------------------------------------------

describe("buildTtsRequestBody", () => {
  test("monologue: responseModalities AUDIO + prebuiltVoiceConfig", () => {
    const body = buildTtsRequestBody("Hello world.", "Kore") as {
      contents: { parts: { text: string }[] }[];
      generationConfig: {
        responseModalities: string[];
        speechConfig: {
          voiceConfig?: { prebuiltVoiceConfig: { voiceName: string } };
          multiSpeakerVoiceConfig?: unknown;
        };
      };
    };
    expect(body.contents[0]?.parts[0]?.text).toBe("Hello world.");
    expect(body.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(
      body.generationConfig.speechConfig.voiceConfig?.prebuiltVoiceConfig.voiceName,
    ).toBe("Kore");
    expect(body.generationConfig.speechConfig.multiSpeakerVoiceConfig).toBeUndefined();
  });

  test("dialogue: multiSpeakerVoiceConfig with per-speaker prebuilt voices", () => {
    const body = buildTtsRequestBody("Alex: hi\nSam: hey", [
      { speaker: "Alex", voiceName: "Kore" },
      { speaker: "Sam", voiceName: "Puck" },
    ]) as {
      generationConfig: {
        speechConfig: {
          voiceConfig?: unknown;
          multiSpeakerVoiceConfig?: {
            speakerVoiceConfigs: {
              speaker: string;
              voiceConfig: { prebuiltVoiceConfig: { voiceName: string } };
            }[];
          };
        };
      };
    };
    const configs =
      body.generationConfig.speechConfig.multiSpeakerVoiceConfig?.speakerVoiceConfigs;
    expect(configs).toHaveLength(2);
    expect(configs?.[0]).toEqual({
      speaker: "Alex",
      voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
    });
    expect(configs?.[1]?.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Puck");
    expect(body.generationConfig.speechConfig.voiceConfig).toBeUndefined();
  });

  test("rejects empty script, empty voice, and >2 speakers (API max)", () => {
    expect(() => buildTtsRequestBody("   ", "Kore")).toThrow("script");
    expect(() => buildTtsRequestBody("hi", " ")).toThrow("voice");
    expect(() => buildTtsRequestBody("hi", [])).toThrow("1-2 speakers");
    expect(() =>
      buildTtsRequestBody("hi", [
        { speaker: "A", voiceName: "Kore" },
        { speaker: "B", voiceName: "Puck" },
        { speaker: "C", voiceName: "Zephyr" },
      ]),
    ).toThrow("1-2 speakers");
    expect(() =>
      buildTtsRequestBody("hi", [{ speaker: "", voiceName: "Kore" }]),
    ).toThrow("non-empty");
  });
});

// ---------------------------------------------------------------------------
// PCM → WAV wrapping
// ---------------------------------------------------------------------------

describe("pcmToWav", () => {
  test("writes a correct 44-byte RIFF header for known PCM input", () => {
    const pcm = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const wav = pcmToWav(pcm); // defaults: 24kHz, mono, 16-bit
    expect(wav.length).toBe(44 + 4);

    const ascii = (start: number, len: number) =>
      String.fromCharCode(...wav.slice(start, start + len));
    const view = new DataView(wav.buffer);

    expect(ascii(0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 4); // riff chunk size
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM format tag
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24000); // sample rate
    expect(view.getUint32(28, true)).toBe(48000); // byte rate = 24000*1*2
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(ascii(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(4); // data length
    expect([...wav.slice(44)]).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  test("honors a non-default format", () => {
    const wav = pcmToWav(new Uint8Array(8), {
      sampleRate: 16000,
      channels: 2,
      bitsPerSample: 16,
    });
    const view = new DataView(wav.buffer);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(64000); // 16000*2*2
    expect(view.getUint16(32, true)).toBe(4);
  });
});

describe("pcm format helpers", () => {
  test("pcmFormatFromMime parses the documented Gemini mime", () => {
    const fmt = pcmFormatFromMime("audio/L16;codec=pcm;rate=24000");
    expect(fmt).toEqual({ sampleRate: 24000, channels: 1, bitsPerSample: 16 });
  });

  test("pcmFormatFromMime picks up non-default rate and falls back otherwise", () => {
    expect(pcmFormatFromMime("audio/L16;codec=pcm;rate=16000").sampleRate).toBe(16000);
    expect(pcmFormatFromMime("")).toEqual(GEMINI_TTS_PCM);
  });

  test("isRawPcmMime", () => {
    expect(isRawPcmMime("audio/L16;codec=pcm;rate=24000")).toBe(true);
    expect(isRawPcmMime("audio/mp3")).toBe(false);
  });

  test("pcmDurationSeconds: one second of s16le 24kHz mono is 48000 bytes", () => {
    expect(pcmDurationSeconds(48000)).toBe(1);
    expect(pcmDurationSeconds(48000 * 150)).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// synthesizeSpeech — fetch mocked; no live API calls in tests
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { calls: { url: string; init: RequestInit }[] } {
  const calls: { calls: { url: string; init: RequestInit }[] } = { calls: [] };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  return calls;
}

function audioResponse(pcm: Uint8Array, mimeType = "audio/L16;codec=pcm;rate=24000") {
  return Response.json({
    candidates: [
      {
        content: {
          parts: [
            { inlineData: { mimeType, data: Buffer.from(pcm).toString("base64") } },
          ],
        },
      },
    ],
  });
}

describe("synthesizeSpeech", () => {
  test("posts the documented request and decodes inlineData audio", async () => {
    const pcm = new Uint8Array([9, 8, 7, 6, 5]);
    const seen = mockFetch(() => audioResponse(pcm));

    const result = await synthesizeSpeech({
      script: "Tiny test line.",
      voices: "Kore",
      apiKey: "test-key",
    });

    expect(result.bytes).toEqual(pcm);
    expect(result.mimeType).toBe("audio/L16;codec=pcm;rate=24000");

    expect(seen.calls).toHaveLength(1);
    const call = seen.calls[0]!;
    expect(call.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_TTS_MODEL}:generateContent`,
    );
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("test-key");
    expect(headers["content-type"]).toBe("application/json");

    const body = JSON.parse(call.init.body as string);
    expect(body).toEqual(buildTtsRequestBody("Tiny test line.", "Kore"));
  });

  test("uses multiSpeakerVoiceConfig and a custom model when given", async () => {
    const seen = mockFetch(() => audioResponse(new Uint8Array([1])));
    await synthesizeSpeech({
      script: "Alex: hi\nSam: hey",
      voices: [
        { speaker: "Alex", voiceName: "Kore" },
        { speaker: "Sam", voiceName: "Puck" },
      ],
      model: "gemini-2.5-pro-preview-tts",
      apiKey: "k",
    });
    const call = seen.calls[0]!;
    expect(call.url).toContain("gemini-2.5-pro-preview-tts:generateContent");
    const body = JSON.parse(call.init.body as string);
    expect(
      body.generationConfig.speechConfig.multiSpeakerVoiceConfig.speakerVoiceConfigs,
    ).toHaveLength(2);
  });

  test("throws with status + body text on a non-ok response", async () => {
    mockFetch(() => new Response("voice not found", { status: 400 }));
    expect(
      synthesizeSpeech({ script: "hi", voices: "Nope", apiKey: "k" }),
    ).rejects.toThrow("gemini tts 400: voice not found");
  });

  test("throws when the response carries no audio part", async () => {
    mockFetch(() =>
      Response.json({
        candidates: [{ content: { parts: [{ text: "cannot comply" }] } }],
      }),
    );
    expect(
      synthesizeSpeech({ script: "hi", voices: "Kore", apiKey: "k" }),
    ).rejects.toThrow(/no audio in response.*cannot comply/);
  });

  test("explicit apiKey wins without consulting env/secrets", async () => {
    // No env mutation here: passing apiKey must be sufficient on its own.
    mockFetch(() => audioResponse(new Uint8Array([1, 2])));
    const result = await synthesizeSpeech({
      script: "hi",
      voices: "Kore",
      apiKey: "explicit",
    });
    expect(result.bytes.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Podcast artifact persistence — artifact.json + audio + script.md together
// ---------------------------------------------------------------------------

describe("podcast artifact saving", () => {
  test("writes artifacts/podcast/<slug>/ with audio and script alongside", async () => {
    const dir = await mkdtemp(join(tmpdir(), "distillery-podcast-"));
    try {
      const artifact: Artifact = {
        id: "p-1",
        type: "podcast",
        headline: "Why we killed seat-based pricing",
        body: "A two-minute episode on the pricing pivot.",
        tags: ["pricing"],
        source_transcripts: ["/tmp/fireflies-style.md"],
        source_quotes: [
          { quote: "Seats punish our best users.", transcript: "/tmp/fireflies-style.md" },
        ],
        audio: "episode.wav",
        generated_at: "2026-06-10T12:00:00.000Z",
        generation_model: "gemini-2.5-flash-preview-tts",
        quality: { critic_pass: true, quotes_verified: true, notes: "1 angle of 3 survived" },
      };
      const wav = pcmToWav(new Uint8Array([1, 2, 3, 4]));
      const written = await writeArtifact(artifact, {
        outDir: dir,
        media: {
          "episode.wav": wav,
          "script.md": new TextEncoder().encode("Tiny test line."),
        },
      });

      expect(written.jsonPath).toBe(
        join(dir, "podcast", "why-we-killed-seat-based-pricing", "artifact.json"),
      );
      const roundTrip = JSON.parse(await readFile(written.jsonPath, "utf8"));
      expect(roundTrip.type).toBe("podcast");
      expect(roundTrip.audio).toBe("episode.wav");

      const audio = new Uint8Array(await readFile(join(written.dir, "episode.wav")));
      expect(audio).toEqual(wav);
      expect(String.fromCharCode(...audio.slice(0, 4))).toBe("RIFF");
      expect(await readFile(join(written.dir, "script.md"), "utf8")).toBe("Tiny test line.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
