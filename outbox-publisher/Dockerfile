FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY shared ./shared
COPY outbox-publisher ./outbox-publisher

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "outbox-publisher/index.js"]
