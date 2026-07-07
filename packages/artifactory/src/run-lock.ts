// Run-lock seam. Matches the `run_lock` table declared in
// skills/_shared/lib/feed-v1-schema.ts. A TinyCloud-backed store can drop in
// the same interface without changing callers.

export type RunLockRow = {
  lockId: string;
  scope: string;
  ownerId: string;
  runId: string;
  leaseExpiresAt: string;
  fencingToken: string;
};

export type RunLockAcquire = {
  scope: string;
  ownerId: string;
  runId: string;
  leaseMs: number;
  now: Date;
};

export type RunLockAcquireResult =
  | { ok: true; row: RunLockRow }
  | { ok: false; heldBy: RunLockRow };

export type RunLockStore = {
  acquire(request: RunLockAcquire): Promise<RunLockAcquireResult>;
  release(lockId: string, ownerId: string): Promise<void>;
  peek(scope: string): Promise<RunLockRow | null>;
};

function nextFencingToken(previous: RunLockRow | null): string {
  if (!previous) return "1";
  const parsed = Number.parseInt(previous.fencingToken, 10);
  return Number.isFinite(parsed) ? String(parsed + 1) : "1";
}

export function createInMemoryRunLockStore(): RunLockStore {
  const byScope = new Map<string, RunLockRow>();
  const highestFencing = new Map<string, string>();

  return {
    async acquire(request) {
      const held = byScope.get(request.scope) ?? null;
      const nowIso = request.now.toISOString();
      if (held && held.leaseExpiresAt > nowIso) {
        return { ok: false, heldBy: held };
      }
      const previousForFencing = held ?? (highestFencing.get(request.scope)
        ? ({ fencingToken: highestFencing.get(request.scope)! } as RunLockRow)
        : null);
      const row: RunLockRow = {
        lockId: `${request.scope}:${request.runId}`,
        scope: request.scope,
        ownerId: request.ownerId,
        runId: request.runId,
        leaseExpiresAt: new Date(request.now.getTime() + request.leaseMs).toISOString(),
        fencingToken: nextFencingToken(previousForFencing),
      };
      byScope.set(request.scope, row);
      highestFencing.set(request.scope, row.fencingToken);
      return { ok: true, row };
    },
    async release(lockId, ownerId) {
      for (const [scope, row] of byScope) {
        if (row.lockId === lockId && row.ownerId === ownerId) {
          byScope.delete(scope);
          return;
        }
      }
    },
    async peek(scope) {
      return byScope.get(scope) ?? null;
    },
  };
}
