// quotes.ts — verbatim quote verification shared by the artifact-writing
// skills (write-article, write-digest). Proves the quoted TEXT exists in the
// referenced transcript (whitespace-insensitive); it cannot prove the speaker
// attribution — diarization labels can be wrong.

import { readFile } from "node:fs/promises";
import { parseTranscript, verifyQuote, type Transcript } from "./transcript.ts";
import type { SourceQuote } from "./artifact.ts";

export interface QuoteFailure {
  index: number;
  quote: string;
  transcript: string;
  reason: string;
}

/** Verify every source_quote against its referenced transcript file. */
export async function verifyArtifactQuotes(
  quotes: SourceQuote[],
): Promise<QuoteFailure[]> {
  const cache = new Map<string, Transcript>();
  const failures: QuoteFailure[] = [];
  for (const [index, sq] of quotes.entries()) {
    try {
      let transcript = cache.get(sq.transcript);
      if (!transcript) {
        transcript = parseTranscript(await readFile(sq.transcript, "utf8"), sq.transcript);
        cache.set(sq.transcript, transcript);
      }
      if (!verifyQuote(transcript, sq.quote)) {
        failures.push({
          index,
          quote: sq.quote,
          transcript: sq.transcript,
          reason: "quote not found verbatim in transcript",
        });
      }
    } catch (e) {
      failures.push({
        index,
        quote: sq.quote,
        transcript: sq.transcript,
        reason: `could not read transcript: ${(e as Error).message}`,
      });
    }
  }
  return failures;
}
