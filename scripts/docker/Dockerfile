# syntax=docker/dockerfile:1
# Build each target architecture natively (or under QEMU), including native addons.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS builder

ENV FFMPEG_BIN=/usr/bin/ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN npm ci --prefix web
COPY . .
RUN npm run build \
    && npm prune --omit=dev \
    && npm run check:native \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS downloader
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/docker/install-yt-dlp.sh /tmp/install-yt-dlp.sh
RUN sh /tmp/install-yt-dlp.sh "$TARGETARCH" /usr/local/bin/yt-dlp

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    FFMPEG_BIN=/usr/bin/ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/scripts/check-native.mjs ./scripts/check-native.mjs
COPY --from=builder /app/scripts/lib/console-log.mjs ./scripts/lib/console-log.mjs
COPY --from=downloader /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
COPY --from=downloader /usr/local/share/doc/yt-dlp /usr/local/share/doc/yt-dlp
COPY scripts/docker/yt-dlp.conf /etc/yt-dlp.conf
COPY scripts/docker/healthcheck.mjs ./scripts/healthcheck.mjs

# Persistent config, database, cookies, uploads and logs; optional external media.
RUN mkdir -p /app/data /mnt/media \
    && node scripts/check-native.mjs \
    && test "$(yt-dlp --version)" = "2026.08.19" \
    && ffmpeg -version >/dev/null
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "dist/index.js"]
