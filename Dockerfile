FROM node:22-alpine AS builder

RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app

WORKDIR /home/node/app

COPY package*.json ./

COPY --chown=node:node . .

USER node

RUN npm ci --only=production

FROM gcr.io/distroless/nodejs:18

COPY --from=builder /home/node/app /app

WORKDIR /app

HEALTHCHECK NONE

EXPOSE 11312/tcp

CMD ["--loader", "ts-node/esm", "index.ts"]
