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
COPY harness/feed-v1-worker ./harness/feed-v1-worker
COPY skills/_shared ./skills/_shared

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
