// 二分定位：哪个 setup 差异让 gemini-3.8-live 沉默
// variant A: 短prompt + 无压缩（已知可用基线）
// variant B: 长prompt + 无压缩
// variant C: 短prompt + contextWindowCompression
import WebSocket from 'ws';
import fs from 'fs';

const KEY = process.argv[2];
const PCM = fs.readFileSync('/tmp/test_utt.pcm');
const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${KEY}`;

const LONG_PROMPT = `# 角色
你是资深技术面试官林工，正在对候选人进行一对一线上实时语音面试。你说话像真人面试官：简短、直接、口语化、一次只问一个问题。

# 流程
1. 请对方先自我介绍（认真听，记住细节）。
2. 项目深挖（重心）：围绕对方提到的项目逐层追问——业务背景、架构、技术选型理由、难点、踩过的坑、量化结果。
3. 视时间做技术基础与场景题。
4. 最后给反问环节，礼貌收尾。

# 追问纪律（重要）
- 回答含糊、只堆名词、明显在背书时，立刻追问："你刚说 X，具体是怎么实现的？" "为什么选 A 不选 B？" "这块出过什么线上问题？"
- 同一话题最多追问三层；对方连续两次答不上来就自然换话题，不要纠缠。
- 对方答得好就给一句简短肯定（比如"嗯，这块挺清楚"），然后往更深处走。
- 全程记住聊过什么，绝不重复问同一个问题。

# 输出纪律（最重要）
- 你的回复会被 TTS 直接朗读：禁止任何 markdown、列表、emoji、括号标注。
- 单次回复 1~3 句话，一般不超过 60 个字。
- 全程用普通话（对方明确要求换语言除外）。
- 不要自报身份外的寒暄废话，也不要念稿感。`;

function run(variant) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: 15000 });
    const t0 = Date.now();
    const setup = {
      model: 'models/gemini-3.8-live',
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } } },
      systemInstruction: { parts: [{ text: variant === 'B' ? LONG_PROMPT : '你是资深技术面试官林工，用普通话进行一对一实时语音面试。一次只问一个问题，单次回复不超过两句话，口语化。' }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    };
    if (variant === 'C') setup.contextWindowCompression = { slidingWindow: {} };
    let audio = 0, text = '', inT = '', done = false;
    let fed = 0;
    ws.on('open', () => ws.send(JSON.stringify({ setup })));
    ws.on('message', (raw, isBin) => {
      let msg;
      try { msg = JSON.parse((isBin ? Buffer.from(raw) : raw).toString('utf8')); } catch { return; }
      if (msg.setupComplete) {
        // 先让模型打招呼（模拟服务端行为）
        ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: '（候选人已上线，请开始面试）' }] }], turnComplete: true } }));
        setTimeout(() => {
          const iv = setInterval(() => {
            if (fed >= PCM.length) { clearInterval(iv); ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); return; }
            ws.send(JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: PCM.subarray(fed, fed += 3200).toString('base64') } } }));
          }, 60);
        }, 3000); // 先等 3s 看打招呼音频
        return;
      }
      const sc = msg.serverContent;
      if (sc) {
        if (sc.interrupted) text += '[打断]';
        if (sc.inputTranscription?.text) inT += sc.inputTranscription.text;
        if (sc.outputTranscription?.text) text += sc.outputTranscription.text;
        if (sc.modelTurn?.parts) for (const p of sc.modelTurn.parts) if (p.inlineData?.data) audio += p.inlineData.data.length;
        if (sc.turnComplete && audio > 0 && !done) { done = true; console.log(`variant ${variant}: ✅ 音频=${audio} 说="${text.slice(0, 50)}" 听="${inT.slice(0, 30)}" (${((Date.now() - t0) / 1000).toFixed(1)}s)`); ws.close(); resolve(true); }
      }
      if (msg.error) { console.log(`variant ${variant}: ❌ API错误 ${JSON.stringify(msg).slice(0, 200)}`); ws.close(); resolve(false); }
    });
    ws.on('error', (e) => { console.log(`variant ${variant}: ❌ ${e.message}`); resolve(false); });
    setTimeout(() => { if (!done) { console.log(`variant ${variant}: ❌ 超时 音频=${audio} 文本="${text.slice(0, 40)}"`); try { ws.close(); } catch {} resolve(false); } }, 40000);
  });
}

const a = await run('A');
await new Promise((r) => setTimeout(r, 1000));
const b = a ? await run('B') : false;
await new Promise((r) => setTimeout(r, 1000));
const c = b === false || true ? await run('C') : false;
console.log(`\n结论: A基线=${a ? '通' : '断'} B长prompt=${b ? '通' : '断'} C压缩=${c ? '通' : '断'}`);
