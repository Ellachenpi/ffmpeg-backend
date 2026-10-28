FROM node:18-slim

# 安裝原生 FFmpeg 引擎
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 10000
# 直接使用 node 執行，確保正確接收訊號
CMD ["node", "server.js"]
