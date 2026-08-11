FROM --platform=linux/amd64 oven/bun:1.3.12-debian

ARG ARTIFACTORY_COMMIT=unknown
ARG FEED_WORKER_PACKAGE_VERSION
ARG FEED_WORKER_PACKAGE_DIGEST
LABEL org.opencontainers.image.source="https://github.com/TinyCloudLabs/artifactory" \
      org.opencontainers.image.revision=$ARTIFACTORY_COMMIT \
      xyz.tinycloud.feed.worker.package.version=$FEED_WORKER_PACKAGE_VERSION \
      xyz.tinycloud.feed.worker.package.digest=$FEED_WORKER_PACKAGE_DIGEST

RUN test -n "$FEED_WORKER_PACKAGE_VERSION" \
  && expr "$FEED_WORKER_PACKAGE_DIGEST" : 'sha256:[0-9a-f]\{64\}$' >/dev/null

# Claude Code's installer needs Node/npm. The production card floor also runs
# every provider image through ffmpeg before publication.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg nodejs npm \
  && rm -rf /var/lib/apt/lists/*

# Pin the headless CLI and expose it on PATH. Production authentication comes
# only from ANTHROPIC_API_KEY; no login files or keychain state are copied in.
WORKDIR /opt/feed-worker
RUN npm install --no-save --omit=dev @anthropic-ai/claude-code@2.1.177 \
  && ln -sf /opt/feed-worker/node_modules/.bin/claude /usr/local/bin/claude \
  && claude --version \
  && ffmpeg -version >/dev/null

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY harness/feed-v1-worker ./harness/feed-v1-worker
COPY packages/artifactory/src ./packages/artifactory/src
COPY packages/artifactory/policies ./packages/artifactory/policies
COPY skills/_shared ./skills/_shared
COPY skills/feed-daily-brief ./skills/feed-daily-brief
COPY skills/feed-decision-memo ./skills/feed-decision-memo
COPY skills/feed-exception-alert ./skills/feed-exception-alert
COPY skills/feed-playbook ./skills/feed-playbook
COPY skills/feed-short-insights ./skills/feed-short-insights
COPY skills/feed-synthesis-report ./skills/feed-synthesis-report

RUN useradd --create-home --uid 10001 feed-worker \
  && mkdir -p /home/feed-worker/.feed-v1-worker/runs \
  && chown -R feed-worker:feed-worker /app /home/feed-worker

USER feed-worker
ENV HOME=/home/feed-worker \
    FEED_WORKER_PACKAGE_VERSION=$FEED_WORKER_PACKAGE_VERSION \
    FEED_WORKER_PACKAGE_DIGEST=$FEED_WORKER_PACKAGE_DIGEST \
    FEED_WORKER_SOURCE=host \
    FEED_WORKER_RUNS_DIR=/home/feed-worker/.feed-v1-worker/runs \
    FEED_WORKER_FFMPEG_PATH=/usr/bin/ffmpeg

CMD ["bun", "harness/feed-v1-worker/worker.ts"]
