import { describe, expect, test } from "bun:test";
import { createInMemoryRunLockStore } from "../../packages/artifactory/src/run-lock.ts";

describe("run-lock", () => {
  test("acquires a fresh lock and returns a fencing token", async () => {
    const store = createInMemoryRunLockStore();
    const now = new Date("2026-07-02T00:00:00.000Z");
    const result = await store.acquire({
      scope: "pkg-A",
      ownerId: "worker-1",
      runId: "run-1",
      leaseMs: 60_000,
      now,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.scope).toBe("pkg-A");
    expect(result.row.ownerId).toBe("worker-1");
    expect(result.row.fencingToken).toBe("1");
    expect(result.row.leaseExpiresAt).toBe("2026-07-02T00:01:00.000Z");
  });

  test("rejects a second acquire while lease is live", async () => {
    const store = createInMemoryRunLockStore();
    const now = new Date("2026-07-02T00:00:00.000Z");
    await store.acquire({
      scope: "pkg-A",
      ownerId: "worker-1",
      runId: "run-1",
      leaseMs: 60_000,
      now,
    });
    const second = await store.acquire({
      scope: "pkg-A",
      ownerId: "worker-2",
      runId: "run-2",
      leaseMs: 60_000,
      now: new Date("2026-07-02T00:00:30.000Z"),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.heldBy.ownerId).toBe("worker-1");
  });

  test("release lets the next owner acquire with a monotonic fencing token", async () => {
    const store = createInMemoryRunLockStore();
    const now = new Date("2026-07-02T00:00:00.000Z");
    const first = await store.acquire({
      scope: "pkg-A",
      ownerId: "worker-1",
      runId: "run-1",
      leaseMs: 60_000,
      now,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await store.release(first.row.lockId, "worker-1");
    const second = await store.acquire({
      scope: "pkg-A",
      ownerId: "worker-2",
      runId: "run-2",
      leaseMs: 60_000,
      now: new Date("2026-07-02T00:01:30.000Z"),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.row.fencingToken).toBe("2");
  });

  test("release is a no-op when the owner does not match", async () => {
    const store = createInMemoryRunLockStore();
    const acquire = await store.acquire({
      scope: "pkg-A",
      ownerId: "worker-1",
      runId: "run-1",
      leaseMs: 60_000,
      now: new Date("2026-07-02T00:00:00.000Z"),
    });
    expect(acquire.ok).toBe(true);
    if (!acquire.ok) return;
    await store.release(acquire.row.lockId, "worker-2");
    const held = await store.peek("pkg-A");
    expect(held?.ownerId).toBe("worker-1");
  });

  test("expired lease unblocks the next acquirer", async () => {
    const store = createInMemoryRunLockStore();
    await store.acquire({
      scope: "pkg-A",
      ownerId: "worker-1",
      runId: "run-1",
      leaseMs: 1_000,
      now: new Date("2026-07-02T00:00:00.000Z"),
    });
    const later = await store.acquire({
      scope: "pkg-A",
      ownerId: "worker-2",
      runId: "run-2",
      leaseMs: 1_000,
      now: new Date("2026-07-02T00:00:02.000Z"),
    });
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    expect(later.row.fencingToken).toBe("2");
  });
});
