# Feed Host production deployment

Feed runs as two services in one Phala CVM. `feed-host` owns the stable Host
identity, actor delegations, queue, and projections. `feed-worker` polls the
Host over the private Compose network, reads fenced Listen batches, runs the
Claude judgment and critic, creates the required Gemini hero, and publishes
the completed artifact back through the worker API. Only the Host exposes a
port; the worker never receives the Host private key or state volume.

Both services are `restart: unless-stopped`. Host identity state and the
worker's privacy-safe run ledgers use separate named volumes.

## Images and immutable provenance

`.github/workflows/feed-host-image.yml` is the release path. It builds both
linux/amd64 Dockerfiles on pull requests without pushing. A main-branch or
manual workflow run publishes both GHCR images, captures their immutable OCI
digests, replaces both checked-in digest pins in a temporary Compose file, and
deploys that rendered file.

The worker image contains Bun, ffmpeg, the worker source, `skills/_shared`, and
a pinned headless Claude CLI. It runs as an unprivileged user. The image build
bakes `FEED_WORKER_PACKAGE_VERSION` and `FEED_WORKER_PACKAGE_DIGEST` into the
runtime environment, so every artifact reports the exact reviewed worker
source package. Claude authentication is exclusively `ANTHROPIC_API_KEY` in
the container; there is no macOS Keychain or copied login state.

The checked-in Compose file remains digest-pinned for both images. Do not
replace either reference with a mutable tag.

Validate the production shape without starting or pulling anything:

```sh
docker compose -f harness/feed-host/docker-compose.yml config --quiet
```

## Deployment environment

Configure these in the GitHub repository before running the workflow:

| GitHub setting | Kind | Container mapping | Purpose |
| --- | --- | --- | --- |
| `PHALA_CLOUD_API_KEY` | Actions secret | deploy CLI only | Updates the existing `feed-host` CVM. |
| `FEED_HOST_DIAGNOSTICS_TOKEN` | Actions secret | same Host variable | Protects `/admin/diagnostics` and enables rollout proof. |
| `FEED_HOST_WORKER_TOKEN` | Actions secret | Host `FEED_HOST_WORKER_TOKEN`; worker `FEED_HOST_TOKEN` | One shared bearer value for the private worker API. |
| `FEED_GEMINI_API_KEY` | Actions secret | worker `GEMINI_API_KEY` | Generates the mandatory compressed hero. |
| `FEED_ANTHROPIC_API_KEY` | Actions secret | worker `ANTHROPIC_API_KEY` | Authenticates both keychain-free `claude -p` subprocesses. |
| `FEED_PROACTIVE_ACTOR` | Repository variable | Host `FEED_PROACTIVE_ACTOR_ID`; worker `FEED_ACTOR_ID` | Non-secret actor DID used by the daily enqueue and worker poll. |

`FEED_HOST_URL=http://feed-host:8787` and `FEED_WORKER_SOURCE=host` are fixed in
Compose. Leaving `FEED_PROACTIVE_ACTOR` empty makes the scheduler inert. The
deployment gate requires the actor, worker token, diagnostics token, and Phala
credential because rollout verification cannot succeed without them.

Gemini and Anthropic keys are not startup preflights: an image can boot and
poll with either key empty. A request still fails honestly instead of
publishing a degraded card. Missing Claude auth fails the judgment/critic
subprocess; missing Gemini auth reaches the mandatory-hero path and reports a
typed hero failure. Production should configure both encrypted secrets.

No private Host key is injected. `feed-host` creates `host-key.json` with mode
0600 in `feed-host-state` and reuses it across restarts. Never delete or replace
that volume during an update: doing so changes the Host DID and invalidates
existing delegations.

## CI-only deploy and rollout proof

Deploy through `feed-host-image.yml`. The currently installed manual Phala CLI
path does not reliably preserve the rendered two-image digests and encrypted
multi-service environment, so a local `phala deploy` is not a supported release
path. The workflow is the single owner of image rendering and deploy flags.

Before deploying, CI records `/delegation-policy.delegateDID`. After the CVM
transitions through `updating` to `running`, it requires all of the following:

1. the direct Host health endpoint succeeds;
2. the post-rollout `delegateDID` matches the recorded identity;
3. authenticated `/admin/diagnostics` contains an
   `actors.*.lastWorkerClaim.ts` less than five minutes old; and
4. the public `https://api.feed.tinycloud.xyz/health` route succeeds.

The recent claim check proves the colocated worker reached and authenticated to
the new Host, even when the queue was empty. After the production rollout,
clear the `FEED_MONITOR_ACKED_ALERTS` repository variable as soon as
`workerClaimStale` is false so the scheduled monitor resumes failing on a
regression.

Before replacing either image, CI captures and validates the currently deployed
Compose file. If rollout verification fails after deployment, the final step
redeploys those prior immutable image digests and waits for Host health to
recover. The workflow remains failed so the rejected rollout is still visible.

Production is pinned to Feed `2e6fe9f` while the later generation-observability
reland is investigated. Do not advance the submodule past that revision without
a rollout proving both a fresh worker claim and authenticated diagnostics inside
the 15-second probe budget.

## Manual local stub parity check

This is a manual pre-release check, not an E2E or CI job. It uses no model keys
or spend. Initialize the Feed submodule, choose a non-production test actor with
a valid Feed/Listen delegation, and create a local-only override:

```sh
git submodule update --init submodules/feed
export FEED_ACTOR_ID='did:pkh:your-test-actor'
export FEED_HOST_WORKER_TOKEN='local-worker-token'
export FEED_WORKER_PACKAGE_VERSION="$(git rev-parse HEAD)"
export FEED_WORKER_PACKAGE_DIGEST="sha256:$(git archive --format=tar HEAD harness/feed-v1-worker skills/_shared | shasum -a 256 | awk '{print $1}')"

cat >/tmp/feed-colocated-local.yml <<'YAML'
services:
  feed-host:
    image: feed-host:local
    build:
      context: .
      dockerfile: harness/feed-host/Dockerfile
      args:
        ARTIFACTORY_COMMIT: local
        FEED_COMMIT: local
    environment:
      FEED_HOST_DIAGNOSTICS_TOKEN: local-diagnostics-token
      FEED_HOST_ALLOWED_ORIGINS: http://127.0.0.1:5173,http://localhost:5173
  feed-worker:
    image: feed-worker:local
    build:
      context: .
      dockerfile: harness/feed-v1-worker/Dockerfile
      args:
        ARTIFACTORY_COMMIT: local
        FEED_WORKER_PACKAGE_VERSION: ${FEED_WORKER_PACKAGE_VERSION}
        FEED_WORKER_PACKAGE_DIGEST: ${FEED_WORKER_PACKAGE_DIGEST}
    environment:
      FEED_WORKER_GENERATOR: stub
      GEMINI_API_KEY: ""
      ANTHROPIC_API_KEY: ""
YAML

docker compose -p feed-colocated-local \
  -f harness/feed-host/docker-compose.yml \
  -f /tmp/feed-colocated-local.yml \
  config --quiet
docker compose -p feed-colocated-local \
  -f harness/feed-host/docker-compose.yml \
  -f /tmp/feed-colocated-local.yml \
  up --build --detach
```

Run the already-installed local Feed client with
`(cd submodules/feed && bun run dev:local)`. Use its normal sign-in once so the
Host receives the test actor's delegations, then submit one Ask Feed request.
The worker log must show
`claimed` and `published` for that request; the request should finish with the
`published` outcome and deterministic stub hero. The worker run volume retains
the matching immutable `publication.checkpoint.json`.
Confirm that diagnostics recorded the poll:

```sh
docker compose -p feed-colocated-local \
  -f harness/feed-host/docker-compose.yml \
  -f /tmp/feed-colocated-local.yml \
  logs feed-worker
curl --fail --silent --show-error \
  -H 'Authorization: Bearer local-diagnostics-token' \
  http://127.0.0.1:8787/admin/diagnostics \
  | jq -e '[.actors[]?.lastWorkerClaim] | any(.[]; . != null)'
```

Stop the local stack when the request is complete. Keep the named Host volume
if the same local actor will be reused; otherwise remove the project volumes
explicitly only after confirming they contain no needed test identity.
