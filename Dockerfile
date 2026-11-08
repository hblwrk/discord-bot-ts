FROM node:24-alpine AS builder

RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app

WORKDIR /home/node/app

COPY --chown=node:node package*.json ./

USER node

RUN npm ci --omit=dev

COPY --chown=node:node . .

# Distroless can lag Debian security updates. Overlay pinned runtime libraries and
# package metadata so the image scan verifies the patched versions.
FROM debian:13-slim AS runtime-patches

WORKDIR /tmp

RUN apt-get update \
    && apt-get install --download-only --reinstall --no-install-recommends -y \
      "libssl3t64=3.5.7-1~deb13u3" "zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1" \
    && mkdir -p /patch/var/lib/dpkg/status.d /tmp/libssl-control /tmp/zlib-control \
    && dpkg-deb --extract /var/cache/apt/archives/libssl3t64_3.5.7-1~deb13u3_amd64.deb /patch \
    && dpkg-deb --field /var/cache/apt/archives/libssl3t64_3.5.7-1~deb13u3_amd64.deb > /patch/var/lib/dpkg/status.d/libssl3t64 \
    && dpkg-deb --control /var/cache/apt/archives/libssl3t64_3.5.7-1~deb13u3_amd64.deb /tmp/libssl-control \
    && cp /tmp/libssl-control/md5sums /patch/var/lib/dpkg/status.d/libssl3t64.md5sums \
    && dpkg-deb --extract /var/cache/apt/archives/zlib1g_*_amd64.deb /patch \
    && dpkg-deb --field /var/cache/apt/archives/zlib1g_*_amd64.deb > /patch/var/lib/dpkg/status.d/zlib1g \
    && dpkg-deb --control /var/cache/apt/archives/zlib1g_*_amd64.deb /tmp/zlib-control \
    && cp /tmp/zlib-control/md5sums /patch/var/lib/dpkg/status.d/zlib1g.md5sums \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb /tmp/libssl-control /tmp/zlib-control

FROM gcr.io/distroless/nodejs24:nonroot

COPY --from=runtime-patches /patch/ /
COPY --chown=65532:65532 --from=builder /home/node/app /app

WORKDIR /app

ENV HEALTHCHECK_PORT=11312
ENV TMPDIR=/dev/shm

USER 65532:65532

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/nodejs/bin/node", "healthcheck.js"]

EXPOSE 11312/tcp

CMD ["index.ts"]
