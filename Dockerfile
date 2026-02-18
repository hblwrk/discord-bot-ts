FROM node:22-alpine AS builder

RUN mkdir -p /home/node/app/node_modules /home/node/app/tmp \
  && chown -R node:node /home/node/app \
  && chmod 1777 /home/node/app/tmp

WORKDIR /home/node/app

COPY package*.json ./

COPY --chown=node:node . .

USER node

RUN npm ci --only=production

FROM gcr.io/distroless/nodejs22

COPY --from=builder /home/node/app /app

WORKDIR /app

ENV TMPDIR=/app/tmp

HEALTHCHECK NONE

EXPOSE 11312/tcp

CMD ["--import", "tsx", "index.ts"]
