// Live 引擎服务端 e2e：init -> engine:live -> 连续灌 PCM -> 期望 live_audio/ai_delta/turn_end -> 文字追问 -> end_interview 报告
import WebSocket from 'ws';
import fs from 'fs';
import { execFileSync } from 'child_process';

const BASE = 'http://127.0.0.1:3100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function genPcm(text) {
  const q = encodeURIComponent(text);
  const res = await fetch(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&q=${q}&tl=zh-CN`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', Referer: 'https://translate.google.com/' },
  });
  const mp3 = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync('/tmp/live_utt.mp3', mp3);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', '/tmp/live_utt.mp3', '-f', 's16le', '-ar', '16000', '-ac', '1', '/tmp/live_utt.pcm']);
  return fs.readFileSync('/tmp/live_utt.pcm');
}

async function main() {
  console.log('== prepare（简历文本）==');
  const prep = await fetch(BASE + '/api/prepare', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resumeText: '张三，3 年后端经验。技术栈：Go、MySQL、Redis。项目：API 网关，负责限流熔断路由，QPS 2 万。', position: '后端开发工程师', mode: 'project' }),
  });
  const pj = await prep.json();
  if (!prep.ok) throw new Error('prepare: ' + JSON.stringify(pj));
  console.log('sid:', pj.sid);

  const ws = new WebSocket('ws://127.0.0.1:3100/ws');
  let engine = null, aiDelta = '', gotAudio = 0, turns = 0, report = null;
  const transcript = [];
  ws.on('message', (data, isBin) => {
    if (isBin) return;
    const m = JSON.parse(data.toString());
    if (m.type === 'engine') { engine = m.engine; console.log('engine:', engine); }
    if (m.type === 'add_transcript') { transcript.push([m.role, m.text]); console.log('  [t]', m.role, m.text.slice(0, 70)); }
    if (m.type === 'ai_delta') aiDelta += m.text;
    if (m.type === 'live_audio') gotAudio += m.audio.length;
    if (m.type === 'turn_end') { turns++; console.log(`  [turn ${turns}] ai音频累计=${gotAudio} ai文本="${aiDelta.slice(0, 60)}"`); aiDelta = ''; }
    if (m.type === 'interrupted') console.log('  [interrupted]');
    if (m.type === 'report') { report = m; }
    if (m.type === 'error') console.log('  [error]', m.text);
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'init', sid: pj.sid }));

  for (let i = 0; i < 25 && !engine; i++) await sleep(200);
  if (engine !== 'live') throw new Error('engine=' + engine + '（期望 live）');

  console.log('== 等开场白说完（turn 1）==');
  for (let i = 0; i < 50 && turns < 1; i++) await sleep(500);
  if (turns < 1) throw new Error('开场白未完成');

  console.log('== 灌入候选人语音（连续流，等 greeting 完后开始）==');
  const pcm = await genPcm('面试官你好，我叫张三，三年后端经验，主要用Go和MySQL，做过一个API网关系统，限流熔断路由都是我负责的。');
  const CH = 3200;
  for (let i = 0; i + CH <= pcm.length; i += CH) {
    ws.send(pcm.subarray(i, i + CH));
    await sleep(60); // ≈1.7x 实时
  }
  await sleep(300); // 尾音
  // 关键：Live 的自动 VAD 需要持续音频流（含静音）才能判定说完——模拟麦克风的静音帧
  const sil = Buffer.alloc(CH);
  for (let i = 0; i < 30; i++) { ws.send(sil); await sleep(30); }
  const before = turns;
  for (let i = 0; i < 40 && turns < before + 1; i++) await sleep(500);
  if (!gotAudio) throw new Error('没有收到 live_audio');
  const userTurns = transcript.filter(([r]) => r === 'user').length;
  console.log('语音回复字节数(b64):', gotAudio, '| 用户转写条数:', userTurns);
  if (!userTurns) throw new Error('用户语音没有被转写入档');

  console.log('== 文字追问一轮 ==');
  const b2 = turns;
  ws.send(JSON.stringify({ type: 'text_input', text: '我们的限流用的是令牌桶，Redis + Lua 实现的。' }));
  for (let i = 0; i < 40 && turns < b2 + 1; i++) await sleep(500);
  if (turns < b2 + 1) throw new Error('文字追问没有得到回复');

  console.log('== 结束面试 ==');
  ws.send(JSON.stringify({ type: 'end_interview' }));
  for (let i = 0; i < 60 && !report; i++) await sleep(1000);
  if (!report) throw new Error('报告未生成');
  console.log('report len:', report.markdown.length, '| 含总分:', /总分[：:]\s*\d+/.test(report.markdown));
  ws.close();
  console.log('\n✅ LIVE E2E PASS');
}

main().catch((e) => { console.error('\n❌ LIVE E2E FAIL:', e.message); process.exit(1); });
