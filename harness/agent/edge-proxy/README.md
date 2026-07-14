# edge-proxy — api.feed.tinycloud.xyz → Feed services

A tiny Cloudflare Worker that gives the feed a clean, stable API host
(`https://api.feed.tinycloud.xyz`) instead of the long Phala dstack gateway URL
(`https://<app-id>-<port>.dstack-pha-prod5.phala.network`).

## Why a Worker (not a plain CNAME or the dstack-ingress)

- A **plain proxied Cloudflare CNAME** to the dstack gateway fails with **HTTP 525**:
  the gateway routes by **SNI**, and Cloudflare forwards the visitor's SNI
  (`api.feed…`), which the gateway rejects.
- **dstack-ingress** works but requires putting a Cloudflare **DNS-edit token inside
  the CVM (TEE secret)** — an avoidable credential in the trust boundary.
- A **Worker** `fetch()`es the origin server-side, so the connection uses the
  **origin's own SNI/Host** → the gateway routes correctly. Cloudflare auto-issues
  the edge cert for the (2-level) custom domain via the Worker **Custom Domain**.
  **No secret anywhere** — it's a transparent passthrough.

## What it does

`worker.mjs` sends `/agent` and `/agent/*` to the existing Artifactory agent.
Every other path goes to Feed Host. It forwards method, query, headers, and body,
and returns the selected service's response verbatim, including its CORS and
`Set-Cookie` headers. `api.feed…` is only the API host, not a browser origin, so
the user-facing Feed origins remain the services' CORS allowlists.

## Deploy / update

```sh
cd harness/agent/edge-proxy
# uses CLOUDFLARE_API_TOKEN (Workers Scripts: Edit on the account)
CLOUDFLARE_ACCOUNT_ID=9959301f03d2db1a5fcf5e004278d467 wrangler deploy
```

The `routes` entry with `custom_domain = true` provisions the DNS record + cert for
`api.feed.tinycloud.xyz` automatically. Update `AGENT_ORIGIN` or
`FEED_HOST_ORIGIN` in `wrangler.toml` when a CVM endpoint changes, then redeploy.
