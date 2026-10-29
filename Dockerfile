# Telegram Relay Console — Docker image
FROM node:20-alpine

# fs.writeFileSync/rename у data/ — потребує прав на папку, яку монтуємо як volume
WORKDIR /app
ENV NODE_ENV=production PORT=3000

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "server.js"]
