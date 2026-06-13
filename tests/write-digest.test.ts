// write-digest tests — the digest-specific save rules on top of the shared
// artifact contract (multi-transcript requirement, type fence, word-target
// warning, body.md alongside). Quote verification itself is covered by
// write-article.test.ts + check-quote.test.ts against the same shared
// implementation (skills/_shared/lib/quotes.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveDigest, TARGET_WORDS_MIN, TARGET_WORDS_MAX } from "../skills/write-digest/scripts/digest.ts";
import { slugify } from "../skills/_shared/lib/artifact.ts";

let dir: string;
let pathOne: string;
let pathTwo: string;

const SYNC_ONE = `# Infra Sync Alpha
**Date:** 2026-03-01
**Participants:** ada@example.com, grace@example.com

## Transcript

**Ada Lovelace:**
The cache keys are unversioned, so every deploy invalidates the whole cache.
`;

const SYNC_TWO = `# Infra Sync Beta
**Date:** 2026-03-08
**Participants:** ada@example.com, linus@example.com

## Transcript

**Linus Pauling:**
Customers complained about latency during the launch window.
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "write-digest-"));
  pathOne = join(dir, "sync-alpha.md");
  pathTwo = join(dir, "sync-beta.md");
  await writeFile(pathOne, SYNC_ONE);
  await writeFile(pathTwo, SYNC_TWO);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function digestArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body = [
    "*Two rooms hit the same wall in one week.*",
    "",
    "> The cache keys are unversioned, so every deploy invalidates the whole cache. — Ada Lovelace",
    "",
    "> Customers complained about latency during the launch window. — Linus Pauling",
  ].join("\n");
  return {
    type: "digest",
    headline: "The latency complaints in two meetings share one root cause",
    body,
    quote: "The cache keys are unversioned, so every deploy invalidates the whole cache.",
    attribution: "Ada Lovelace",
    tags: ["infrastructure", "latency"],
    source_transcripts: [pathOne, pathTwo],
    source_quotes: [
      {
        quote: "The cache keys are unversioned, so every deploy invalidates the whole cache.",
        speaker: "Ada Lovelace",
        transcript: pathOne,
      },
      {
        quote: "Customers complained about latency during the launch window.",
        speaker: "Linus Pauling",
        transcript: pathTwo,
      },
    ],
    generated_at: "2026-06-12T12:00:00.000Z",
    generation_model: "agent-judgment",
    quality: { critic_pass: true, quotes_verified: true, notes: "synthetic test artifact" },
    ...overrides,
  };
}

describe("saveDigest", () => {
  test("writes artifacts/digest/<slug>/artifact.json with body.md alongside", async () => {
    const outDir = join(dir, "out-save");
    const artifact = digestArtifact();
    const saved = await saveDigest(artifact, { outDir });
    expect(saved.written.jsonPath).toBe(
      join(outDir, "digest", slugify(artifact.headline as string), "artifact.json"),
    );
    const roundTrip = JSON.parse(await readFile(saved.written.jsonPath, "utf8"));
    expect(roundTrip.type).toBe("digest");
    const bodyMd = await readFile(join(saved.written.dir, "body.md"), "utf8");
    expect(bodyMd.trimEnd()).toBe((artifact.body as string).trimEnd());
  });

  test("rejects fewer than 2 source_transcripts — a digest is multi-thread by definition", async () => {
    const outDir = join(dir, "out-single");
    const single = digestArtifact({ source_transcripts: [pathOne] });
    expect(saveDigest(single, { outDir })).rejects.toThrow(">= 2 source_transcripts");
    const none = digestArtifact({ source_transcripts: [] });
    expect(saveDigest(none, { outDir })).rejects.toThrow(">= 2 source_transcripts");
  });

  test("rejects non-digest types and missing bodies", async () => {
    const outDir = join(dir, "out-reject");
    expect(saveDigest(digestArtifact({ type: "article" }), { outDir })).rejects.toThrow(
      'only saves type "digest"',
    );
    const noBody = digestArtifact();
    delete noBody.body;
    expect(saveDigest(noBody, { outDir })).rejects.toThrow("non-empty markdown body");
  });

  test("fills id/generated_at defaults and strips hero_image: null", async () => {
    const outDir = join(dir, "out-defaults");
    const artifact = digestArtifact({ hero_image: null as unknown as string });
    delete artifact.id;
    delete artifact.generated_at;
    const saved = await saveDigest(artifact, { outDir });
    const roundTrip = JSON.parse(await readFile(saved.written.jsonPath, "utf8"));
    expect(typeof roundTrip.id).toBe("string");
    expect(Number.isNaN(Date.parse(roundTrip.generated_at))).toBe(false);
    expect("hero_image" in roundTrip).toBe(false);
  });

  test(`warns (non-fatally) outside the ${TARGET_WORDS_MIN}-${TARGET_WORDS_MAX} word target`, async () => {
    const outDir = join(dir, "out-warn");
    const short = await saveDigest(digestArtifact(), { outDir });
    expect(short.warnings.length).toBe(1);
    expect(short.warnings[0]).toContain(`${TARGET_WORDS_MIN}-${TARGET_WORDS_MAX}`);

    const filler = Array.from({ length: 360 }, (_, i) => `word${i}`).join(" ");
    const sized = await saveDigest(
      digestArtifact({
        headline: "A properly sized digest about recurring latency",
        body: digestArtifact().body + "\n\n" + filler,
      }),
      { outDir },
    );
    expect(sized.warnings.length).toBe(0);
  });
});
