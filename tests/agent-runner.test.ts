import { describe, expect, test } from "bun:test";
import { classifyListenReadResult } from "../harness/agent/src/listen-read-outcome.ts";

describe("agent runner listen-read classification", () => {
  test("explicit no-transcripts output is a valid empty Listen run", () => {
    expect(
      classifyListenReadResult({
        code: 1,
        stdout: "",
        stderr:
          "No non-empty transcripts found. Nothing written. (Check the conversation count / space.)",
      }),
    ).toEqual({
      kind: "empty",
      message: "No non-empty transcripts found.",
    });
  });

  test("AUTH_UNAUTHORIZED is surfaced as an error, not an empty run", () => {
    const result = classifyListenReadResult({
      code: 1,
      stdout: "",
      stderr: JSON.stringify({
        error: {
          code: "AUTH_UNAUTHORIZED",
          message:
            "SQL query failed: 401 - Unauthorized Action: tinycloud.sql/read",
        },
      }),
    });

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("AUTH_UNAUTHORIZED");
      expect(result.message).toContain("Unauthorized Action");
    }
  });

  test("unexpected zero-output success is ok at process level", () => {
    expect(classifyListenReadResult({ code: 0, stdout: "", stderr: "" })).toEqual({
      kind: "ok",
    });
  });
});
