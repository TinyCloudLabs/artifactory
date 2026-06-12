import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTranscripts, parseTranscript } from "../skills/_shared/lib/transcript.ts";
import { slugify, type Artifact } from "../skills/_shared/lib/artifact.ts";
import {
  gatherPersonMentions,
  mentionInText,
  nameVariants,
  renderDossierMarkdown,
  saveBrief,
  speakerIsPerson,
  textMatchVariants,
  verifyArtifactQuotes,
} from "../skills/person-brief/scripts/person-brief.ts";

// Synthetic fixtures only — never real meeting content. Samuel Gbafa speaks in
// two transcripts and is mentioned by others; "Tina (Flashbots)" carries a
// diarizer affiliation; a lone "Sam" appears that must NOT be silently captured.
const CALL_ONE = `# Founder Call Alpha
**Date:** 2026-03-01
**Participants:** samuel@example.com, grace@example.com

## Transcript

**Grace Hopper:**
Samuel, how are you thinking about permissioning for the data vault?

**Samuel Gbafa:**
I'm at TinyCloud, and we treat delegation as the core primitive — every read is a capability, not an ACL.

**Grace Hopper:**
That's the thing I keep wanting Gbafa to write down.
`;

const CALL_TWO = `# Founder Call Beta
**Date:** 2026-03-08
**Participants:** samuel@example.com, tina@flashbots.net

## Transcript

**Tina (Flashbots):**
Samuel said last week that delegation beats ACLs, and I want to push on that.

**Samuel Gbafa:**
Right — the open thread is whether sharing links can be revoked without a server round trip.

**Samantha Power:**
Same here, we should follow up.
`;

let dir: string;
let pathOne: string;
let pathTwo: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "distillery-person-brief-"));
  pathOne = join(dir, "call-alpha.md");
  pathTwo = join(dir, "call-beta.md");
  await writeFile(pathOne, CALL_ONE);
  await writeFile(pathTwo, CALL_TWO);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("nameVariants", () => {
  test("includes full name and component words, drops sub-2-char tokens", () => {
    const v = nameVariants("Samuel Gbafa");
    expect(v).toContain("samuel gbafa");
    expect(v).toContain("samuel");
    expect(v).toContain("gbafa");
  });

  test("normalizes whitespace and case", () => {
    expect(nameVariants("  Ada   Lovelace ")).toContain("ada lovelace");
  });
});

describe("textMatchVariants", () => {
  test("drops generic stopword single-token components for free-text scanning", () => {
    // "Nobody Here": "here" is a stopword and must not match prose; the full
    // phrase survives.
    const tv = textMatchVariants(nameVariants("Nobody Here"));
    expect(tv).toContain("nobody here");
    expect(tv).not.toContain("here");
  });
  test("keeps name-like single tokens", () => {
    const tv = textMatchVariants(nameVariants("Samuel Gbafa"));
    expect(tv).toContain("samuel");
    expect(tv).toContain("gbafa");
  });
});

describe("speakerIsPerson", () => {
  const variants = nameVariants("Samuel Gbafa");
  test("matches full name label", () => {
    expect(speakerIsPerson("Samuel Gbafa", variants)).toBe(true);
  });
  test("matches a label that is a single name component", () => {
    expect(speakerIsPerson("Samuel", variants)).toBe(true);
    expect(speakerIsPerson("Gbafa", variants)).toBe(true);
  });
  test("strips a trailing (affiliation) before matching", () => {
    expect(speakerIsPerson("Samuel Gbafa (TinyCloud)", variants)).toBe(true);
  });
  test("does NOT match a different speaker who merely shares a prefix", () => {
    // "Samantha" must not be captured by the "sam"... there is no "sam" variant,
    // and "samantha" is not a component of "Samuel Gbafa".
    expect(speakerIsPerson("Samantha Power", variants)).toBe(false);
  });
  test("undefined label never matches", () => {
    expect(speakerIsPerson(undefined, variants)).toBe(false);
  });
});

describe("mentionInText", () => {
  const variants = nameVariants("Samuel Gbafa");
  test("finds a full-name (first-name) mention on word boundaries", () => {
    expect(mentionInText("Samuel, how are you?", variants)).toBe("samuel");
  });
  test("finds a last-name mention", () => {
    expect(mentionInText("I want Gbafa to write it down.", variants)).toBe("gbafa");
  });
  test("does not match inside a larger word", () => {
    // "samuel" should not hit inside "samuelson"; "sam" is not a variant at all.
    expect(mentionInText("the samuelson report", variants)).toBeNull();
    expect(mentionInText("they said the same thing", variants)).toBeNull();
  });
  test("prefers the full name when present", () => {
    expect(mentionInText("Samuel Gbafa led the call", variants)).toBe("samuel gbafa");
  });
});

describe("gatherPersonMentions", () => {
  test("collects spoken turns, mentions, participants, co-speakers", async () => {
    const transcripts = await loadTranscripts([dir]);
    const dossier = gatherPersonMentions(transcripts, "Samuel Gbafa");

    expect(dossier.totals.transcriptsWithEvidence).toBe(2);
    expect(dossier.totals.transcriptsSpoken).toBe(2);
    expect(dossier.totals.spokenTurns).toBe(2);
    // mentions: "Samuel, how..." + "Gbafa to write" (call one) and
    // "Samuel said last week" (call two) = 3
    expect(dossier.totals.mentionTurns).toBe(3);

    // Newest first.
    expect(dossier.transcripts[0]!.date).toBe("2026-03-08");
    expect(dossier.transcripts[1]!.date).toBe("2026-03-01");

    const beta = dossier.transcripts[0]!;
    expect(beta.inParticipants).toBe(true);
    expect(beta.spoke[0]!.text).toContain("sharing links can be revoked");
    // Tina mentions Samuel; Samantha is a co-speaker, not the person.
    expect(beta.coSpeakers).toContain("Tina (Flashbots)");
    expect(beta.coSpeakers).toContain("Samantha Power");
    expect(beta.mentions.some((m) => m.speaker === "Tina (Flashbots)")).toBe(true);
  });

  test("does not capture a same-prefix different person as the subject", async () => {
    const transcripts = await loadTranscripts([dir]);
    const dossier = gatherPersonMentions(transcripts, "Samuel Gbafa");
    // Samantha Power's turn must never be filed as Samuel's spoken evidence.
    for (const tm of dossier.transcripts) {
      for (const s of tm.spoke) {
        expect(s.speakerLabel.toLowerCase()).not.toContain("samantha");
      }
    }
  });

  test("returns empty dossier for an unknown name (no fabrication possible)", async () => {
    const transcripts = await loadTranscripts([dir]);
    const dossier = gatherPersonMentions(transcripts, "Nobody Here");
    expect(dossier.totals.transcriptsWithEvidence).toBe(0);
    expect(dossier.transcripts).toHaveLength(0);
  });

  test("participants-header appearance counts even with no spoken turns", () => {
    const headerOnly = parseTranscript(
      `# Header Only
**Date:** 2026-04-01
**Participants:** samuel@example.com, other@example.com

## Transcript

**Other Person:**
We talked about scoping.
`,
      "/tmp/header-only.md",
    );
    const dossier = gatherPersonMentions([headerOnly], "Samuel Gbafa");
    expect(dossier.totals.transcriptsWithEvidence).toBe(1);
    expect(dossier.transcripts[0]!.inParticipants).toBe(true);
    expect(dossier.transcripts[0]!.spoke).toHaveLength(0);
  });
});

describe("renderDossierMarkdown", () => {
  test("renders evidence and the grounding/no-conclusions warning", async () => {
    const transcripts = await loadTranscripts([dir]);
    const dossier = gatherPersonMentions(transcripts, "Samuel Gbafa");
    const md = renderDossierMarkdown(dossier);
    expect(md).toContain("# Person dossier survey: Samuel Gbafa");
    expect(md).toContain("RAW EVIDENCE ONLY");
    expect(md).toContain("low-confidence");
    expect(md).toContain("Spoke");
    expect(md).toContain("Mentioned by others");
  });

  test("empty dossier renders an explicit no-evidence section", () => {
    const md = renderDossierMarkdown({
      name: "Nobody",
      variants: ["nobody"],
      transcripts: [],
      totals: {
        transcriptsWithEvidence: 0,
        transcriptsSpoken: 0,
        spokenTurns: 0,
        mentionTurns: 0,
      },
    });
    expect(md).toContain("No evidence found");
    expect(md).toContain("rather than fabricate");
  });
});

function briefArtifact(overrides: Partial<Artifact> = {}): Record<string, unknown> {
  const body = [
    "## Who they are",
    "Samuel Gbafa states he is at TinyCloud.",
    "",
    "## What they've said",
    "> I'm at TinyCloud, and we treat delegation as the core primitive — every read is a capability, not an ACL. — Samuel Gbafa",
    "",
    "## Open threads",
    "Whether sharing links can be revoked without a server round trip.",
  ].join("\n");
  return {
    type: "person-brief",
    headline: "Brief: Samuel Gbafa",
    body,
    tags: ["person-brief"],
    source_transcripts: [pathOne, pathTwo],
    source_quotes: [
      {
        quote:
          "I'm at TinyCloud, and we treat delegation as the core primitive — every read is a capability, not an ACL.",
        speaker: "Samuel Gbafa",
        transcript: pathOne,
      },
      {
        quote:
          "the open thread is whether sharing links can be revoked without a server round trip.",
        speaker: "Samuel Gbafa",
        transcript: pathTwo,
      },
    ],
    quality: { critic_pass: true, quotes_verified: false, notes: "grounded; diarizer caveat noted" },
    generation_model: "test",
    ...overrides,
  };
}

describe("verifyArtifactQuotes", () => {
  test("passes for grounded verbatim quotes", async () => {
    const a = briefArtifact();
    const failures = await verifyArtifactQuotes(a.source_quotes as any);
    expect(failures).toHaveLength(0);
  });

  test("fails a fabricated/paraphrased quote", async () => {
    const a = briefArtifact({
      source_quotes: [
        { quote: "Samuel said he runs the whole company.", transcript: pathOne },
      ] as any,
    });
    const failures = await verifyArtifactQuotes(a.source_quotes as any);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toContain("not found");
  });
});

describe("saveBrief", () => {
  test("validates, defaults audience=internal + approval pending, writes brief.md", async () => {
    const outDir = join(dir, "artifacts");
    const a = briefArtifact();
    const saved = await saveBrief(a, { outDir });
    const slug = slugify("Brief: Samuel Gbafa");
    expect(saved.written.jsonPath).toBe(
      join(outDir, "person-brief", slug, "artifact.json"),
    );
    const written = JSON.parse(await readFile(saved.written.jsonPath, "utf8")) as Artifact;
    expect(written.type).toBe("person-brief");
    expect(written.audience).toBe("internal");
    expect(written.approval_status).toBe("pending");
    const briefMd = await readFile(join(outDir, "person-brief", slug, "brief.md"), "utf8");
    expect(briefMd).toContain("Who they are");
  });

  test("rejects an empty source_quotes list (fabrication guard)", async () => {
    const a = briefArtifact({ source_quotes: [] });
    await expect(saveBrief(a, { outDir: join(dir, "artifacts") })).rejects.toThrow(
      /source_quotes/,
    );
  });

  test("rejects a missing body", async () => {
    const a = briefArtifact();
    delete (a as Record<string, unknown>).body;
    await expect(saveBrief(a, { outDir: join(dir, "artifacts") })).rejects.toThrow(
      /non-empty markdown body/,
    );
  });

  test("rejects the wrong type", async () => {
    const a = briefArtifact({ type: "article" });
    await expect(saveBrief(a, { outDir: join(dir, "artifacts") })).rejects.toThrow(
      /only saves type/,
    );
  });
});
