# AI 实时语音模拟面试（简历 + GitHub 深挖）

上传简历和 GitHub 仓库 → AI 面试官真的克隆并通读你的代码 → 网页实时语音对话，像真人一样逐层追问 → 结束生成复盘报告。

## 当前部署（2026-11-01，Gemini Live 引擎版）

- **引擎（默认）**：`gemini-3.8-live` 端到端实时语音（Google AI Studio 免费 key）——浏览器麦克风 16k PCM 持续直通 Gemini，模型侧 VAD + 原生打断，音频 24k PCM 流式回放，<1s 响应
- **兜底引擎（cascade）**：Live 不可用时自动降级——FunASR…不，whisper.cpp STT + wb 中转 glm-5.3-flash LLM + Google TTS，3~5s 延迟
- 盒子：`ssh -p 2222 ibssh_ghm5rj5bxag6f2xedmjmof6aha@ssh.instabox.sh`（项目在 `/data/home/interview`，重启跑 `bash start.sh`）
- 入口：cloudflared 快速隧道（URL 在 `/data/home/cfd.log`，**每次重启换新 URL**）

## 部署位置（2026-11-04 起：东京 Lightsail）

- 主机：`ssh tokyo`（Amazon Linux 2023，2C / 916MB），代码在 `~/interview`，systemd `interview.service`（`/usr/bin/node-22 server.js`，环境变量读 `~/interview/.env`）
- 入口：Caddy 反代 `https://54-199-55-96.sslip.io`（Let's Encrypt 自动证书；Caddy 原本就在跑 80/443）。换自有域名 = 加一条 A 记录 + 在 `/etc/caddy/Caddyfile` 加站点块后 `systemctl reload caddy`
- 依赖：Node 22 + git（GitHub 仓库深挖必需）+ ffmpeg（仅 e2e 测试用）
- 运维：日志 `~/interview/server.log`，重启 `sudo systemctl restart interview`
- 注意：内存 916MB，只跑 Live 引擎（Node 实占约 25MB）；cascade 的 whisper 容器放不下，兜底需外挂
- 旧盒子（instabox，美东）保留作对照

## 关键实现要点（踩坑）

- Live API WS：`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=...`，**响应是二进制帧装 UTF-8 JSON**
- 音频输入字段用 `realtimeInput.audio`（`mediaChunks` 已废弃：只处理第一块）；`audio/pcm;rate=16000` 进，24k 出
- **自动 VAD 需要持续音频流（含静音）**：不能说完就停发帧，否则模型一直等（e2e 里要灌静音帧）
- 转写：`inputTranscription`/`outputTranscription` 分片到达，按 turn 聚合入 transcript
- 打断：`serverContent.interrupted` → 前端停掉所有已调度 AudioBufferSource
- 15 分钟会话上限：断线自动重连（≤3 次）并注入前情摘要继续面
- wb 中转 glm-5.3-flash 流式先吐 `reasoning_content`，解析要跳过
- Edge TTS 已被微软锁死（DRM 403）；免费 TTS 用 Google `translate_tts?client=tw-ob`

## 配置（环境变量）

所有密钥通过环境变量注入，**代码与仓库里永远不出现明文密钥**。本地部署：复制 `.env.example` 为 `.env` 填好即可（`.env` 已被 .gitignore 排除）。托管平台上（Cloudflare/GitHub Actions）用平台自带的 Secrets 功能配置同名变量。

| 变量 | 用途 |
|---|---|
| `GEMINI_KEY` / `GEMINI_MODEL` / `GEMINI_VOICE` | Gemini Live 实时引擎（必填，Google AI Studio 免费领取） |
| `LLM_BASE` / `LLM_KEY` / `LLM_MODEL` | cascade 兜底引擎的 OpenAI 兼容接口（可选） |
| `WHISPER_URL` | cascade 的 whisper.cpp 服务地址（可选） |
| `INTERVIEW_MINUTES` | 单场面试时长上限（分钟），默认 15；到点自动收尾并生成报告 |
| `PORT` | 监听端口，默认 3100 |

⚠️ 安全：公开仓库中提交明文 API key 会在数秒内被爬虫扫走盗用。若不慎泄露，立即吊销重发。

## 部署

- **当前形态**：任意 Linux 盒子（Node 22 + 可选 Docker whisper 容器）+ Cloudflare Tunnel 对外提供 HTTPS（麦克风 API 需要安全上下文）。`bash start.sh` 一键启动并打印公网 URL
- **挂自己的 Cloudflare**：`cloudflared tunnel login` 后创建命名隧道（`cloudflared tunnel create <名>`），绑定自己的域名即可获得固定地址，替代 trycloudflare 随机 URL
- **纯 Serverless（Cloudflare Workers）路线**：WS 中继部分可移植到 Workers + Durable Objects（浏览器 ↔ DO ↔ Gemini Live 双向 WS），cascade 兜底需另行处理或去掉；待办

## 使用

1. 打开地址 → 简历 + GitHub 仓库 → 选模式 → 准备面试（真实模式 15~30s，代码深挖 40~60s）
2. 面试风格：**真实面试**（默认，面试官只掌握简历+项目简介，只问业务/选型/规模/原理，不提文件名、不假装看过代码）或 **代码深挖**（点名文件逐层追问实现细节）
3. 进入面试室，等"实时连线"提示后直接说话；AI 说话时可随时开口打断
4. 文字输入框可补充回答；结束按钮 → 复盘报告（总分 + 四维分 + 逐题点评 + 完整转写）
5. 顶部显示剩余时长（默认 15 分钟，最后 3 分钟变红，到点自动收尾出报告）；⚙️ 里可切麦克风设备、调面试官音量
6. 手机 / 平板自适应：单列布局，候选人档案卡可折叠；报告页会记录最近 5 场成绩（仅存浏览器本地）

## 回归测试

```bash
cd /data/home/interview
node test/e2e-live.mjs    # Live 引擎全链路（含语音转写/打断/报告）
node test/e2e.mjs         # cascade 引擎（需 server 无 GEMINI_KEY 时跑）
node test/live-smoke.mjs <KEY>   # Live WS 协议冒烟
```

