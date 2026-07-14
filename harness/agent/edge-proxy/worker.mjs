// Edge proxy: api.feed.tinycloud.xyz -> the Feed Host or Artifactory agent.
// Gives both services a stable API host instead of dstack gateway URLs.
// A Worker fetch() uses the ORIGIN's own SNI/Host, so the dstack gateway routes
// correctly — a plain Cloudflare CNAME proxy fails here (525, SNI mismatch).
// Transparent passthrough: method, headers (incl. Origin/Authorization), body,
// and the agent's own CORS response all flow through unchanged. No secrets.
export function originForPath(pathname, env) {
  return pathname === "/agent" || pathname.startsWith("/agent/")
    ? env.AGENT_ORIGIN
    : env.FEED_HOST_ORIGIN;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = originForPath(url.pathname, env);
    return fetch(new Request(origin + url.pathname + url.search, request));
  },
};
