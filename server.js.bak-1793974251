/*
 * AI 实时语音模拟面试服务
 * 链路：浏览器麦克风(PCM16/16k) --WS--> 能量VAD分句 --> whisper.cpp(STT)
 *      --> LLM 面试官(glm-5.3-flash 流式) --> 按句 TTS(msedge-tts) --> 浏览器播放
 * 支持：简历上传(PDF/TXT/MD)、GitHub 仓库克隆+代码分析档案、打断(barge-in)、复盘报告
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');
const pdfParse = require('pdf-parse');
const { marked } = require('marked');

const CFG = {
  port: Number(process.env.PORT || 3100),
  llmBase: process.env.LLM_BASE || 'https://isoloveyou.kdns.fr/v1',
  llmKey: process.env.LLM_KEY || '',
  llmModel: process.env.LLM_MODEL || 'cn:glm-5.3-flash',
  whisperUrl: process.env.WHISPER_URL || 'http://127.0.0.1:8081/inference',
  ttsVoice: process.env.TTS_VOICE || 'zh-CN-YunxiNeural', // 男声面试官（cascade 兜底用）
  geminiKey: process.env.GEMINI_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-live',
  geminiVoice: process.env.GEMINI_VOICE || 'Charon', // Live 引擎男声
  maxUtteranceBytes: 16000 * 2 * 35, // 35 秒上限
  interviewMinutes: Number(process.env.INTERVIEW_MINUTES || 15), // 单场面试上限（分钟）
};

// ---------------- 会话 ----------------
const sessions = new Map(); // sid -> session

// ---------------- 轻量限流（Caddy 反代，取 X-Forwarded-For 首个 IP） ----------------
const rateBuckets = new Map();
let prepBusy = 0;
function clientIp(req) {
  const xff = String((req && req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return xff || (req && req.socket && req.socket.remoteAddress) || 'unknown';
}
function allow(key, limit, windowMs) {
  const now = Date.now();
  const rec = rateBuckets.get(key);
  if (!rec || now - rec.ts > windowMs) { rateBuckets.set(key, { n: 1, ts: now }); return true; }
  rec.n += 1;
  return rec.n <= limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now - v.ts > 3600000) rateBuckets.delete(k);
  for (const [sid, s] of sessions) if (!s.ws && now - s.createdAt > 3 * 3600000) sessions.delete(sid);
}, 10 * 60 * 1000).unref();

function newSession(payload) {
  const sid = crypto.randomBytes(4).toString('hex');
  const s = {
    sid,
    createdAt: Date.now(),
    position: (payload.position || '后端开发工程师').slice(0, 60),
    jd: (payload.jd || '').slice(0, 4000),
    mode: payload.mode === 'comprehensive' ? 'comprehensive' : 'project',
    style: payload.style === 'code' ? 'code' : 'real',
    resumeText: payload.resumeText || '',
    githubUrl: payload.githubUrl || '',
    dossier: payload.dossier || null,
    systemPrompt: '',
    greeting: '',
    transcript: [],
    ws: null,
    audioChunks: [],
    inUtterance: false,
    busy: false,
    abort: null,
    tts: null,
    ttsChain: Promise.resolve(),
    interviewDone: false,
  };
  sessions.set(sid, s);
  return s;
}

// ---------------- 工具 ----------------
function pcmToWav(pcm, sampleRate = 16000) {
  const b = Buffer.alloc(44 + pcm.length);
  b.write('RIFF', 0); b.writeUInt32LE(36 + pcm.length, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(pcm.length, 40);
  pcm.copy(b, 44);
  return b;
}

async function stt(wavBuf) {
  const fd = new FormData();
  fd.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'utt.wav');
  fd.append('response_format', 'json');
  // 领域提示词，缓解英文技术名词识别（whisper initial prompt）
  fd.append('prompt', '普通话面试对话，涉及后端开发术语：Go、Golang、Java、MySQL、Redis、Kafka、RabbitMQ、Docker、Kubernetes、Linux、Nginx、API、QPS、微服务、消息队列、索引、事务、分布式。');
  const res = await fetch(CFG.whisperUrl, { method: 'POST', body: fd });
  if (!res.ok) throw new Error('STT ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  return (j.text || '').trim();
}

async function llmStream(messages, onText, signal) {
  const res = await fetch(CFG.llmBase + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CFG.llmKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CFG.llmModel, messages, stream: true, max_tokens: 400, temperature: 0.7 }),
    signal,
  });
  if (!res.ok) throw new Error('LLM ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const d = JSON.parse(data).choices?.[0]?.delta;
        // glm 系列会先吐 reasoning_content，跳过，只要正文
        if (d && typeof d.content === 'string' && d.content) { full += d.content; onText(d.content); }
      } catch {}
    }
  }
  return full;
}

async function llmComplete(messages, opts = {}) {
  const res = await fetch(CFG.llmBase + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CFG.llmKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CFG.llmModel, messages,
      max_tokens: opts.maxTokens || 2000, temperature: opts.temperature ?? 0.4,
    }),
  });
  if (!res.ok) throw new Error('LLM ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content || '';
  if (!content) console.log('[llm] 空返回 finish=' + j.choices?.[0]?.finish_reason + ' usage=' + JSON.stringify(j.usage || {}).slice(0, 160));
  return content;
}

// ---------------- TTS：Google Translate TTS（免费无密钥；失败时前端 speechSynthesis 兜底） ----------------
const GTTS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function ttsSpeak(session, text) {
  const q = encodeURIComponent(text.slice(0, 190));
  const res = await fetch(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&q=${q}&tl=zh-CN`, {
    headers: { 'User-Agent': GTTS_UA, Referer: 'https://translate.google.com/' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('tts http ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) throw new Error('tts empty response');
  return buf;
}

// 按句切分 TTS 并下发；串行化避免同一会话并发握手；seq 机制保证打断后不再发旧句
function enqueueSentence(session, text) {
  const seq = session.replySeq || 0;
  session.ttsChain = session.ttsChain.then(async () => {
    if ((session.replySeq || 0) !== seq) return;
    try {
      const audio = await ttsSpeak(session, text);
      if ((session.replySeq || 0) !== seq) return;
      session.ws?.send(JSON.stringify({ type: 'sentence', text, audio: audio.toString('base64') }));
  } catch (e) {
      console.error('[tts]', e.message);
      if ((session.replySeq || 0) === seq) {
        session.ws?.send(JSON.stringify({ type: 'sentence', text })); // 无音频 -> 前端走本地合成兜底
      }
    }
  }).catch(() => {});
}

function splitSentences(buffer) {
  // 按中英文标点切句，保留标点
  const parts = buffer.split(/(?<=[。！？!?；;\n])/);
  return parts;
}

// ---------------- GitHub 仓库分析 ----------------
function collectRepoText(dir) {
  const skipDir = /node_modules|^\.$|^\.\.$|\.git$|dist$|build$|\.next$|target$|venv$|__pycache__|\.venv$|\.idea$|vendor$/;
  const skipExt = /\.(png|jpe?g|gif|ico|svg|webp|woff2?|ttf|eot|otf|mp4|mp3|wav|zip|gz|tar|pdf|lock|bin|exe|dll|so|dylib|class|jar|pyc|pdb|db|sqlite)$/i;
  const out = [];
  let total = 0;
  const MAX_FILES = 120, MAX_FILE = 120 * 1024, MAX_TOTAL = 700 * 1024;
  (function walk(d, depth) {
    if (out.length >= MAX_FILES || total >= MAX_TOTAL || depth > 8) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    // 优先浅层文件
    ents.sort((a, b) => (a.isDirectory() ? 1 : 0) - (b.isDirectory() ? 1 : 0));
    for (const e of ents) {
      if (out.length >= MAX_FILES || total >= MAX_TOTAL) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!skipDir.test(e.name)) walk(p, depth + 1); continue; }
      if (skipExt.test(e.name) || e.name.startsWith('.')) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.size > MAX_FILE) continue;
      let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (txt.includes('\u0000')) continue;
      total += txt.length;
      out.push('### 文件: ' + path.relative(dir, p) + '\n```\n' + txt.slice(0, MAX_FILE) + '\n```');
    }
  })(dir, 0);
  return out.join('\n\n');
}

function parseRepoUrl(input) {
  let s = (input || '').trim();
  if (!s) return null;
  const m = s.match(/(?:github\.com[/:])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/|$)/);
  if (m) return `https://github.com/${m[1]}/${m[2]}.git`;
  const m2 = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (m2) return `https://github.com/${m2[1]}/${m2[2]}.git`;
  return null;
}

function dossierPrompt(repoText, codeMode) {
  if (codeMode) {
    return '你是技术面试官的助手。下面是一位候选人的 GitHub 仓库的真实代码。请通读后输出**只含 JSON**（不要 markdown 代码块以外内容）的分析档案：\n{\n  "projectSummary": "这个仓库是做什么的、整体架构、用到的技术栈（150字内）",\n  "highlights": ["代码里真实存在的技术亮点/难点，3-5条"],\n  "deepDive": [{"q": "值得当面深挖的问题", "why": "为什么问（对应哪个文件/设计）", "expected": "真做过的人应该能答出的要点"}],\n  "traps": ["如果候选人没真做过，容易露馅的追问点，3-5条"]\n}\ndeepDive 给 6-8 个问题，按含金量排序。要引用具体文件名/模块名，让问题有真实感。仓库代码：\n' + repoText;
  }
  return '你是面试官的助手。下面是候选人 GitHub 仓库的真实代码，请写一份"面谈前速记"，只输出 JSON（不要代码块以外的内容）：\n{\n  "projectSummary": "这个仓库解决什么业务问题、业务定位、技术栈，说人话，120字内",\n  "highlights": ["3-4 条值得当面聊的技术点（业务/架构层面）"],\n  "topics": [{"t": "值得验证的话题", "why": "为什么值得问（业务或风险角度）", "expect": "真做过的人能说出哪些具体内容"}],\n  "traps": ["容易注水的说法，3 条以内"]\n}\ntopics 给 3-5 个，全部用业务和架构语言，禁止出现任何文件名、函数名、行号。仓库代码：\n' + repoText;
}
async function buildDossier(session, repoText) {
  const codeMode = session.style === 'code';
  const first = codeMode ? repoText.slice(0, 80000) : repoText.slice(0, 40000);
  const second = codeMode ? repoText.slice(0, 40000) : repoText.slice(0, 20000);
  const ask = (text) => llmComplete([{ role: 'user', content: dossierPrompt(text, codeMode) }], { maxTokens: 8000, temperature: 0.3 });
  const full = await ask(first);
  if (String(full || '').trim()) return full;
  console.log("[dossier] 空返回，降量重试");
  return ask(second);
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('no json');
  return JSON.parse(raw.slice(start, end + 1));
}

// ---------------- 面试官 prompt ----------------
function buildSystemPrompt(session) {
  const style = session.style === 'code' ? 'code' : 'real';
  const head = style === 'code'
    ? '你是一位资深' + session.position + '岗位的技术面试官，正在对候选人进行一对一线上实时语音面试。你说话自然、直接、干练，像真人面试官：一次只问一个问题，问题口语化（一般不超过 40 字），不啰嗦，不说客套废话。'
    : '你是一位资深' + session.position + '岗位的面试官，正在进行一对一技术面试。你手里只有候选人的简历和一个项目的简要介绍——你没看过他的代码，也不需要假装看过。你的判断方式：靠追问逻辑和常识，不靠代码细节。';
  const modeDesc = style === 'code'
    ? (session.mode === 'comprehensive'
      ? '流程：开场请对方自我介绍 → 项目深挖（重点，占一半以上时间）→ 技术基础 → 场景题 → 反问环节 → 礼貌收尾。'
      : '流程：开场请对方自我介绍 → 围绕 GitHub 项目逐层深挖（这是本次面试的全部重心）→ 反问环节 → 礼貌收尾。')
    : (session.mode === 'comprehensive'
      ? '流程：开场一两句招呼，请对方介绍自己和最有代表性的项目 → 项目业务与角色 → 选型取舍 → 规模与线上故障 → 技术基础 → 场景题 → 反问 → 礼貌收尾。'
      : '流程：开场一两句招呼，请对方介绍自己和最有代表性的项目 → 项目业务与角色 → 选型取舍 → 规模与线上故障 → 顺着技术点往下问一层原理 → 反问 → 礼貌收尾。');
  const discipline = style === 'code'
    ? ['追问纪律（重要）：',
       '- 候选人回答含糊、只堆名词没有细节、或明显在背书时，立刻追问："你刚才说 X，具体是怎么实现的？" / "为什么选 A 不选 B？" / "这里出过什么问题？"',
       '- 同一个话题最多追问 3 层，对方连续两次答不上来就自然换话题，不要纠缠。',
       '- 候选人答得很好就给一句简短肯定（"嗯，这块挺清楚"），然后往更深处或下一块走。',
       '- 简历和项目档案是你的弹药库：深挖时基于档案里的真实事实提问（可以点名具体文件/模块/设计决策），测试对方是否真懂。',
       '- 全程记住你说过什么，不要重复问同一个问题。'].join('\n')
    : ['追问纪律：',
       '- 说得含糊（只有名词没有细节、只有结果没有过程）就追一层："具体怎么做的" / "当时为什么这么定" / "出过什么问题"。',
       '- 同一话题最多追 3 层，对方连续两次答不上来就自然换话题，不要纠缠。',
       '- 答得好简短肯定一句（"嗯，这块挺清楚"），再往深处或下一块走。',
       '- 全程记住你说过什么，不要重复问同一个问题。',
       '',
       '边界（重要）：',
       '- 不提文件名、函数名、行号，不说"我看到你代码里……"，你确实没看过。',
       '- 简历和简介里没有的具体数字和细节不要替对方编，用开放问法让他自己说。',
       '- 不背八股：问了也要贴着项目场景问。'].join('\n');
  const output = '输出纪律（重要）：你的回复会被直接朗读成语音——禁止任何 markdown 符号、列表、emoji、括号标注；单次回复一般 1~3 句话，不超过 80 字。';
  let p = [head, modeDesc, discipline, output].join('\n\n');

  if (session.resumeText) p += '\n\n【候选人简历】\n' + session.resumeText.slice(0, 8000);
  if (session.jd) p += '\n\n【岗位 JD】\n' + session.jd;
  if (session.dossier) {
    const d = session.dossier;
    if (style === 'code') {
      p += '\n\n【GitHub 项目档案（来自对其仓库真实代码的分析，深挖弹药）】\n项目：' + (d.projectSummary || '') +
        '\n亮点：' + JSON.stringify(d.highlights || []) +
        '\n深挖问题（按序使用，用完即止）：' + JSON.stringify(d.deepDive || []) +
        '\n露馅点：' + JSON.stringify(d.traps || []);
    } else {
      p += '\n\n【项目速记（你事先做的功课，只用于判断对方说的是真是假，绝对不要念给候选人听）】\n项目：' + (d.projectSummary || '') +
        '\n值得聊的技术点：' + JSON.stringify(d.highlights || []) +
        '\n值得验证的话题：' + JSON.stringify(d.topics || []) +
        '\n容易注水的说法：' + JSON.stringify(d.traps || []);
    }
  }
  return p;
}

// ---------------- Gemini Live 实时引擎（端到端语音，sub-second） ----------------
const WebSocketLib = require('ws');

function liveUrl() {
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${CFG.geminiKey}`;
}

function flushUserTurn(session, late) {
  const t = (session.live.inText || '').trim();
  if (!t) return; // 没内容就什么都不做，避免把"已发过"的标记提前置位
  session.live.inText = '';
  session.live.userFlushed = true;
  const entry = { role: 'user', text: t, t: Date.now() };
  if (late) {
    // 转写比 AI 回复晚到：在转写记录里插到最后一条 AI 之前，保证问答顺序正确
    let i = session.transcript.length - 1;
    while (i >= 0 && session.transcript[i].role !== 'ai') i--;
    if (i >= 0) session.transcript.splice(i, 0, entry); else session.transcript.push(entry);
  } else {
    session.transcript.push(entry);
  }
  session.ws?.send(JSON.stringify({ type: 'add_transcript', role: 'user', text: t, insertBeforeAi: !!late }));
  console.log('[live] 用户转写 ' + t.length + ' 字' + (late ? '（迟到）' : '') + ' sid=' + session.sid);
}

function liveSendText(session, text) {
  session.live?.ws?.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }));
}

function startLive(session) {
  const lws = new WebSocketLib(liveUrl(), { handshakeTimeout: 15000 });
  session.live = { ws: lws, ready: false, inText: '', outText: '', userFlushed: false, reconnects: 0, closed: false };
  const readyTimer = setTimeout(() => {
    if (!session.live.ready) {
      console.error('[live] setup 超时，降级 cascade');
      session.live.closed = true;
      try { lws.close(); } catch {}
      downgradeToCascade(session);
    }
  }, 12000);

  lws.on('open', () => {
    lws.send(JSON.stringify({
      setup: {
        model: `models/${CFG.geminiModel}`,
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: CFG.geminiVoice } } } },
        systemInstruction: { parts: [{ text: session.systemPrompt }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
      },
    }));
  });

  lws.on('message', (raw, isBin) => {
    let msg;
    try { msg = JSON.parse((isBin ? Buffer.from(raw) : raw).toString('utf8')); } catch { console.log('[live] non-json frame', String(raw).slice(0, 80)); return; }
    if (msg.setupComplete) {
      console.log('[live] setupComplete sid=' + session.sid);
      clearTimeout(readyTimer);
      session.live.ready = true;
      session.engine = 'live';
      session.ws?.send(JSON.stringify({ type: 'engine', engine: 'live' }));
      if (session.reconnectIntro) {
        liveSendText(session, '（连接恢复。以下是此前的面试记录，请无缝接着面，不要重复问过的问题：\n' +
          session.transcript.slice(-16).map((t) => (t.role === 'ai' ? '面试官：' : '候选人：') + t.text).join('\n').slice(-4000) + '）');
        session.reconnectIntro = false;
      } else {
        liveSendText(session, '（候选人刚刚上线坐好，设备就绪。请开始面试：一句简短打招呼，然后请对方自我介绍。）');
      }
      return;
    }
    const sc = msg.serverContent;
    if (!sc) {
      if (msg.error) console.error('[live]', JSON.stringify(msg).slice(0, 200));
      else {
        const keys = Object.keys(msg).filter((k) => k !== 'usageMetadata').join(',');
        if (keys && !/voiceActivity|usageMetadata/.test(keys)) console.log('[live] 其他消息:', keys);
      }
      return;
    }
    if (sc.interrupted) {
      // 模型被用户打断：作废当前输出，通知前端停播
      session.live.outText = '';
      session.live.aiOpen = false;
      session.ws?.send(JSON.stringify({ type: 'interrupted' }));
    }
    if (sc.inputTranscription?.text) session.live.inText += sc.inputTranscription.text;
    // 模型开口 = 这一轮用户说完了：先把用户转写发出去，保证气泡顺序在 AI 回复之前
    if (sc.modelTurn?.parts) {
      flushUserTurn(session);
      for (const p of sc.modelTurn.parts) {
        const d = p.inlineData?.data;
        if (d) session.ws?.send(JSON.stringify({ type: 'live_audio', audio: d }));
      }
    }
    if (sc.outputTranscription?.text) {
      session.live.outText += sc.outputTranscription.text;
      session.live.aiOpen = true;
      session.ws?.send(JSON.stringify({ type: 'ai_delta', text: sc.outputTranscription.text }));
    }
    if (sc.turnComplete) {
      flushUserTurn(session);
      // 转写偶尔比 turnComplete 晚到，兜一次底
      setTimeout(() => { if (session.live && !session.live.closed) flushUserTurn(session, true); }, 700);
      session.live.userFlushed = false;
      const ai = session.live.outText.trim();
      session.live.outText = '';
      session.live.aiOpen = false;
      if (ai) session.transcript.push({ role: 'ai', text: ai, t: Date.now() });
      session.ws?.send(JSON.stringify({ type: 'turn_end' }));
    }
  });

  lws.on('close', (code, reason) => {
    clearTimeout(readyTimer);
    console.log(`[live] ws closed sid=${session.sid} code=${code} reason=${String(reason).slice(0, 100)} ready=${session.live.ready}`);
    if (session.live.closed) return;
    if (session.live.reconnects < 3 && !session.interviewDone) {
      session.live.reconnects++;
      session.reconnectIntro = true;
      console.log(`[live] 连接断开，1.5s 后重连（第 ${session.live.reconnects} 次）`);
      setTimeout(() => startLive(session), 1500);
    } else {
      session.engine = 'cascade';
      session.ws?.send(JSON.stringify({ type: 'engine', engine: 'cascade' }));
    }
  });
  lws.on('error', (e) => console.error('[live ws]', e.message));
}

function downgradeToCascade(session) {
  session.engine = 'cascade';
  session.ws?.send(JSON.stringify({ type: 'engine', engine: 'cascade' }));
  if (session.greeting) {
    session.transcript.push({ role: 'ai', text: session.greeting, t: Date.now() });
    session.ws?.send(JSON.stringify({ type: 'add_transcript', role: 'ai', text: session.greeting }));
    enqueueSentence(session, session.greeting);
  }
}

// ---------------- 语音回复主流程（cascade 引擎） ----------------
async function replyFromText(session, userText, sourceLabel) {
  if (session.busy) return;
  session.busy = true;
  session.replySeq = (session.replySeq || 0) + 1;
  session.ws?.send(JSON.stringify({ type: 'status', text: '面试官思考中…' }));
  const start = Date.now();
  try {
    session.transcript.push({ role: 'user', text: userText, t: Date.now() });
    session.ws?.send(JSON.stringify({ type: 'add_transcript', role: 'user', text: userText }));
    session.abort = new AbortController();
    const messages = [
      { role: 'system', content: session.systemPrompt },
      ...session.transcript.slice(-24).map((t) => ({ role: t.role === 'ai' ? 'assistant' : 'user', content: t.text })),
    ];
    let buf = '';
    const full = await llmStream(messages, (delta) => {
      buf += delta;
      const parts = splitSentences(buf);
      // 最后一段可能没说完，留在缓冲
      buf = parts.pop() || '';
      for (const sent of parts) {
        const s = sent.trim();
        if (s.length >= 4) enqueueSentence(session, s);
      }
    }, session.abort.signal);
    const tail = buf.trim();
    const seq = session.replySeq;
    if (tail.length >= 4 && session.replySeq === seq) enqueueSentence(session, tail);
    if (session.replySeq === seq) {
      session.transcript.push({ role: 'ai', text: full.trim() || tail, t: Date.now() });
    }
    console.log(`[reply] sid=${session.sid} src=${sourceLabel} llm=${Date.now() - start}ms`);
  } catch (e) {
    if (e.name === 'AbortError') {
      session.aborted = true; // barge 已发过 reply_end
    } else {
      console.error('[reply]', e.message);
      session.ws?.send(JSON.stringify({ type: 'error', text: '面试官开小差了：' + e.message.slice(0, 120) }));
    }
  } finally {
    session.busy = false;
    session.abort = null;
    if (!session.aborted) session.ws?.send(JSON.stringify({ type: 'reply_end' }));
    session.aborted = false;
    session.ws?.send(JSON.stringify({ type: 'status', text: '' }));
  }
}

async function handleUtteranceEnd(session) {
  if (!session.inUtterance) return;
  session.inUtterance = false;
  const pcm = Buffer.concat(session.audioChunks);
  session.audioChunks = [];
  if (pcm.length < 16000) return; // <0.5s 当噪音丢弃
  if (session.busy) { session.ws?.send(JSON.stringify({ type: 'status', text: '等面试官说完…' })); return; }
  session.ws?.send(JSON.stringify({ type: 'status', text: '识别中…' }));
  try {
    const text = await stt(pcmToWav(pcm));
    console.log(`[stt] sid=${session.sid} "${text}" (${(pcm.length / 32000).toFixed(1)}s)`);
    if (!text) { session.ws?.send(JSON.stringify({ type: 'status', text: '没听清，请再说一遍' })); return; }
    await replyFromText(session, text, 'voice');
  } catch (e) {
    console.error('[stt]', e.message);
    session.ws?.send(JSON.stringify({ type: 'error', text: '语音识别失败：' + e.message.slice(0, 120) }));
  }
}

// ---------------- REST ----------------
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
    return;
  }
  if (req.method === 'POST' && req.url === '/api/prepare') {
    const ip = clientIp(req);
    if (!allow('prep:' + ip, 10, 10 * 60 * 1000)) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '准备请求太频繁，请 10 分钟后再试' }));
      return;
    }
    if (prepBusy >= 2) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '服务器正在处理另一场准备，稍等半分钟再试' }));
      return;
    }
    prepBusy += 1;
    res.on('close', () => { prepBusy = Math.max(0, prepBusy - 1); });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 15 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        // 简历
        if (payload.resumeBase64 && payload.resumeName) {
          const buf = Buffer.from(payload.resumeBase64, 'base64');
          const name = payload.resumeName.toLowerCase();
          if (name.endsWith('.pdf')) {
            const j = await pdfParse(buf);
            payload.resumeText = (j.text || '').replace(/\n{3,}/g, '\n\n').slice(0, 12000);
          } else {
            payload.resumeText = buf.toString('utf8').slice(0, 12000);
          }
        }
        if (!payload.resumeText && !payload.githubUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '至少提供简历或 GitHub 仓库之一' }));
          return;
        }
        const session = newSession(payload);
        // GitHub 仓库分析
        if (payload.githubUrl) {
          const url = parseRepoUrl(payload.githubUrl);
          if (!url) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'GitHub 地址没看懂，试试 owner/repo 或完整链接' })); return; }
          const tmp = path.join(os.tmpdir(), 'repo-' + session.sid);
          await new Promise((resolve, reject) => {
            execFile('git', ['clone', '--depth', '1', url, tmp], {
              env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 90000,
            }, (err, so, se) => {
              if (!err) return resolve();
              if (err.code === 'ENOENT') return reject(new Error('服务器未安装 git，无法克隆仓库'));
              const msg = String(se) || String(err.message || '未知错误');
              if (/could not read Username|Authentication failed|not found/i.test(msg)) {
                reject(new Error('仓库不存在或不是公开仓库（私有仓库需要先公开，或配置 GitHub Token）'));
              } else {
                reject(new Error('clone 失败: ' + msg.slice(0, 200)));
              }
            });
          });
          try {
            const repoText = collectRepoText(tmp);
            if (!repoText) throw new Error('仓库里没找到可读的代码文件');
            session.repoText = repoText.slice(0, 80000); // 面试后答疑用
            try {
              const raw = await buildDossier(session, repoText);
              session.dossier = extractJson(raw);
              console.log('[dossier] ok repo=' + repoText.length + ' chars');
            } catch (e) {
              // 模型不支持长上下文/输出被截断时，不要卡死整个准备流程
              console.log('[dossier] 分析失败，跳过项目档案：' + e.message.slice(0, 120));
              session.dossier = null;
            }
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
          }
        }
        session.systemPrompt = buildSystemPrompt(session);
        // 开场白
        session.greeting = (await llmComplete([
        { role: 'system', content: session.systemPrompt },
        { role: 'user', content: '（候选人刚刚上线坐好，请开始面试：一句简短的打招呼 + 请对方先做个自我介绍。直接输出要说的话。）' },
      ], { maxTokens: 150, temperature: 0.8 })).trim();
        const summary = session.dossier ? `项目分析完成：${session.dossier.projectSummary || ''}` : (session.resumeText ? '简历解析完成' : '');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ sid: session.sid, summary }));
    } catch (e) {
        console.error('[prepare]', e);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message.slice(0, 300) }));
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/ask') {
    const ip = clientIp(req);
    if (!allow('ask:' + ip, 30, 60 * 60 * 1000)) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '提问太频繁了，歇一会儿再问' }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const s = sessions.get(String(payload.sid || ''));
        const q = String(payload.question || '').trim().slice(0, 800);
        if (!s) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: '会话已过期，重新准备一场就能再问' })); return; }
        if (!q) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: '问题不能为空' })); return; }
        const answer = await llmComplete([
          { role: 'system', content: tutorPrompt(s, q) },
          { role: 'user', content: q },
        ], { maxTokens: 2500, temperature: 0.3 });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ answer }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '回答失败：' + String(e.message).slice(0, 160) }));
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/api/session/')) {
    const s = sessions.get(req.url.slice('/api/session/'.length));
    if (!s) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'session not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      sid: s.sid,
      position: s.position,
      mode: s.mode,
      style: s.style,
      resumeChars: (s.resumeText || '').length,
      githubRepo: s.githubUrl ? (parseRepoUrl(s.githubUrl) || '').replace('https://github.com/', '').replace(/\.git$/, '') : '',
      dossier: s.dossier,
    }));
    return;
  }
  res.writeHead(404); res.end();
});

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ server, path: '/ws' });

async function generateReport(session) {
  if (session.reporting) return;
  session.reporting = true;
  const ws = session.ws;
  const send = (o) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch {} };
  try {
    send({ type: 'status', text: '生成复盘报告…' });
    const transcriptText = session.transcript
      .map((t) => (t.role === 'ai' ? '面试官：' : '候选人：') + t.text).join('\n');
    const md = await llmComplete([
      { role: 'system', content: '你是面试复盘助手。严格按以下格式输出：第一行只写 `总分：X/100`；第二行只写 `技术深度：X/100，表达清晰：X/100，抗追问：X/100，项目真实感：X/100`；空一行后输出 markdown 复盘报告正文：# 模拟面试复盘报告，包含 总体评价(一段话)、亮点(列表)、暴露的问题(列表，具体到哪句话暴露了什么)、逐题点评(按问答顺序，每条一行：**问：**问题原文 → **答：**候选人回答要点 → **评分：**X/10 → **更好的答法：**一句可直接套用的示范)、改进建议(列表，给出可以直接用的更好答法示例)、面试官追问点回顾(列表)。全部用中文，直接给候选人看，客观但直接。' },
      { role: 'user', content: transcriptText.slice(0, 20000) },
    ], { maxTokens: 2500, temperature: 0.4 });
    send({ type: 'report', markdown: md, html: marked.parse(md) });
  } catch (e) {
    send({ type: 'error', text: '报告生成失败：' + e.message.slice(0, 120) });
    send({ type: 'report_failed' });
  } finally {
    session.reporting = false;
  }
}

async function finishInterview(session, reason) {
  if (!session || session.interviewDone) return;
  session.interviewDone = true;
  clearTimeout(session.maxTimer);
  const ws = session.ws;
  const send = (o) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch {} };
  if (reason === 'timeup') send({ type: 'timeup' });

  const genReport = () => generateReport(session);

  const farewell = reason === 'timeup'
    ? '（时间到了，面试必须结束。请用一两句话礼貌收尾，不要提问。）'
    : '（候选人申请结束面试。请用一两句话礼貌收尾道别，不要再提问。）';
  if (session.engine === 'live' && session.live?.ws && session.live.ready) {
    session.live.closed = true;
    liveSendText(session, farewell);
    setTimeout(async () => {
      try { session.live.ws?.close(); } catch {}
      await genReport();
    }, 6000);
  } else {
    await genReport();
  }
}

wss.on('connection', (ws, req) => {
  if (!allow('ws:' + clientIp(req), 60, 60 * 1000)) { try { ws.close(1013, 'too many'); } catch {} return; }
  let session = null;
  ws.on('message', async (data, isBinary) => {
    try {
      if (isBinary) {
        if (!session) return;
        if (session.engine === 'live') {
          // Live 模式：连续音频流直通 Gemini（它自己做 VAD 和打断）
          if (session.live?.ready) {
            session.live.fwd = (session.live.fwd || 0) + 1;
            if (session.live.fwd === 1 || session.live.fwd % 100 === 0) console.log(`[live] 已转发 ${session.live.fwd} 帧音频 sid=${session.sid}`);
            session.live.ws?.send(JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: Buffer.from(data).toString('base64') } } }));
          } else {
            console.log('[live] 丢弃音频帧（live 未 ready）sid=' + session.sid);
          }
          return;
        }
        if (!session.inUtterance) return;
        if (session.audioChunks.reduce((a, b) => a + b.length, 0) > CFG.maxUtteranceBytes) return;
        session.audioChunks.push(Buffer.from(data));
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.type === 'init') {
        session = sessions.get(msg.sid);
        if (!session) { ws.send(JSON.stringify({ type: 'error', text: '会话不存在，请重新准备' })); return; }
        session.ws = ws;
        session.engine = CFG.geminiKey ? 'live' : 'cascade';
        if (!session.maxTimer) session.maxTimer = setTimeout(() => finishInterview(session, 'timeup'), CFG.interviewMinutes * 60 * 1000);
        ws.send(JSON.stringify({ type: 'ready', position: session.position, mode: session.mode, engine: session.engine, minutes: CFG.interviewMinutes }));
        if (session.engine === 'live') {
          startLive(session); // setupComplete 后由它推 engine/live 消息并开场
        } else {
          // 开场
          setTimeout(async () => {
            if (session.greeting) {
              session.transcript.push({ role: 'ai', text: session.greeting, t: Date.now() });
              ws.send(JSON.stringify({ type: 'add_transcript', role: 'ai', text: session.greeting }));
              enqueueSentence(session, session.greeting);
            }
          }, 600);
        }
        return;
      }
      if (!session) return;
      switch (msg.type) {
        case 'utt_start':
          if (session.engine !== 'live' && !session.inUtterance) {
            session.inUtterance = true;
            session.audioChunks = [];
          }
          break;
        case 'utt_end':
          if (session.engine !== 'live') await handleUtteranceEnd(session);
          break;
        case 'barge':
          if (session.engine !== 'live') {
            // cascade 打断：seq 递增让排队中的 TTS 全部作废，同时掐掉 LLM
            session.replySeq = (session.replySeq || 0) + 1;
            if (session.abort) { try { session.abort.abort(); } catch {} }
            ws.send(JSON.stringify({ type: 'reply_end', aborted: true }));
          }
          break;
        case 'text_input': {
          const t = String(msg.text || '').slice(0, 2000);
          if (session.engine === 'live') liveSendText(session, t);
          else await replyFromText(session, t, 'text');
          break;
        }
        case 'end_interview':
          await finishInterview(session, 'manual');
          break;
        case 'gen_report':
          await generateReport(session);
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
      }
  } catch (e) {
      console.error('[ws]', e.message);
    }
  });
  ws.on('close', () => {
    if (!session) return;
    session.ws = null;
    if (session.live) { session.live.closed = true; try { session.live.ws?.close(); } catch {} }
  });
});

server.listen(CFG.port, '127.0.0.1', () => {
  console.log(`[ai-interview] listening on 127.0.0.1:${CFG.port}`);
});
