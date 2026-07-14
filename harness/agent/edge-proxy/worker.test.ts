import { describe, expect, test } from "bun:test";
import worker, { originForPath } from "./worker.mjs";

const env = {
  AGENT_ORIGIN: "https://agent.example",
  FEED_HOST_ORIGIN: "https://host.example",
};

describe("Feed edge proxy", () => {
  test("routes only the exact agent path namespace to the legacy agent", () => {
    expect(originForPath("/agent", env)).toBe(env.AGENT_ORIGIN);
    expect(originForPath("/agent/info", env)).toBe(env.AGENT_ORIGIN);
    expect(originForPath("/agentish", env)).toBe(env.FEED_HOST_ORIGIN);
    expect(originForPath("/health", env)).toBe(env.FEED_HOST_ORIGIN);
    expect(originForPath("/api/delegations", env)).toBe(env.FEED_HOST_ORIGIN);
  });

  test("preserves method, query, headers, and body", async () => {
    let resolveReceived!: (value: { method: string; url: string; origin: string | null; body: unknown }) => void;
    const received = new Promise<{ method: string; url: string; origin: string | null; body: unknown }>((resolve) => {
      resolveReceived = resolve;
    });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        resolveReceived({
          method: request.method,
          url: request.url,
          origin: request.headers.get("origin"),
          body: await request.json(),
        });
        return new Response("ok", { status: 202, headers: { "x-upstream": "feed-host" } });
      },
    });
    try {
      const response = await worker.fetch(
        new Request("https://api.feed.tinycloud.xyz/api/delegations?mode=full", {
          method: "POST",
          headers: { origin: "https://feed.tinycloud.xyz", "content-type": "application/json" },
          body: JSON.stringify({ proof: "test-only" }),
        }),
        { ...env, FEED_HOST_ORIGIN: `http://127.0.0.1:${server.port}` },
      );
      const forwarded = await received;
      expect(response.status).toBe(202);
      expect(response.headers.get("x-upstream")).toBe("feed-host");
      expect(forwarded.method).toBe("POST");
      expect(new URL(forwarded.url).search).toBe("?mode=full");
      expect(forwarded.origin).toBe("https://feed.tinycloud.xyz");
      expect(forwarded.body).toEqual({ proof: "test-only" });
    } finally {
      server.stop(true);
    }
  });

  test("passes OPTIONS through to the selected service", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => new Response(null, { status: 204, headers: { "x-method": request.method } }),
    });
    try {
      const response = await worker.fetch(
        new Request("https://api.feed.tinycloud.xyz/health", { method: "OPTIONS" }),
        { ...env, FEED_HOST_ORIGIN: `http://127.0.0.1:${server.port}` },
      );
      expect(response.status).toBe(204);
      expect(response.headers.get("x-method")).toBe("OPTIONS");
    } finally {
      server.stop(true);
    }
  });
});
