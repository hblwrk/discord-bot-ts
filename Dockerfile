FROM node:25-alpine AS builder

RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app

WORKDIR /home/node/app

COPY --chown=node:node package*.json ./

COPY --chown=node:node . .

USER node

RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs22:nonroot

COPY --chown=65532:65532 --from=builder /home/node/app /app

WORKDIR /app

ENV HEALTHCHECK_PORT=11312
ENV TSX_DISABLE_CACHE=1
ENV TMPDIR=/dev/shm

USER 65532:65532

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "const healthcheckPort = process.env.HEALTHCHECK_PORT; fetch('http://127.0.0.1:' + healthcheckPort + '/api/v1/health').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

EXPOSE 11312/tcp

CMD ["--import", "tsx", "index.ts"]
