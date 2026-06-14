// Edge proxy: api.feed.tinycloud.xyz -> the distillery agent on its Phala CVM.
// Gives the feed a stable, clean API host instead of the long dstack gateway URL.
// A Worker fetch() uses the ORIGIN's own SNI/Host, so the dstack gateway routes
// correctly — a plain Cloudflare CNAME proxy fails here (525, SNI mismatch).
// Transparent passthrough: method, headers (incl. Origin/Authorization), body,
// and the agent's own CORS response all flow through unchanged. No secrets.
const ORIGIN = "https://ad9fd8859b5777e84c79e25721b423b85ee3e20a-4097.dstack-pha-prod5.phala.network";
export default {
  async fetch(request) {
    const url = new URL(request.url);
    return fetch(new Request(ORIGIN + url.pathname + url.search, request));
  },
};
