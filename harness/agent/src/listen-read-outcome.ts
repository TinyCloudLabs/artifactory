export interface SpawnOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export type ListenReadOutcome =
  | { kind: "ok" }
  | { kind: "empty"; message: string }
  | { kind: "error"; code?: string; message: string };

function tail(text: string, max = 1200): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(-max) : trimmed;
}

function combinedOutput(result: SpawnOutput): string {
  return [result.stderr, result.stdout].filter((s) => s.trim().length > 0).join("\n");
}

function extractTcErrorCode(output: string): string | undefined {
  const bracket = output.match(/tc error \[([A-Z0-9_]+)\]/);
  if (bracket) return bracket[1];
  const jsonCode = output.match(/"code"\s*:\s*"([^"]+)"/);
  return jsonCode?.[1];
}

/** Classify the listen-read subprocess result without looking at the corpus dir.
 * Empty Listen is a valid terminal state, but only when the skill explicitly says
 * no non-empty transcripts were found. Every other nonzero exit is an operator-
 * actionable failure and must surface in the run status/UI. */
export function classifyListenReadResult(result: SpawnOutput): ListenReadOutcome {
  if (result.code === 0) return { kind: "ok" };
  const output = combinedOutput(result);
  if (/No non-empty transcripts found/i.test(output)) {
    return { kind: "empty", message: "No non-empty transcripts found." };
  }
  const code = extractTcErrorCode(output);
  const message = tail(output) || `listen-read exited ${result.code} without output`;
  return { kind: "error", ...(code ? { code } : {}), message };
}
