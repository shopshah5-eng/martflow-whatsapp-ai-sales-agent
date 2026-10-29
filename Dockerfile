FROM node:20-bullseye-slim

WORKDIR /app

# Install ffmpeg for WhatsApp Opus OGG audio transcoding
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]

