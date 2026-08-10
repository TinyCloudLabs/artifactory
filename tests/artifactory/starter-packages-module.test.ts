import { describe, expect, test } from "bun:test";
import { compileSkillPackage } from "../../packages/artifactory/src/package-compiler.ts";
import {
  REVIEWED_STARTER_PACKAGES,
  starterPackageById,
} from "../../skills/_shared/lib/starter-packages.ts";

// The module carries the compiled package identity verbatim so Feed Host can
// admit the reviewed pack without a compiler/filesystem dependency. If a
// starter is edited (new digest/version), this test fails until the module is
// regenerated — the module must never drift from the pinned reviewed bundle.
describe("reviewed starter package module", () => {
  test("matches the compiled starter packages exactly (identity + disclosure + trigger)", async () => {
    expect(REVIEWED_STARTER_PACKAGES).toHaveLength(6);
    for (const declared of REVIEWED_STARTER_PACKAGES) {
      const compiled = await compileSkillPackage(`skills/${declared.packageId}`);
      const { presentation, ...identity } = declared;
      expect(identity).toEqual(compiled.package);
      expect(declared.trigger).toEqual(compiled.workflowPack.trigger);
      expect(presentation).toBeDefined();
    }
  });

  test("presentation is complete, human-readable, and free of authority jargon", () => {
    const forbidden = /sha256|did:|cron|tinycloud\.(kv|sql)|capability|delegation|manifest|digest/i;
    for (const pkg of REVIEWED_STARTER_PACKAGES) {
      const presentation = pkg.presentation!;
      expect(presentation.schemaVersion).toBe("feed.workflow_presentation.v1");
      for (const [field, value] of Object.entries(presentation)) {
        if (field === "exampleTitles") continue;
        expect(typeof value).toBe("string");
        expect((value as string).trim().length).toBeGreaterThan(0);
        expect(value as string).not.toMatch(forbidden);
      }
      expect(presentation.exampleTitles.length).toBeGreaterThan(0);
      for (const title of presentation.exampleTitles) {
        expect(title).not.toMatch(forbidden);
      }
    }
  });

  test("starterPackageById resolves each starter and rejects unknown ids", () => {
    expect(starterPackageById("feed-daily-brief")?.displayName).toBe("Daily Brief");
    expect(starterPackageById("not-a-package")).toBeUndefined();
  });
});
