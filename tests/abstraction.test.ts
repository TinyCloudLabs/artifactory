import { describe, expect, test } from "bun:test";
import {
  ABSTRACTION_GUIDANCE,
  ABSTRACTION_LADDER,
  SAFETY_TEST,
  safetyFlags,
} from "../skills/_shared/lib/abstraction.ts";

// A snippet of a private meeting transcript — real entities live here.
const SOURCE = `
Ada Lovelace: Acme Corp wants to close the $250,000 expansion by end of July.
Charles Babbage: Our churn on the SparqGaming account is up 18% this quarter.
Ada Lovelace: Reach me at ada@acme.io, the deal page is acme.io/deals/expansion.
`;

describe("ABSTRACTION_LADDER", () => {
  test("has five ordered rungs ending in keep-one-true-detail", () => {
    expect(ABSTRACTION_LADDER.length).toBe(5);
    expect(ABSTRACTION_LADDER.map((r) => r.level)).toEqual([1, 2, 3, 4, 5]);
    expect(ABSTRACTION_LADDER[0]!.name).toBe("specific-incident");
    expect(ABSTRACTION_LADDER[4]!.name).toBe("keep-one-true-detail");
  });
});

describe("SAFETY_TEST", () => {
  test("is the four-question checklist", () => {
    expect(SAFETY_TEST.length).toBe(4);
    const ids = SAFETY_TEST.map((q) => q.id);
    expect(ids).toContain("identifiable-entity");
    expect(ids).toContain("participant-exposed");
    expect(ids).toContain("unannounced-strategy");
    expect(ids).toContain("insight-survives");
  });
});

describe("safetyFlags", () => {
  test("flags real source org/person/$figure carried into a draft", () => {
    const draft =
      "We watched Acme Corp drag a $250,000 deal to the wire — Ada Lovelace " +
      "wanted it closed by July.";
    const { flagged, fromSource } = safetyFlags(draft, SOURCE);

    const terms = flagged.map((f) => f.term.toLowerCase());
    expect(terms.some((t) => t.includes("acme"))).toBe(true);
    expect(terms.some((t) => t.includes("ada"))).toBe(true);
    expect(flagged.some((f) => f.kind === "money")).toBe(true);

    // The real entities are marked as coming from the source — highest risk.
    const sourceTerms = fromSource.map((f) => f.term.toLowerCase());
    expect(sourceTerms.some((t) => t.includes("acme"))).toBe(true);
    expect(fromSource.some((f) => f.kind === "money")).toBe(true);
  });

  test("flags emails and percentages", () => {
    const draft = "Email ada@acme.io about the 18% churn.";
    const { flagged } = safetyFlags(draft, SOURCE);
    expect(flagged.some((f) => f.kind === "email")).toBe(true);
    expect(flagged.some((f) => f.kind === "percent")).toBe(true);
  });

  test("a fully-abstracted draft produces no flags", () => {
    const clean =
      "A mid-market customer kept stalling an expansion deal until the very " +
      "last week of the quarter. the lesson: when a renewal slips to the wire, " +
      "the buyer is usually managing internal budget politics, not your price.";
    const { flagged } = safetyFlags(clean, SOURCE);
    expect(flagged).toEqual([]);
  });

  test("a draft with an invented illustrative name is flagged but not inSource", () => {
    const draft = "Picture a company called Globex stalling a deal.";
    const { flagged, fromSource } = safetyFlags(draft, SOURCE);
    expect(flagged.some((f) => f.term.toLowerCase().includes("globex"))).toBe(true);
    // Globex is not in the source transcript, so it's lower-risk.
    expect(fromSource.some((f) => f.term.toLowerCase().includes("globex"))).toBe(false);
  });

  test("tolerates a missing source (every flag inSource:false)", () => {
    const { flagged, fromSource } = safetyFlags("Acme Corp raised $5M.");
    expect(flagged.length).toBeGreaterThan(0);
    expect(fromSource).toEqual([]);
  });
});

describe("ABSTRACTION_GUIDANCE", () => {
  test("embeds the ladder and the safety test for the SKILL.mds", () => {
    expect(ABSTRACTION_GUIDANCE).toContain("specific-incident");
    expect(ABSTRACTION_GUIDANCE).toContain("keep-one-true-detail");
    expect(ABSTRACTION_GUIDANCE).toContain("human-approval gate");
  });
});
