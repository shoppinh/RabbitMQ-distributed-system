FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY shared ./shared
COPY payment-service ./payment-service

ENV NODE_ENV=production

CMD ["node", "payment-service/index.js"]
