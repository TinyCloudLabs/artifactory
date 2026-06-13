// Format-exploration slot tests — the deterministic anti-monoculture rule.
// explorationPick decides WHEN the slot fires (every Nth run) and WHICH
// format it nudges (least-recently-produced, never-produced first); the
// brief renders the nudge as an explicit section the generation agent reads.

import { describe, expect, test } from "bun:test";
import {
  explorationPick,
  INTERNAL_FEED_FORMATS,
  renderBrief,
  type BriefInput,
} from "../harness/feed-run/scripts/feed-run-lib.ts";

const ALL_RECENT = {
  "insight-card": "2026-06-12T10:00:00.000Z",
  article: "2026-06-11T10:00:00.000Z",
  podcast: "2026-06-10T10:00:00.000Z",
  digest: "2026-06-09T10:00:00.000Z",
} as const;

describe("explorationPick", () => {
  test("fires only on every Nth run", () => {
    expect(explorationPick(1, 3, ALL_RECENT)).toBeNull();
    expect(explorationPick(2, 3, ALL_RECENT)).toBeNull();
    expect(explorationPick(3, 3, ALL_RECENT)).not.toBeNull();
    expect(explorationPick(4, 3, ALL_RECENT)).toBeNull();
    expect(explorationPick(6, 3, ALL_RECENT)).not.toBeNull();
  });

  test("everyN <= 0 disables the slot", () => {
    expect(explorationPick(3, 0, ALL_RECENT)).toBeNull();
    expect(explorationPick(3, -1, ALL_RECENT)).toBeNull();
  });

  test("picks the least-recently-produced format", () => {
    expect(explorationPick(3, 3, ALL_RECENT)).toBe("digest");
    expect(
      explorationPick(3, 3, { ...ALL_RECENT, digest: "2026-06-13T00:00:00.000Z" }),
    ).toBe("podcast");
  });

  test("a never-produced format outranks any produced one", () => {
    expect(explorationPick(3, 3, { ...ALL_RECENT, podcast: null })).toBe("podcast");
    // absent key == never produced
    const { digest: _digest, ...withoutDigest } = ALL_RECENT;
    expect(explorationPick(3, 3, withoutDigest)).toBe("digest");
  });

  test("unparseable dates count as never-produced; ties resolve in declared order", () => {
    expect(
      explorationPick(3, 3, { ...ALL_RECENT, article: "not-a-date" }),
    ).toBe("article");
    // everything never-produced → first declared format wins
    expect(explorationPick(3, 3, {})).toBe(INTERNAL_FEED_FORMATS[0]);
  });
});

describe("renderBrief exploration section", () => {
  const base: BriefInput = {
    runId: "2026-06-12T00:00:00.000Z",
    mode: "daily",
    since: "2026-06-05",
    cap: 3,
    recency: [],
    deepDiveWrapped: false,
    preferences: "- human line",
    distillDegraded: false,
    baselineSummary: "0 prior artifacts",
  };

  test("renders the reserved format when set", () => {
    const brief = renderBrief({ ...base, explorationFormat: "podcast" });
    expect(brief).toContain("EXPLORATION SLOT");
    expect(brief).toContain("**podcast**");
    // the agent may still decline — the section must say so
    expect(brief).toContain("valid run");
  });

  test("omits the section when the slot doesn't fire", () => {
    expect(renderBrief(base)).not.toContain("EXPLORATION SLOT");
  });
});
