FROM node:17-alpine

RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app

WORKDIR /home/node/app

COPY package*.json ./

COPY --chown=node:node . .

USER node

RUN npm install

CMD [ "node", "index.js", "run" ]
