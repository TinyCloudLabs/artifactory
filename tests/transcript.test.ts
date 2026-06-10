import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  chunkTranscript,
  loadTranscripts,
  parseTranscript,
  verifyQuote,
} from "../skills/_shared/lib/transcript.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const CORPUS = join(FIXTURES, "corpus");

describe("parseTranscript — fireflies/gemini-sync style", () => {
  async function parsed() {
    const path = join(CORPUS, "fireflies-style.md");
    return parseTranscript(await readFile(path, "utf8"), path);
  }

  test("extracts header metadata", async () => {
    const t = await parsed();
    expect(t.title).toBe("Widget Co Weekly Sync");
    expect(t.date).toBe("2026-01-15");
    expect(t.duration).toBe("30 min");
    expect(t.participants).toEqual(["ada@example.com", "grace@example.com"]);
  });

  test("captures summary and action items sections", async () => {
    const t = await parsed();
    expect(t.summary).toContain("usage-based pricing");
    expect(t.actionItems).toContain("Draft the usage-based pricing experiment doc");
  });

  test("parses speaker turns with multi-paragraph bodies and timestamps", async () => {
    const t = await parsed();
    expect(t.turns).toHaveLength(3);
    expect(t.turns[0]?.speaker).toBe("Ada Lovelace");
    expect(t.turns[0]?.text).toContain("charge by the widget");
    expect(t.turns[0]?.text).toContain("Seats punish our best users.");
    expect(t.turns[1]?.speaker).toBe("Grace Hopper");
    expect(t.turns[1]?.timestamp).toBe("00:12:30");
  });

  test("action-item bold names are not misread as turns", async () => {
    const t = await parsed();
    expect(t.turns.every((turn) => !turn.text.includes("job board"))).toBe(true);
  });
});

describe("parseTranscript — yaml frontmatter style", () => {
  test("reads frontmatter and turns", async () => {
    const path = join(CORPUS, "frontmatter-style.md");
    const t = parseTranscript(await readFile(path, "utf8"), path);
    expect(t.title).toBe("Roadmap Brainstorm");
    expect(t.date).toBe("2026-02-02");
    expect(t.source).toBe("voxterm");
    expect(t.turns).toHaveLength(2);
    expect(t.turns[1]?.speaker).toBe("Grace");
    expect(t.turns[1]?.text).toContain("time-to-value");
  });
});

describe("parseTranscript — bare diarized + plain fallback", () => {
  test("parses 'Name: text' lines", async () => {
    const path = join(CORPUS, "bare-diarized.md");
    const t = parseTranscript(await readFile(path, "utf8"), path);
    expect(t.turns).toHaveLength(3);
    expect(t.turns[0]?.speaker).toBe("Ada");
    expect(t.turns[2]?.text).toContain("version the cache keys");
  });

  test("plain text becomes a single unattributed turn", async () => {
    const path = join(FIXTURES, "plain.txt");
    const t = parseTranscript(await readFile(path, "utf8"), path);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]?.speaker).toBeUndefined();
    expect(t.turns[0]?.text).toContain("no speakers at all");
  });
});

describe("parseTranscript — prose-with-colon regression", () => {
  test("prose line containing a colon stays attached to the preceding speaker", () => {
    const raw = [
      "Ada: The cache invalidation bug only shows up on the second deploy.",
      "Same root cause: deploys flush the cache.",
      "Grace: Because the first deploy warms the cache with stale keys.",
    ].join("\n");
    const t = parseTranscript(raw);
    expect(t.turns).toHaveLength(2);
    expect(t.turns[0]?.speaker).toBe("Ada");
    expect(t.turns[0]?.text).toContain("Same root cause: deploys flush the cache.");
    expect(t.turns.map((turn) => turn.speaker)).not.toContain("Same root cause");
  });

  test("lowercase and over-long colon labels never start turns", () => {
    const raw = [
      "Ada: Here's the plan.",
      "first thing tomorrow: revert the deploy.",
      "The Next Step For Us All: rotate on-call.",
    ].join("\n");
    const t = parseTranscript(raw);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]?.speaker).toBe("Ada");
    expect(t.turns[0]?.text).toContain("rotate on-call.");
  });

  test("name-like colon lines inside a bold-format file are body text, not turns", () => {
    const raw = [
      "## Transcript",
      "",
      "**Ada Lovelace:**",
      "Two options on the table.",
      "Plan B: we ship Friday.",
      "",
      "**Grace Hopper:**",
      "Friday works.",
    ].join("\n");
    const t = parseTranscript(raw);
    expect(t.turns).toHaveLength(2);
    expect(t.turns[0]?.speaker).toBe("Ada Lovelace");
    expect(t.turns[0]?.text).toContain("Plan B: we ship Friday.");
  });

  test("real diarization name shapes still parse as turns", () => {
    const raw = [
      "[00:12] Grace Hopper: Timestamped turn.",
      "O'Brien: Apostrophe surname.",
      "Mary-Jane Watson: Hyphenated first name.",
      "Speaker 2: Numbered diarizer label.",
      "Ada Augusta King: Three-word name.",
    ].join("\n");
    const t = parseTranscript(raw);
    expect(t.turns.map((turn) => turn.speaker)).toEqual([
      "Grace Hopper",
      "O'Brien",
      "Mary-Jane Watson",
      "Speaker 2",
      "Ada Augusta King",
    ]);
    expect(t.turns[0]?.timestamp).toBe("00:12");
  });
});

describe("loadTranscripts", () => {
  test("walks directories recursively, picking only .md/.txt", async () => {
    const all = await loadTranscripts([FIXTURES]);
    expect(all.length).toBe(4); // 3 corpus .md + plain.txt
  });

  test("accepts a mix of files and dirs", async () => {
    const all = await loadTranscripts([
      join(FIXTURES, "plain.txt"),
      CORPUS,
    ]);
    expect(all.length).toBe(4);
  });

  test("throws on a missing path", async () => {
    expect(loadTranscripts([join(FIXTURES, "nope.md")])).rejects.toThrow();
  });
});

describe("chunkTranscript", () => {
  test("groups turns under maxChars and tracks speakers", async () => {
    const path = join(CORPUS, "fireflies-style.md");
    const t = parseTranscript(await readFile(path, "utf8"), path);
    const chunks = chunkTranscript(t, 120);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.transcript).toBe(path);
    expect(chunks[0]?.index).toBe(0);
    expect(chunks.flatMap((c) => c.speakers)).toContain("Grace Hopper");
    // No text lost: all turn text appears across chunks.
    const joined = chunks.map((c) => c.text).join("\n\n");
    for (const turn of t.turns) expect(joined).toContain(turn.text);
  });

  test("one big chunk when under the limit", async () => {
    const path = join(CORPUS, "bare-diarized.md");
    const t = parseTranscript(await readFile(path, "utf8"), path);
    expect(chunkTranscript(t, 100_000)).toHaveLength(1);
  });
});

describe("verifyQuote", () => {
  test("matches verbatim quotes whitespace-insensitively", async () => {
    const path = join(CORPUS, "fireflies-style.md");
    const t = parseTranscript(await readFile(path, "utf8"), path);
    expect(verifyQuote(t, "Usage-based pricing aligns revenue")).toBe(true);
    expect(verifyQuote(t, "usage-based   pricing\naligns revenue")).toBe(true);
  });

  test("rejects paraphrases and empty quotes", async () => {
    const path = join(CORPUS, "fireflies-style.md");
    const t = parseTranscript(await readFile(path, "utf8"), path);
    expect(verifyQuote(t, "pricing should align with revenue value")).toBe(false);
    expect(verifyQuote(t, "   ")).toBe(false);
  });
});
