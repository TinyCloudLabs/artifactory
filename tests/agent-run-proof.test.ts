import { describe, expect, test } from "bun:test";
import { verifyAgentRunProof } from "../harness/agent/src/run-proof.ts";

describe("agent run target proof", () => {
  test("auto target is informational and passes", () => {
    expect(
      verifyAgentRunProof({
        published: [],
        held: [],
        media: { heroImages: 0, audio: 0, video: 0 },
      }),
    ).toEqual({
      ok: true,
      checks: [{ name: "target: auto", ok: true, detail: "no explicit artifact target requested" }],
    });
  });

  test("proves video target only when a published clip has video", () => {
    const proof = verifyAgentRunProof({
      targetArtifactType: "clip",
      published: [{ type: "clip", slug: "with-video", media: { heroImage: true, audio: false, video: true } }],
      held: [],
      media: { heroImages: 1, audio: 0, video: 1 },
    });

    expect(proof.ok).toBe(true);
    expect(proof.checks.map((check) => check.name)).toContain("target: clip has video");

    const missingVideo = verifyAgentRunProof({
      targetArtifactType: "clip",
      published: [{ type: "clip", slug: "no-video", media: { heroImage: true, audio: false, video: false } }],
      held: [],
      media: { heroImages: 1, audio: 0, video: 0 },
    });

    expect(missingVideo.ok).toBe(false);
    expect(missingVideo.checks.find((check) => check.name === "target: clip has video")).toMatchObject({
      ok: false,
    });
  });

  test("proves podcast and article media targets from published media flags", () => {
    expect(
      verifyAgentRunProof({
        targetArtifactType: "podcast",
        published: [{ type: "podcast", slug: "episode", media: { heroImage: true, audio: true, video: false } }],
        held: [],
        media: { heroImages: 1, audio: 1, video: 0 },
      }).ok,
    ).toBe(true);

    expect(
      verifyAgentRunProof({
        targetArtifactType: "article",
        published: [{ type: "article", slug: "story", media: { heroImage: true, audio: false, video: false } }],
        held: [],
        media: { heroImages: 1, audio: 0, video: 0 },
      }).ok,
    ).toBe(true);
  });

  test("reports held artifacts when a requested target did not publish", () => {
    const proof = verifyAgentRunProof({
      targetArtifactType: "podcast",
      published: [],
      held: [{ type: "podcast", slug: "episode", reason: "audio required for podcast but missing file" }],
      media: { heroImages: 0, audio: 0, video: 0 },
    });

    expect(proof.ok).toBe(false);
    expect(proof.checks[0]).toMatchObject({
      name: "target: published podcast",
      ok: false,
    });
    expect(proof.checks[0]?.detail).toContain("audio required");
  });
});
