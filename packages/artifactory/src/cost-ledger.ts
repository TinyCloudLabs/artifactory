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

export type CostLedgerReserveOptions = {
  limit?: number;
};

export type CostLedgerReserveResult =
  | { ok: true }
  | { ok: false; spent: number };

export type CostLedger = {
  // Atomic check-and-append: if the caller's `limit` is defined, `entry.amount`
  // is admitted only when `sum(existing amount for userId+budgetId+currency)
  // + entry.amount <= limit`. When admitted, the entry becomes visible to
  // `totals`/`list` immediately — that reservation IS the committed spend for
  // M0. Concurrent callers cannot both pass with an over-limit sum: the
  // in-memory implementation runs the check+push in a single synchronous JS
  // turn; the TinyCloud-SQL backing this seam later must implement this as a
  // single `INSERT ... SELECT ... WHERE (SELECT COALESCE(SUM(amount),0) FROM
  // cost_ledger WHERE user_id=? AND budget_id=? AND currency=?) + ? <= ?`
  // statement so the transaction resolves atomically. The TinyCloud SQL
  // authorizer rejects `CREATE INDEX`, so no index may be required for
  // correctness (a scan of the tenant partition is sufficient).
  reserve(entry: CostLedgerEntry, options?: CostLedgerReserveOptions): Promise<CostLedgerReserveResult>;
  // Remove a previously reserved entry. Used when a run is blocked after the
  // reservation (e.g. package run-lock conflict) or throws before completing.
  cancel(ledgerId: string, userId: string): Promise<void>;
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
    async reserve(entry, options) {
      // Single synchronous turn: no await between the sum and the push, so
      // concurrent JS callers cannot interleave.
      const limit = options?.limit;
      if (limit !== undefined) {
        let spent = 0;
        for (const existing of entries) {
          if (
            existing.userId === entry.userId &&
            existing.budgetId === entry.budgetId &&
            existing.currency === entry.currency
          ) {
            spent += existing.amount;
          }
        }
        if (spent + entry.amount > limit) {
          return { ok: false, spent };
        }
      }
      entries.push({ ...entry });
      return { ok: true };
    },
    async cancel(ledgerId, userId) {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const existing = entries[i];
        if (!existing) continue;
        if (existing.ledgerId === ledgerId && existing.userId === userId) {
          entries.splice(i, 1);
          return;
        }
      }
    },
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
