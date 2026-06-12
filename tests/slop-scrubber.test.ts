import { describe, expect, test } from "bun:test";
import {
  SLOP_GUIDANCE,
  scrubSlop,
  type SlopTellType,
} from "../skills/_shared/lib/slop-scrubber.ts";

function types(text: string): SlopTellType[] {
  return scrubSlop(text).tells.map((t) => t.type);
}

describe("scrubSlop tell detection", () => {
  test("negative parallelism", () => {
    expect(types("It's not just a tool, it's a movement.")).toContain(
      "negative-parallelism",
    );
    expect(types("We built not just a feature but a platform.")).toContain(
      "negative-parallelism",
    );
    expect(types("This isn't about speed, it's about trust.")).toContain(
      "negative-parallelism",
    );
  });

  test("hype vocab", () => {
    expect(types("This is a total game-changer.")).toContain("hype-vocab");
    expect(types("We will 10x our revenue and unlock growth.")).toContain(
      "hype-vocab",
    );
    expect(types("A seamless, world-class experience.")).toContain("hype-vocab");
  });

  test("em-dash density", () => {
    const dashy =
      "We shipped it — fast. It worked — mostly. Then we iterated — again.";
    expect(types(dashy)).toContain("em-dash-density");
  });

  test("tricolon rhythm (only when repeated)", () => {
    const repeated =
      "We test, we learn, and we ship. We hire, we train, and we trust.";
    expect(types(repeated)).toContain("tricolon");
    // A single tricolon is fine human prose — not flagged.
    expect(types("We test, we learn, and we ship every week.")).not.toContain(
      "tricolon",
    );
  });

  test("hot-take prefix", () => {
    expect(types("Unpopular opinion: most standups are theater.")).toContain(
      "hot-take-prefix",
    );
    expect(types("Hot take: dashboards are mostly decoration.")).toContain(
      "hot-take-prefix",
    );
  });

  test("clean uniform listicle", () => {
    const list = [
      "Here are the lessons:",
      "- Ship small and ship often today",
      "- Talk to your customers every single",
      "- Measure the things that matter most",
      "- Cut the features nobody is using",
    ].join("\n");
    expect(types(list)).toContain("clean-listicle");
  });
});

describe("scrubSlop scoring", () => {
  test("clean human-style prose scores near zero", () => {
    const human =
      "We lost a renewal last week. The buyer went quiet for a month, then " +
      "came back asking for a discount we couldn't give. I learned to ask " +
      "about their budget cycle before quoting, not after.";
    const report = scrubSlop(human);
    expect(report.tells.length).toBe(0);
    expect(report.score).toBe(0);
  });

  test("slop-saturated text scores high", () => {
    const slop =
      "Unpopular opinion: this is a game-changer. It's not just a product — " +
      "it's a movement. We will 10x growth, unlock value, and supercharge " +
      "the future of work — seamlessly.";
    const report = scrubSlop(slop);
    expect(report.tells.length).toBeGreaterThan(2);
    expect(report.score).toBeGreaterThan(scrubSlop("A plain calm sentence.").score);
  });
});

describe("SLOP_GUIDANCE", () => {
  test("names the banned constructions for the SKILL.mds", () => {
    expect(SLOP_GUIDANCE).toContain("game-changer");
    expect(SLOP_GUIDANCE).toContain("negative parallelism");
    expect(SLOP_GUIDANCE).toContain("scrubSlop");
  });
});
