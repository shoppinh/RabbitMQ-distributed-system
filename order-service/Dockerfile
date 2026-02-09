FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY shared ./shared
COPY order-service ./order-service

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "order-service/index.js"]
