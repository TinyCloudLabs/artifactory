// Synthetic artifact fixtures written to a temp dir for scan/API tests.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Fixture {
  dir: string;
  cleanup: () => Promise<void>;
}

function artifact(overrides: Record<string, unknown>): string {
  return JSON.stringify(
    {
      id: crypto.randomUUID(),
      type: "insight-card",
      headline: "Headline",
      tags: [],
      source_transcripts: ["/tmp/t.md"],
      generated_at: "2026-06-01T00:00:00Z",
      quality: { critic_pass: true, quotes_verified: true },
      ...overrides,
    },
    null,
    2,
  );
}

export async function makeFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "distillery-feed-test-"));

  const write = async (type: string, slug: string, json: string | null, media: Record<string, Uint8Array> = {}) => {
    const d = join(dir, type, slug);
    await mkdir(d, { recursive: true });
    if (json !== null) await writeFile(join(d, "artifact.json"), json);
    for (const [name, bytes] of Object.entries(media)) {
      await writeFile(join(d, name), bytes);
    }
  };

  // Newest: podcast with audio + hero
  await write(
    "podcast",
    "newest-podcast",
    artifact({
      id: "pod-1",
      type: "podcast",
      headline: "Newest podcast",
      body: "Show notes with **bold**.",
      audio: "episode.wav",
      hero_image: "hero.png",
      generated_at: "2026-06-09T12:00:00Z",
      tags: ["audio", "weekly"],
    }),
    {
      "episode.wav": new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      "hero.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    },
  );

  // Middle: insight card whose hero_image is referenced but MISSING on disk
  await write(
    "insight-card",
    "middle-insight",
    artifact({
      id: "ins-1",
      headline: "Middle insight",
      quote: "A quote.",
      attribution: "Someone",
      hero_image: "hero.png", // not written
      generated_at: "2026-06-05T12:00:00Z",
    }),
  );

  // Oldest: article, minimal fields (no tags array, no quality), with a
  // body.md sidecar that must win over the (absent) artifact.json body.
  await write(
    "article",
    "oldest-article",
    `{"id":"art-1","type":"article","headline":"Oldest article","generated_at":"2026-06-01T12:00:00Z","source_transcripts":["/tmp/t.md"]}`,
    { "body.md": new TextEncoder().encode("# Full article\n\nFrom body.md.") },
  );

  // Unknown future type — must still surface as a card
  await write(
    "fever-dream",
    "unknown-type",
    artifact({
      id: "unk-1",
      type: "fever-dream",
      headline: "Unknown type artifact",
      generated_at: "2026-06-03T12:00:00Z",
    }),
  );

  // Broken JSON — skipped
  await write("insight-card", "broken-json", "{ not json !!!");

  // Dir without artifact.json — skipped
  await write("insight-card", "empty-dir", null, { "stray.png": new Uint8Array([1]) });

  // Stray file at type level — ignored (not a directory)
  await writeFile(join(dir, "insight-card", "stray.txt"), "ignore me");

  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
