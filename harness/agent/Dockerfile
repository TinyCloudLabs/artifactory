# Dockerfile — the distillery agent backend for a Phala CVM (TEE), phase 2.
#
# The agent is a Bun HTTP server (harness/agent/src/server.ts) that shells out to
# two external binaries the image must provide on PATH:
#   - `tc`     — the TinyCloud CLI (the tc-listen-read / tc-publish skills run it).
#   - `claude` — the headless generate step (runner.ts `claude -p`).
#
# Locally those resolve to a source build (bin/tc-local) + a Homebrew claude +
# the macOS Keychain. NONE of that exists in a Linux TEE, so here we:
#   - install the PUBLISHED npm packages (`@tinycloud/cli`, `@tinycloud/node-sdk`,
#     `@anthropic-ai/claude-code`) into /opt/agent — verified the published
#     cli@0.7.0-beta.4 supports `kv put --space` and node-sdk@2.4.0-beta.2 exports
#     the symbols session.ts imports; node-sdk is pure-WASM (no native build).
#   - override the two HARDCODED macOS paths in the committed source via env:
#       TC_BIN        → the installed tc (else skills/_shared/lib/tc.ts hardcodes
#                       /Users/.../bin/tc-local)
#       NODE_SDK_DIST → the installed node-sdk dist (else node-sdk.ts hardcodes
#                       /Users/.../js-sdk/.../node-sdk/dist/index.js)
#   - feed claude auth from an env secret (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_
#     TOKEN) — there is NO macOS Keychain in the TEE.
#
# Phala CVMs run Intel TDX (amd64 ONLY). On Apple Silicon you MUST build with
#   docker buildx build --platform linux/amd64 ...
# or the image crashes on CVM boot with "exec format error".

FROM --platform=linux/amd64 oven/bun:1-debian

# Node is needed: the @anthropic-ai/claude-code wrapper's postinstall runs under
# node, and the published native `claude` binary is launched directly thereafter.
# curl is for the in-image healthcheck / smoke test.
RUN apt-get update \
  && apt-get install -y --no-install-recommends nodejs npm curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ── External tools (tc CLI + node-sdk dist + claude CLI) into /opt/agent ──────
# A dedicated prefix keeps the tool node_modules separate from the (dependency-
# free) distillery app source. Pinned versions = reproducible image. npm install
# (NOT --ignore-scripts) so @anthropic-ai/claude-code's postinstall copies the
# correct linux native binary over its bin stub.
WORKDIR /opt/agent
RUN npm install --no-save --omit=dev \
      @tinycloud/cli@0.7.0-beta.4 \
      @tinycloud/node-sdk@2.4.0-beta.2 \
      @tinycloud/node-sdk-wasm@1.7.4 \
      @anthropic-ai/claude-code@2.1.177 \
  && ln -sf /opt/agent/node_modules/.bin/tc /usr/local/bin/tc \
  && ln -sf /opt/agent/node_modules/.bin/claude /usr/local/bin/claude \
  && /usr/local/bin/tc --version \
  && /usr/local/bin/claude --version

# ── The distillery app: agent src + skills (cwd stays the repo root) ──────────
# The build context is the distillery REPO ROOT (see docker-compose.yml / the
# build command), so we copy the two trees the runtime needs. Skills are pure
# node:/Bun builtins (no npm deps), so no install step for them.
WORKDIR /app
COPY harness/agent ./harness/agent
COPY skills ./skills
COPY package.json tsconfig.json ./

# ── Non-root runtime user; persistent state lives on a mounted volume ─────────
# AGENT_STATE_DIR holds the stable agent key (→ did:pkh), the api-token, and the
# delegation — mount a named volume here (docker-compose.yml) so the DID survives
# restarts. Both state roots are 0700, owned by the runtime user.
RUN useradd --create-home --uid 10001 agent \
  && mkdir -p /home/agent/.tinycloud-agent /home/agent/.tinycloud-agent-runs \
  && chown -R agent:agent /app /home/agent
USER agent

# Pin the runtime paths/tooling the committed source would otherwise hardcode to
# macOS. DISTILLERY_REPO_ROOT anchors config.ts at /app (so `bun skills/...`
# resolves); AGENT_GENERATE_PATH replaces the Homebrew/.bun macOS PATH so the
# scrubbed generate child finds bun + claude + tc.
ENV DISTILLERY_REPO_ROOT=/app \
    AGENT_STATE_DIR=/home/agent/.tinycloud-agent \
    AGENT_RUNS_DIR=/home/agent/.tinycloud-agent-runs \
    TC_BIN=/opt/agent/node_modules/.bin/tc \
    NODE_SDK_DIST=/opt/agent/node_modules/@tinycloud/node-sdk/dist/index.js \
    AGENT_GENERATE_PATH=/usr/local/bin:/usr/bin:/bin \
    AGENT_HOST_BIND=0.0.0.0 \
    AGENT_PORT=4097

EXPOSE 4097

# Liveness: /agent/info is public (no token) and returns the DID + permissions.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4097/agent/info > /dev/null || exit 1

WORKDIR /app
CMD ["bun", "harness/agent/src/server.ts"]
