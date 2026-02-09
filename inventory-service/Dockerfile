FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY shared ./shared
COPY inventory-service ./inventory-service

ENV NODE_ENV=production

CMD ["node", "inventory-service/index.js"]
