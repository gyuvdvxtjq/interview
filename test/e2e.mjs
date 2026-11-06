// 端到端验证：不依赖真人麦克风
// 1) TTS 生成一段"候选人回答"的语音 -> 喂给整条 WS 链路 -> 验证面试官语音回复
// 2) 验证 GitHub 仓库分析路径
import WebSocket from 'ws';
import fs from 'fs';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

const BASE = 'http://127.0.0.1:3100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 与 server.js 相同的 Edge TTS 实现（测试脚本独立复制一份）
const EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
function secMsGec() {
  let ticks = (Math.floor(Date.now() / 1000) + 11644473600) * 10000000;
  ticks -= ticks % 3000000000;
  return crypto.createHash('sha256').update(`${ticks}${EDGE_TOKEN}`).digest('hex').toUpperCase();
}
function escapeSml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function edgeTTS(text, voice) {
  return new Promise((resolve, reject) => {
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-131.0.2903.112`;
    const ws = new WebSocket(url, {
      headers: {
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      },
    });
    const chunks = [];
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error('tts timeout')); }, 30000);
    ws.on('open', () => {
      const ts = new Date().toISOString();
      ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } }));
      ws.send(`X-RequestId:${crypto.randomBytes(16).toString('hex')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n` +
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${voice}'><prosody rate='+0%'>${escapeSml(text)}</prosody></voice></speak>`);
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        if (data.toString().includes('Path:turn.end')) { clearTimeout(timer); try { ws.close(); } catch {} resolve(Buffer.concat(chunks)); }
        return;
      }
      try {
        const hdrLen = data.readUInt16BE(0);
        if (data.slice(2, 2 + hdrLen).toString().includes('Path:audio')) chunks.push(data.slice(2 + hdrLen));
      } catch {}
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(new Error('tts ws: ' + e.message)); });
  });
}

async function genSpeech(text) {
  // Google Translate TTS（与 server.js 相同实现）
  const q = encodeURIComponent(text.slice(0, 190));
  const res = await fetch(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&q=${q}&tl=zh-CN`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', Referer: 'https://translate.google.com/' },
  });
  if (!res.ok) throw new Error('gtts ' + res.status);
  const mp3 = Buffer.from(await res.arrayBuffer());
  return { mp3, pcm16: null }; // whisper.cpp 的 miniaudio 可直接解 mp3
}

async function main() {
  console.log('== 1. 健康检查 ==');
  const health = await fetch(BASE + '/');
  console.log('GET / ->', health.status);
  if (!health.ok) throw new Error('server down');

  console.log('== 2. 生成测试语音（模拟候选人说话）==');
  const { mp3, pcm16 } = await genSpeech('面试官你好，我叫张三，三年后端经验，主要用 Go 和 MySQL，做过一个网关系统，QPS 大概两万。');
  fs.writeFileSync('/tmp/test_utt.mp3', mp3);
  console.log('TTS mp3 bytes:', mp3.length, '| pcm16 samples:', pcm16 ? pcm16.length : 'N/A');

  console.log('== 3. 准备会话（简历文本，无 GitHub）==');
  const prep = await fetch(BASE + '/api/prepare', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resumeText: '张三，3 年后端经验。技术栈：Go、MySQL、Redis。项目：API 网关系统，负责限流、熔断、路由模块，QPS 2 万。',
      position: '后端开发工程师', mode: 'project',
    }),
  });
  const pj = await prep.json();
  console.log('prepare ->', prep.status, JSON.stringify(pj).slice(0, 200));
  if (!prep.ok) throw new Error('prepare failed');
  const sid = pj.sid;

  console.log('== 3.5 mp3 -> 16k PCM（模拟麦克风数据）==');
  let pcmBuf = null;
  try {
    execFileSync('ffmpeg', ['-y', '-i', '/tmp/test_utt.mp3', '-f', 's16le', '-ar', '16000', '-ac', '1', '/tmp/test_utt.pcm']);
    pcmBuf = fs.readFileSync('/tmp/test_utt.pcm');
    console.log('pcm bytes:', pcmBuf.length);
  } catch { console.warn('ffmpeg 不可用，退化为文字输入路径'); }

  console.log('== 4. WS 全链路（发语音 -> 等面试官语音回复）==');
  const ws = new WebSocket('ws://127.0.0.1:3100/ws');
  let sentences = 0, audioBytes = 0, transcript = 0, ready = false, replied = false, report = null;
  ws.on('message', (data, isBin) => {
    if (isBin) return;
    const m = JSON.parse(data.toString());
    if (m.type === 'ready') ready = true;
    if (m.type === 'add_transcript') { transcript++; console.log('  [transcript]', m.role, m.text.slice(0, 60)); }
    if (m.type === 'sentence') { sentences++; if (m.audio) audioBytes += m.audio.length; console.log('  [sentence]', m.text.slice(0, 60), m.audio ? `(audio ${m.audio.length})` : '(no audio)'); }
    if (m.type === 'reply_end') replied = true;
    if (m.type === 'report') { report = m; }
    if (m.type === 'error') console.log('  [error]', m.text);
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'init', sid }));
  await sleep(3000); // 等开场白

  if (pcmBuf && pcmBuf.length > 32000) {
    const CH = 3200; // 100ms of 16k s16le
    ws.send(JSON.stringify({ type: 'utt_start' }));
    for (let i = 0; i + CH <= pcmBuf.length; i += CH) {
      ws.send(pcmBuf.subarray(i, i + CH));
    }
    ws.send(JSON.stringify({ type: 'utt_end' }));
  } else {
    console.log('  (无 PCM，走文字输入路径)');
    ws.send(JSON.stringify({ type: 'text_input', text: '我叫张三，三年后端，做过 API 网关，负责限流熔断和路由。' }));
  }

  for (let i = 0; i < 60 && !replied; i++) await sleep(1000);
  console.log(`  sentences=${sentences} audioBytes=${audioBytes} replied=${replied}`);
  if (!replied || sentences === 0) throw new Error('没有收到面试官回复');
  if (audioBytes < 2000) throw new Error('回复没有音频');

  console.log('== 5. 结束面试 -> 复盘报告 ==');
  ws.send(JSON.stringify({ type: 'end_interview' }));
  for (let i = 0; i < 60 && !report; i++) await sleep(1000);
  if (!report) throw new Error('报告未生成');
  console.log('  report markdown length:', report.markdown.length);
  fs.writeFileSync('/tmp/test_report.md', report.markdown);
  ws.close();

  console.log('== 6. GitHub 仓库分析路径 ==');
  const prep2 = await fetch(BASE + '/api/prepare', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ githubUrl: 'jonschlinkert/is-odd', position: 'Node.js 工程师', mode: 'project' }),
  });
  const p2 = await prep2.json();
  console.log('prepare+repo ->', prep2.status, JSON.stringify(p2).slice(0, 300));
  if (!prep2.ok) throw new Error('repo prepare failed');

  console.log('\n✅ E2E ALL PASS');
}

main().catch((e) => { console.error('\n❌ E2E FAIL:', e.message); process.exit(1); });
