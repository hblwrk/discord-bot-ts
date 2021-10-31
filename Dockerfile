FROM node:17-alpine AS builder

RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app

WORKDIR /home/node/app

COPY package*.json ./

COPY --chown=node:node . .

USER node

RUN npm ci --only=production

FROM gcr.io/distroless/nodejs:16

COPY --from=builder /home/node/app /app

WORKDIR /app

HEALTHCHECK --interval=10s --timeout=10s --start-period=10s --retries=3 CMD ["pgrep", "node"]

CMD ["index.js"]
