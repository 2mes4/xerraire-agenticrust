FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json .
RUN npm config set registry http://registry.npmjs.org/ && npm config set strict-ssl false && npm install --omit=dev

COPY server.js .

CMD ["node", "server.js"]
