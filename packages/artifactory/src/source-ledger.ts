// Source ref ledger seam. Matches the `source_ref` table in
// skills/_shared/lib/feed-v1-schema.ts.

import type { TranscriptSourceRef } from "../../../skills/_shared/lib/feed-v1.ts";

export type SourceLedgerRecord = {
  runId: string;
  ref: TranscriptSourceRef;
};

export type SourceLedger = {
  observe(record: SourceLedgerRecord): Promise<void>;
  list(runId: string): Promise<TranscriptSourceRef[]>;
};

export function createInMemorySourceLedger(): SourceLedger {
  const byRun = new Map<string, TranscriptSourceRef[]>();
  return {
    async observe({ runId, ref }) {
      const current = byRun.get(runId) ?? [];
      current.push({ ...ref });
      byRun.set(runId, current);
    },
    async list(runId) {
      return (byRun.get(runId) ?? []).map((ref) => ({ ...ref }));
    },
  };
}
