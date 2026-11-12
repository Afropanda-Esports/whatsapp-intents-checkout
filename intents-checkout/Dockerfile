FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY intents-checkout/package.json intents-checkout/package.json
COPY checkout-agent/package.json checkout-agent/package.json

RUN npm ci

COPY intents-checkout intents-checkout

WORKDIR /app/intents-checkout

EXPOSE 3000

CMD ["node", "--import", "tsx", "src/index.ts"]
