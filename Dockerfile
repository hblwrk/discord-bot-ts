FROM node:17-alpine AS builder

RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app

WORKDIR /home/node/app

COPY package*.json ./

COPY --chown=node:node . .

USER node

RUN npm ci --only=production

# Cant use distroless due to TypeScript workaround
#FROM gcr.io/distroless/nodejs:16
FROM node:17-alpine

COPY --from=builder /home/node/app /app

WORKDIR /app

HEALTHCHECK NONE

EXPOSE 11312/tcp

#CMD ["--loader ts-node/esm index.ts"]
CMD ["node", "--loader", "ts-node/esm", "index.ts"]
