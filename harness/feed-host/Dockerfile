FROM --platform=linux/amd64 oven/bun:1.3.12-debian

ARG ARTIFACTORY_COMMIT=unknown
ARG FEED_COMMIT=unknown
LABEL org.opencontainers.image.source="https://github.com/TinyCloudLabs/artifactory" \
      org.opencontainers.image.revision=$ARTIFACTORY_COMMIT \
      xyz.tinycloud.feed.commit=$FEED_COMMIT

WORKDIR /app/submodules/feed
COPY submodules/feed/package.json submodules/feed/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY submodules/feed/host ./host
COPY submodules/feed/shared ./shared
COPY skills/_shared/lib /app/submodules/artifactory/skills/_shared/lib

RUN mkdir -p /home/bun/.tinycloud-feed-host \
  && chown -R bun:bun /app /home/bun/.tinycloud-feed-host

USER bun
ENV FEED_HOST_HOSTNAME=0.0.0.0 \
    FEED_HOST_PORT=8787 \
    FEED_HOST_STATE_DIR=/home/bun/.tinycloud-feed-host \
    FEED_HOST_SEED=0 \
    FEED_HOST_DEV_PUBLISH=0 \
    TINYCLOUD_HOST=https://node.tinycloud.xyz

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const r=await fetch('http://127.0.0.1:8787/health');if(!r.ok)process.exit(1)"]

CMD ["bun", "host/server.ts"]
