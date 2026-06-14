# edge-proxy — api.feed.tinycloud.xyz → the agent CVM

A tiny Cloudflare Worker that gives the feed a clean, stable API host
(`https://api.feed.tinycloud.xyz`) instead of the long Phala dstack gateway URL
(`https://<app-id>-4097.dstack-pha-prod5.phala.network`).

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

`worker.mjs` forwards every request (method, headers incl. `Origin`/`Authorization`,
body) to the agent origin and returns the agent's response verbatim — including the
agent's own CORS headers (the agent's `AGENT_ALLOWED_ORIGIN` still gates the browser
origins). `api.feed…` is only the API *host*, not a browser origin, so it doesn't
need to be in the CORS allowlist.

## Deploy / update

```sh
cd harness/agent/edge-proxy
# uses CLOUDFLARE_API_TOKEN (Workers Scripts: Edit on the account)
CLOUDFLARE_ACCOUNT_ID=9959301f03d2db1a5fcf5e004278d467 wrangler deploy
```

The `routes` entry with `custom_domain = true` provisions the DNS record + cert for
`api.feed.tinycloud.xyz` automatically. To point at a different agent CVM, change
`ORIGIN` in `worker.mjs` and redeploy (or just change the feed's `agent-config.json`
host — the DID is auto-discovered from `/agent/info`).
