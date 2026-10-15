FROM node:18-slim

# 安裝原生 FFmpeg 引擎
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 10000
# 關鍵修正：直接用 node 啟動，不要透過 npm start
CMD ["node", "server.js"]
