#!/bin/bash
# 启动/重启 AI 模拟面试服务（node + cloudflared 隧道）
cd /data/home/interview || exit 1

echo "== npm install =="
npm install --no-audit --no-fund --omit=dev || exit 1

echo "== stop old =="
pkill -f "node server.js" 2>/dev/null
sleep 1

echo "== whisper container =="
docker start whisper-stt 2>/dev/null || docker run -d --name whisper-stt --restart unless-stopped \
  -v /data/home/whisper:/models -p 127.0.0.1:8081:8080 \
  --entrypoint /app/build/bin/whisper-server \
  ghcr.io/ggml-org/whisper.cpp:main \
  --host 0.0.0.0 --port 8080 --model /models/ggml-small-q5_1.bin --language zh --threads 4

echo "== start node =="
# 密钥从同目录 .env 读取（.env 不入库，模板见 .env.example）
[ -f .env ] && set -a && source .env && set +a
nohup node server.js > /data/home/interview/server.log 2>&1 &
sleep 1

echo "== start cloudflared =="
pkill -f "cloudflared tunnel" 2>/dev/null
sleep 1
nohup /data/home/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3100 > /data/home/cfd.log 2>&1 &

echo "== waiting for tunnel url =="
for i in $(seq 1 20); do
  sleep 3
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /data/home/cfd.log | head -1)
  if [ -n "$URL" ]; then echo "TUNNEL_URL=$URL"; break; fi
done
echo "== node log tail =="
tail -5 /data/home/interview/server.log
