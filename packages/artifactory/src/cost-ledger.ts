// Cost ledger seam. Matches the `cost_ledger` table in
// skills/_shared/lib/feed-v1-schema.ts. Credentials/metering (TC-73) will
// swap the in-memory backing for a TinyCloud-backed store.

import type { SpendClass } from "../../../skills/_shared/lib/feed-v1.ts";

export type CostLedgerEntry = {
  ledgerId: string;
  userId: string;
  budgetId: string;
  windowStart: string;
  spendClass: SpendClass;
  amount: number;
  currency: string;
  runId: string;
  recordedAt: string;
};

export type CostTotalsQuery = {
  runId?: string;
  budgetId?: string;
  userId?: string;
};

export type CostTotals = {
  amount: number;
  currency: string;
  entries: number;
};

export type CostLedger = {
  record(entry: CostLedgerEntry): Promise<void>;
  totals(query: CostTotalsQuery): Promise<CostTotals[]>;
  list(query: CostTotalsQuery): Promise<CostLedgerEntry[]>;
};

function matches(entry: CostLedgerEntry, query: CostTotalsQuery): boolean {
  if (query.runId && entry.runId !== query.runId) return false;
  if (query.budgetId && entry.budgetId !== query.budgetId) return false;
  if (query.userId && entry.userId !== query.userId) return false;
  return true;
}

export function createInMemoryCostLedger(): CostLedger {
  const entries: CostLedgerEntry[] = [];
  return {
    async record(entry) {
      entries.push({ ...entry });
    },
    async totals(query) {
      const filtered = entries.filter((entry) => matches(entry, query));
      const byCurrency = new Map<string, CostTotals>();
      for (const entry of filtered) {
        const current = byCurrency.get(entry.currency) ?? {
          amount: 0,
          currency: entry.currency,
          entries: 0,
        };
        current.amount += entry.amount;
        current.entries += 1;
        byCurrency.set(entry.currency, current);
      }
      return Array.from(byCurrency.values());
    },
    async list(query) {
      return entries.filter((entry) => matches(entry, query)).map((entry) => ({ ...entry }));
    },
  };
}
