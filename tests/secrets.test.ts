import { afterEach, describe, expect, test } from "bun:test";
import { getSecret } from "../skills/_shared/lib/secrets.ts";

const GEMINI_ENVS = ["GOOGLE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
const saved: Record<string, string | undefined> = {};
for (const k of [...GEMINI_ENVS, "DISTILLERY_TEST_SECRET"]) {
  saved[k] = process.env[k];
}

function clearAll() {
  for (const k of Object.keys(saved)) delete process.env[k];
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// v1 resolves from env vars only (vault integration deferred — see SPEC.md,
// "Future: TinyCloud secrets vault integration").

describe("getSecret — env resolver chain", () => {
  test("GEMINI_API_KEY honors pulse-radio precedence (GOOGLE_AI_API_KEY first)", async () => {
    clearAll();
    process.env.GOOGLE_AI_API_KEY = "from-google-ai";
    process.env.GEMINI_API_KEY = "from-gemini";
    process.env.GOOGLE_API_KEY = "from-google";
    expect(await getSecret("GEMINI_API_KEY")).toBe("from-google-ai");
  });

  test("falls through aliases in order", async () => {
    clearAll();
    process.env.GOOGLE_API_KEY = "last-resort";
    expect(await getSecret("GEMINI_API_KEY")).toBe("last-resort");
  });

  test("trims whitespace and skips empty values", async () => {
    clearAll();
    process.env.GOOGLE_AI_API_KEY = "   ";
    process.env.GEMINI_API_KEY = "  padded-key  ";
    expect(await getSecret("GEMINI_API_KEY")).toBe("padded-key");
  });

  test("non-aliased secrets read their own env name", async () => {
    clearAll();
    process.env.DISTILLERY_TEST_SECRET = "hello";
    expect(await getSecret("DISTILLERY_TEST_SECRET")).toBe("hello");
  });

  test("error lists every attempted env var in precedence order", async () => {
    clearAll();
    expect(getSecret("GEMINI_API_KEY")).rejects.toThrow(
      /env: GOOGLE_AI_API_KEY[\s\S]*env: GEMINI_API_KEY[\s\S]*env: GOOGLE_API_KEY/,
    );
  });

  test("error points at the Secret Manager as the canonical key home", async () => {
    clearAll();
    try {
      await getSecret("DISTILLERY_TEST_SECRET");
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("env: DISTILLERY_TEST_SECRET");
      expect(msg).toContain("secrets.tinycloud.xyz");
    }
  });
});
