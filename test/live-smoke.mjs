// Gemini Live API WS 冒烟测试（不依赖浏览器）
// 用法: node live-smoke.mjs <API_KEY> [模型名]
// 流程: setup(中文面试官人设) -> 灌入一段 16k PCM 人声 -> 期望收到 setupComplete / inputTranscription / 音频 / outputTranscription / turnComplete
import fs from 'fs';
import WebSocket from 'ws';

const KEY = process.argv[2];
const MODEL = process.argv[3] || 'gemini-3.8-live';
if (!KEY) { console.error('usage: node live-smoke.mjs <KEY>'); process.exit(1); }
const PCM = fs.existsSync('/tmp/test_utt.pcm') ? fs.readFileSync('/tmp/test_utt.pcm') : null;
if (!PCM) { console.error('缺 /tmp/test_utt.pcm（先用 ffmpeg 生成 16k s16le）'); process.exit(1); }

const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${KEY}`;
const ws = new WebSocket(url, { handshakeTimeout: 20000 });
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;

let audioBytes = 0, inText = '', outText = '', setupDone = false, turns = 0;
let fed = 0;
const CHUNK = 3200; // 100ms @16k s16le

ws.on('open', () => {
  console.log(ts(), 'ws open');
  ws.send(JSON.stringify({
    setup: {
      model: `models/${MODEL}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } },
      },
      systemInstruction: { parts: [{ text: '你是资深技术面试官林工，用普通话进行一对一实时语音面试。一次只问一个问题，单次回复不超过两句话，口语化，禁止任何 markdown 和列表。' }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  }));
});

ws.on('message', (raw, isBinary) => {
  // Live API 的响应是「二进制帧里装 UTF-8 JSON」
  let msg;
  try { msg = JSON.parse((isBinary ? Buffer.from(raw) : raw).toString('utf8')); } catch { console.log(ts(), 'non-json frame:', String(raw).slice(0, 120)); return; }
  if (msg.setupComplete) {
    setupDone = true;
    console.log(ts(), 'setupComplete — 开始灌音频');
    const iv = setInterval(() => {
      if (fed >= PCM.length) { clearInterval(iv); ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); console.log(ts(), 'audioStreamEnd 已发'); return; }
      const chunk = PCM.subarray(fed, Math.min(fed + CHUNK, PCM.length));
      fed += chunk.length;
      ws.send(JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: chunk.toString('base64') } } }));
    }, 60); // 100ms 音频 / 60ms 间隔 ≈ 1.6 倍速灌入
    return;
  }
  const sc = msg.serverContent;
  if (sc) {
    if (sc.interrupted) console.log(ts(), '!! interrupted（模型被打断）');
    if (sc.inputTranscription?.text) inText += sc.inputTranscription.text;
    if (sc.outputTranscription?.text) outText += sc.outputTranscription.text;
    if (sc.modelTurn?.parts) {
      for (const p of sc.modelTurn.parts) {
        const d = p.inlineData?.data;
        if (d) audioBytes += d.length;
      }
    }
    if (sc.turnComplete) {
      turns++;
      console.log(ts(), `turnComplete #${turns} | 听到: "${inText.slice(0, 60)}" | 说: "${outText.slice(0, 80)}" | 音频b64累计 ${audioBytes} chars`);
      if (turns >= 2) { console.log('\n✅ LIVE SMOKE PASS'); ws.close(); process.exit(0); }
    }
    if (sc.generateContentUpdate) console.log(ts(), 'generateContentUpdate?');
  }
  if (msg.goAway) console.log(ts(), 'goAway（会话将被回收）', JSON.stringify(msg.goAway).slice(0, 100));
  if (msg.error) { console.log(ts(), 'ERROR:', JSON.stringify(msg).slice(0, 300)); process.exit(1); }
});

ws.on('error', (e) => { console.log(ts(), 'WS ERROR:', e.message); process.exit(1); });
ws.on('close', (code, reason) => { console.log(ts(), 'closed', code, String(reason).slice(0, 80)); });
setTimeout(() => { console.log('\n❌ SMOKE TIMEOUT — setupDone=' + setupDone, 'inText="' + inText.slice(0, 60) + '"', 'outText="' + outText.slice(0, 60) + '"', 'audioBytes=' + audioBytes); process.exit(1); }, 90000);
