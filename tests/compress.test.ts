import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPRESSOR_CHAIN,
  availableCompressors,
  compressWavToM4a,
} from "../skills/_shared/lib/compress.ts";
import { pcmToWav } from "../skills/_shared/lib/tts.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const SAVE_SCRIPT = join(REPO_ROOT, "skills", "make-podcast", "scripts", "save.ts");

// Real-compression tests need at least one tool from the chain. On this
// dev machine afconvert (macOS built-in) is always present; on a bare CI
// box with neither tool the tests skip with a clear message instead of
// failing — mirroring the pipeline's own graceful degradation.
const tools = availableCompressors();
const noCompressor = tools.length === 0;
if (noCompressor) {
  console.warn(
    `compress.test.ts: skipping real-compression tests — none of [${COMPRESSOR_CHAIN.join(", ")}] is installed on this machine.`,
  );
}

/** 2 seconds of a 440Hz sine, s16le 24kHz mono, wrapped as WAV (~96KB). */
function tinyWav(): Uint8Array {
  const sampleRate = 24000;
  const samples = sampleRate * 2;
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
  }
  return pcmToWav(new Uint8Array(pcm.buffer));
}

let dir: string;
let wavPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "distillery-compress-"));
  wavPath = join(dir, "fixture.wav");
  await writeFile(wavPath, tinyWav());
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("availableCompressors", () => {
  test("returns a subset of the chain, in chain order", () => {
    const got = availableCompressors();
    for (const tool of got) expect(COMPRESSOR_CHAIN).toContain(tool);
    const order = got.map((t) => COMPRESSOR_CHAIN.indexOf(t));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("empty chain yields no tools", () => {
    expect(availableCompressors([])).toEqual([]);
  });
});

describe("compressWavToM4a", () => {
  test("empty chain degrades gracefully with a clear reason", async () => {
    const result = await compressWavToM4a(wavPath, join(dir, "never.m4a"), []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no audio compressor found");
  });

  test.skipIf(noCompressor)(
    "compresses a real PCM WAV to a smaller, valid .m4a",
    async () => {
      const m4aPath = join(dir, "fixture.m4a");
      const result = await compressWavToM4a(wavPath, m4aPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(COMPRESSOR_CHAIN).toContain(result.tool);

      const wavSize = (await stat(wavPath)).size;
      const m4aSize = (await stat(m4aPath)).size;
      expect(result.bytes).toBe(m4aSize);
      expect(m4aSize).toBeGreaterThan(0);
      expect(m4aSize).toBeLessThan(wavSize);

      // MP4 container sanity: bytes 4-8 of the first box are "ftyp".
      const head = new Uint8Array(await readFile(m4aPath)).slice(4, 8);
      expect(String.fromCharCode(...head)).toBe("ftyp");
    },
  );

  test.skipIf(noCompressor)(
    "reports per-tool failures (never throws) when the input is not audio",
    async () => {
      const garbage = join(dir, "garbage.wav");
      await writeFile(garbage, "this is not a wav file");
      const result = await compressWavToM4a(garbage, join(dir, "garbage.m4a"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/ffmpeg|afconvert/);
    },
  );
});

// ---------------------------------------------------------------------------
// save.ts end-to-end: the skill emits compressed audio
// ---------------------------------------------------------------------------

function podcastJson(): string {
  return JSON.stringify(
    {
      id: "compress-e2e",
      type: "podcast",
      headline: "Compression end to end",
      body: "Tiny synthetic episode for the compression pipeline test.",
      tags: ["test"],
      source_transcripts: ["/tmp/synthetic.md"],
      audio: "episode.wav",
      generated_at: "2026-06-11T00:00:00.000Z",
      quality: { critic_pass: true, quotes_verified: false, notes: "synthetic" },
    },
    null,
    2,
  );
}

function runSave(env: Record<string, string> | undefined, ...args: string[]) {
  const proc = Bun.spawnSync([process.execPath, SAVE_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: env ?? (process.env as Record<string, string>),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("save.ts — compressed audio emission", () => {
  test.skipIf(noCompressor)(
    "saves episode.m4a alongside the wav master and points artifact.audio at it",
    async () => {
      const outDir = join(dir, "out-compressed");
      const artifactPath = join(dir, "artifact.json");
      const audioPath = join(dir, "episode.wav");
      const scriptPath = join(dir, "script.md");
      await writeFile(artifactPath, podcastJson());
      await writeFile(audioPath, tinyWav());
      await writeFile(scriptPath, "Tiny test line.");

      const res = runSave(
        undefined,
        artifactPath,
        "--audio",
        audioPath,
        "--script",
        scriptPath,
        "--out-dir",
        outDir,
      );
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("smaller via");

      const slugDir = join(outDir, "podcast", "compression-end-to-end");
      const saved = JSON.parse(await readFile(join(slugDir, "artifact.json"), "utf8"));
      expect(saved.audio).toBe("episode.m4a");

      const wavSize = (await stat(join(slugDir, "episode.wav"))).size; // lossless master kept
      const m4aSize = (await stat(join(slugDir, "episode.m4a"))).size;
      expect(m4aSize).toBeGreaterThan(0);
      expect(m4aSize).toBeLessThan(wavSize);
      expect(await readFile(join(slugDir, "script.md"), "utf8")).toBe("Tiny test line.");
    },
  );

  test("with no compressor on PATH it keeps the wav and warns clearly", async () => {
    const outDir = join(dir, "out-uncompressed");
    const artifactPath = join(dir, "artifact-nocomp.json");
    const audioPath = join(dir, "episode-nocomp.wav");
    const scriptPath = join(dir, "script-nocomp.md");
    await writeFile(artifactPath, podcastJson());
    await writeFile(audioPath, tinyWav());
    await writeFile(scriptPath, "Tiny test line.");

    // /var/empty (macOS) and /dev/null parent contain no executables, so
    // Bun.which finds neither ffmpeg nor afconvert in the child process.
    const env = { ...process.env, PATH: "/var/empty" } as Record<string, string>;
    const res = runSave(
      env,
      artifactPath,
      "--audio",
      audioPath,
      "--script",
      scriptPath,
      "--out-dir",
      outDir,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("could not compress");
    expect(res.stderr).toContain("no audio compressor found");

    const slugDir = join(outDir, "podcast", "compression-end-to-end");
    const saved = JSON.parse(await readFile(join(slugDir, "artifact.json"), "utf8"));
    expect(saved.audio).toBe("episode-nocomp.wav");
    expect((await stat(join(slugDir, "episode-nocomp.wav"))).size).toBeGreaterThan(0);
    await expect(stat(join(slugDir, "episode-nocomp.m4a"))).rejects.toThrow();
  });
});
