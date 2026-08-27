FROM node:24-alpine AS builder

RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app

WORKDIR /home/node/app

COPY --chown=node:node package*.json ./

USER node

RUN npm ci --omit=dev

COPY --chown=node:node . .

# Distroless can lag a Debian security update between image rebuilds. Build a complete,
# version-pinned package overlay so the runtime receives both the patched libraries and the
# package metadata Trivy uses to verify them. Remove this stage once the distroless base ships
# libssl3t64 3.5.7-1~deb13u2 or newer.
FROM debian:13-slim AS openssl-patch

ARG OPENSSL_VERSION=3.5.7-1~deb13u2
WORKDIR /tmp

RUN apt-get update \
    && apt-get download "libssl3t64=${OPENSSL_VERSION}" \
    && package_file="libssl3t64_${OPENSSL_VERSION}_amd64.deb" \
    && mkdir -p /patch/var/lib/dpkg/status.d /tmp/libssl-control \
    && dpkg-deb --extract "${package_file}" /patch \
    && dpkg-deb --field "${package_file}" > /patch/var/lib/dpkg/status.d/libssl3t64 \
    && dpkg-deb --ctrl "${package_file}" /tmp/libssl-control \
    && cp /tmp/libssl-control/md5sums /patch/var/lib/dpkg/status.d/libssl3t64.md5sums \
    && rm -rf /var/lib/apt/lists/* "${package_file}" /tmp/libssl-control

FROM gcr.io/distroless/nodejs24:nonroot

COPY --from=openssl-patch /patch/ /
COPY --chown=65532:65532 --from=builder /home/node/app /app

WORKDIR /app

ENV HEALTHCHECK_PORT=11312
ENV TMPDIR=/dev/shm

USER 65532:65532

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/nodejs/bin/node", "healthcheck.js"]

EXPOSE 11312/tcp

CMD ["index.ts"]
