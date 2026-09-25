FROM node:22-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

USER node
CMD ["npm", "start"]
