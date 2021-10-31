FROM node:17-alpine

RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app

WORKDIR /home/node/app

COPY package*.json ./

COPY --chown=node:node . .

USER node

RUN npm install

HEALTHCHECK --interval=10s --timeout=10s --start-period=10s --retries=3 CMD [ "pgrep", "node" ]

CMD [ "node", "index.js", "run" ]
