FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY shared ./shared
COPY notification-service ./notification-service

ENV NODE_ENV=production

CMD ["node", "notification-service/index.js"]
