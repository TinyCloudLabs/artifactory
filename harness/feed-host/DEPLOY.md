# Feed Host production deployment

Feed Host runs in its own Phala CVM. The separate CVM isolates its persistent
identity and TinyCloud workload from the existing Artifactory agent.

## Build and publish

Initialize the pinned Feed submodule, then build an amd64 image from the
Artifactory repository root:

```sh
git submodule update --init submodules/feed
docker buildx build \
  --platform linux/amd64 \
  -f harness/feed-host/Dockerfile \
  --build-arg ARTIFACTORY_COMMIT="$(git rev-parse HEAD)" \
  --build-arg FEED_COMMIT="$(git -C submodules/feed rev-parse HEAD)" \
  -t ghcr.io/tinycloudlabs/feed-host:<git-sha> \
  --push .
```

Confirm the GHCR package is public, resolve its manifest digest, and set the
complete immutable image reference locally:

```sh
export FEED_HOST_IMAGE='ghcr.io/tinycloudlabs/feed-host@sha256:<digest>'
docker compose -f harness/feed-host/docker-compose.yml config --quiet
```

The GitHub workflow `feed-host-image.yml` publishes the same amd64 image for
main-branch changes and manual runs.

## Deploy

No private key is injected. Feed Host creates `host-key.json` with mode 0600 in
the named volume and reuses it across restarts. Never delete that volume during
an update: doing so changes the Host DID and invalidates existing delegations.

```sh
phala deploy \
  -c harness/feed-host/docker-compose.yml \
  -n feed-host \
  -t tdx.small \
  --no-public-logs \
  --no-public-sysinfo \
  --wait
```

Record the resulting port-8787 gateway URL in
`harness/agent/edge-proxy/wrangler.toml`, deploy the Worker, and verify both
routes:

```sh
curl -fsS https://api.feed.tinycloud.xyz/health
curl -fsS https://api.feed.tinycloud.xyz/agent/info
```

Before calling the deployment complete, restart the CVM and confirm
`/delegation-policy` reports the same `delegateDID`.
