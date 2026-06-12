// attribution.test.ts — the deterministic identity/role/affiliation grounding
// guard (the analog of verify-quotes for WHO a person is, not WHAT they said).
//
// Required cases (per the phase-1 spec):
//   - "<Name> — Org-not-in-source"  → grounded:false, missing org term listed.
//   - a claim whose role/org IS in source → grounded:true.
//   - THE INCIDENT: Cush + "Shape Rotator cohort founder" vs a source with
//     neither "Shape Rotator" nor "cohort" → flagged ungrounded.
//
// All fixtures are synthetic — never real meeting content from the vault.

import { describe, expect, test } from "bun:test";
import {
  artifactProse,
  checkAttribution,
  type AttributionClaim,
} from "../skills/_shared/lib/attribution.ts";

function find(claims: AttributionClaim[], person: string): AttributionClaim | undefined {
  return claims.find((c) => c.person.toLowerCase() === person.toLowerCase());
}

describe("checkAttribution — ungrounded org/affiliation", () => {
  test("'<Name> — Org-not-in-source' is grounded:false with the missing org term", () => {
    const prose = "Cush — a Stripe partner — laid out the math.";
    const source = "Cush: take your salary and divide it by 200, multiply by 15.";
    const claims = checkAttribution(prose, source);
    const c = find(claims, "Cush");
    expect(c).toBeDefined();
    expect(c!.grounded).toBe(false);
    expect(c!.missingTerms).toContain("stripe");
    // "partner" is a role noun and also absent → flagged too.
    expect(c!.missingTerms).toContain("partner");
  });

  test("'<Name> from <Place>' where the place is absent is flagged", () => {
    const prose = "Tina from Berlin walked through the integration.";
    const source = "Tina: the integration took two weeks to wire up.";
    const claims = checkAttribution(prose, source);
    const c = find(claims, "Tina");
    expect(c).toBeDefined();
    expect(c!.grounded).toBe(false);
    expect(c!.missingTerms).toContain("berlin");
  });

  test("possessive '<Org>'s <Name>' flags an org absent from source", () => {
    const prose = "Acme's Dana shipped the prototype overnight.";
    const source = "Dana: I shipped the prototype overnight, it barely compiles.";
    const claims = checkAttribution(prose, source);
    const c = find(claims, "Dana");
    expect(c).toBeDefined();
    expect(c!.grounded).toBe(false);
    expect(c!.missingTerms).toContain("acme");
  });
});

describe("checkAttribution — grounded claims pass", () => {
  test("a role + org that BOTH appear in source → grounded:true, no missing terms", () => {
    const prose = "Cush, an Odisea founder, ran the experiment first.";
    const source =
      "Cush: I'm the founder at Odisea and I ran the whole experiment myself first.";
    const claims = checkAttribution(prose, source);
    const c = find(claims, "Cush");
    expect(c).toBeDefined();
    expect(c!.grounded).toBe(true);
    expect(c!.missingTerms).toEqual([]);
  });

  test("'<Name> of <Org>' where the org is in source → grounded:true", () => {
    const prose = "Sam of Flashbots pushed back on the framing.";
    const source = "Sam: at Flashbots we'd never coordinate that way.";
    const claims = checkAttribution(prose, source);
    const c = find(claims, "Sam");
    expect(c).toBeDefined();
    expect(c!.grounded).toBe(true);
  });

  test("a relative-clause role grounded by the source verb/noun passes", () => {
    const prose = "Dana who founded the company explained the cap table.";
    const source = "Dana: when I founded the company the cap table was a mess.";
    const claims = checkAttribution(prose, source);
    const c = find(claims, "Dana");
    expect(c).toBeDefined();
    expect(c!.grounded).toBe(true);
  });
});

describe("checkAttribution — THE INCIDENT (ground truth)", () => {
  // The fabricated framing from the quarantined card, against a source that
  // (like the real transcript) contains NEITHER "Shape Rotator" NOR "cohort".
  const FABRICATED_PROSE =
    "On a fundraising-season call, Odisea's Cush — a Shape Rotator cohort founder " +
    "running his company from Guatemala — laid out the heuristic.";
  // Synthetic stand-in for the real source: Cush, Odisea, Guatemala present;
  // Shape Rotator + cohort absent — mirroring the actual grep result.
  const SOURCE =
    "Cush: I run Odisea from Guatemala. Take your salary, divide by 200, multiply by 15.";

  test("'Shape Rotator cohort founder' is flagged ungrounded", () => {
    const claims = checkAttribution(FABRICATED_PROSE, SOURCE);
    const c = find(claims, "Cush");
    expect(c).toBeDefined();
    expect(c!.grounded).toBe(false);
    // The fabricated terms must be named as missing.
    expect(c!.missingTerms).toContain("shape rotator");
    expect(c!.missingTerms).toContain("cohort");
  });

  test("'Guatemala' (which IS in source) does NOT appear as missing", () => {
    const claims = checkAttribution(FABRICATED_PROSE, SOURCE);
    const c = find(claims, "Cush");
    expect(c!.missingTerms).not.toContain("guatemala");
  });

  test("'Odisea' possessive affiliation IS grounded (it's in the source)", () => {
    const claims = checkAttribution(FABRICATED_PROSE, SOURCE);
    const odisea = claims.find((x) => x.descriptor.toLowerCase() === "odisea");
    expect(odisea).toBeDefined();
    expect(odisea!.grounded).toBe(true);
  });
});

describe("checkAttribution — no false claims on benign prose", () => {
  test("a generic adjective descriptor is NOT treated as a claim", () => {
    const prose = "Hunter — the load-bearing skeptic — pushed back hard.";
    const source = "Hunter: I think we should stress-test that before we buy it.";
    const claims = checkAttribution(prose, source);
    // "the load-bearing skeptic" has no role noun and no proper-noun org → no claim.
    expect(find(claims, "Hunter")).toBeUndefined();
  });

  test("transcript-grounded action framing produces no ungrounded claim", () => {
    // The RIGHT way per the SKILL rule: refer to the person by grounded action.
    const prose = "Cush, a founder on a call with TinyCloud, ran the experiment.";
    const source =
      "Cush: as a founder I ran this experiment. TinyCloud, you should try it.";
    const claims = checkAttribution(prose, source);
    const c = find(claims, "Cush");
    expect(c).toBeDefined();
    expect(c!.grounded).toBe(true);
  });
});

describe("artifactProse", () => {
  test("concatenates headline/body/quote/attribution, skips source_quotes", () => {
    const prose = artifactProse({
      headline: "H",
      body: "B",
      quote: "Q",
      attribution: "A",
    });
    expect(prose).toBe("H\n\nB\n\nQ\n\nA");
  });

  test("omits missing/empty fields", () => {
    expect(artifactProse({ headline: "only" })).toBe("only");
    expect(artifactProse({ headline: "h", body: "  " })).toBe("h");
  });
});
