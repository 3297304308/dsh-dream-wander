// 走神模块：双触发（休眠发生/独处满 X 分钟）+ 概率判定 + 生成 + 文档写入 + 词频回流
// 设计约定 v22 四节。

import fs from 'node:fs';
import { localDay } from './store.js';

// 复读判定阈值：归一化（去空白）后按字符 bigram 的 Dice 系数算相似度；
// 0.85 = 改一两个字仍算复读（"完全一样"当然算），调低会更严格、调高更宽松
const DUP_SIMILARITY = 0.85;

const normWander = (t) => String(t ?? '').replace(/\s+/g, '').trim();

function bigrams(str) {
  const out = [];
  for (let i = 0; i < str.length - 1; i++) out.push(str.slice(i, i + 2));
  return out;
}

// 两句走神是否算"复读"：完全一样，或 Dice 相似度 ≥ 阈值（句子太短不按相似度判，防误杀）
export function isSimilarWander(a, b, threshold = DUP_SIMILARITY) {
  const na = normWander(a);
  const nb = normWander(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length < 6 || nb.length < 6) return false;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  const counts = new Map();
  for (const g of ga) counts.set(g, (counts.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of gb) {
    const n = counts.get(g) ?? 0;
    if (n > 0) { hit++; counts.set(g, n - 1); }
  }
  return (2 * hit) / (ga.length + gb.length) >= threshold;
}

export class Wander {
  constructor(ctx, store, cfg) {
    this.ctx = ctx;
    this.store = store;
    this.cfg = cfg;
    this._busy = false; // 并发门闩：双触发源同 tick 并行时只允许一路生成（P1-1）
  }

  // 判定一次（由巡检器在触发条件满足时调用）
  // 插件卸载：此后不再生成/写盘（热重载时防止旧实例继续 appendWander）
  dispose() { this._disposed = true; }

  async maybeWander(agentId, reason) {
    if (this._disposed) return false;
    // 并发门闩（P1-1）：休眠源与独处源同一 tick 可能同时触发；两路并行会重复生成，
    // 而复读去重用的是生成前的快照，拦不住并行生成。这里让后到的一次直接跳过（下次 tick 再来）。
    if (this._busy) {
      this.store.log(`wander(${agentId}) ${reason}: 上一轮生成中，跳过本次`);
      return false;
    }
    this._busy = true;
    try {
    const w = this.cfg.wander;
    const pBase = Math.min(1, Math.max(0, Number(w.p) || 0));
    const factor = Math.min(10, Math.max(1, Number(w.factor) || 1));
    let p = pBase;
    if (this.overCare()) p = Math.min(1, p * factor);
    if (Math.random() >= p) {
      this.store.log(`wander(${agentId}) ${reason}: 未触发 (p=${p})`);
      return false;
    }
    this.store.log(`wander(${agentId}) ${reason}: 触发`);
    // 循环：残留带入走神（设计约定六节 cycle.residueP；解析文件格式成自然语句，不带"梦（natural）"等标签）
    let residueHint = '';
    if (Math.random() < (this.cfg.cycle?.residueP ?? 0)) {
      const r = this.store.latestResidue();
      if (r) {
        const words = (r.match(/^词：(.+)$/m) ?? [])[1];
        const sentence = (r.match(/^记得最深的一句：(.+)$/m) ?? [])[1];
        const parts = [];
        if (words) parts.push(`几个模糊的词：${words}`);
        if (sentence) {
          // 方块是给使用者看的马赛克；喂给生成时换成省略号，免得"□□□"当乱码读（与注入层同口径）
          const broken = sentence.replace(/□+/g, '…').replace(/^…+|…+$/g, '').replace(/…{2,}/g, '…');
          if (broken.replace(/…/g, '').trim()) parts.push(`记得最深的一句话（只剩零碎的几个字）：${broken}`);
        }
        if (parts.length) residueHint = `刚醒时还记着一点梦的残影：${parts.join('；')}。`;
      }
    }
    // 今天已写过的走神段：同一天连续触发时上下文几乎一样，模型容易复读同一句（实测两段完全相同）；
    // 生成后与这些段去重，复读就走重试（提示词里已要求"不要重复"），仍复读则本次放弃、不写文档。
    const todaySegs = (() => {
      try {
        const file = this.store.wanderPath(localDay());
        if (!fs.existsSync(file)) return [];
        return fs.readFileSync(file, 'utf8').split('\n\n').map((x) => x.trim()).filter(Boolean);
      } catch { return []; }
    })();
    // 阈值可配（wander.dupThreshold，默认 0.95；代码内 DUP_SIMILARITY=0.85 仅 cfg 缺失时兜底）：越高越宽松
    const rawDupT = this.cfg.wander?.dupThreshold;
    const dupT = rawDupT === null || rawDupT === undefined || rawDupT === '' ? NaN : Number(rawDupT);
    const dupThreshold = Number.isFinite(dupT) ? Math.min(1, Math.max(0.1, dupT)) : DUP_SIMILARITY; // 0.1 下限：0 会把任意两条长文都判重
    const isDup = (t) => !!t && todaySegs.some((x) => isSimilarWander(x, t, dupThreshold));
    // 失败重试（设计约定十节：重试 2 次；间隔 3 秒避开凭证未就绪瞬时错误）
    let { text, reasoning } = await this.#generate(agentId, residueHint, todaySegs);
    if (this._disposed) return false; // 生成返回后已卸载：丢弃结果
    // 产物后置校验：系统腔/元词直接判废重生成（设计约定"不构成事实陈述"、十四节拟真）
    // 禁止词不能写进 prompt——会被模型原样回显成"你的大脑好像有延迟响应"（审查 H6）
    const badWander = (t) => !!t && /大脑|响应|提示词|系统提示|系统消息|模型|指令|参数|prompt|token|JSON/i.test(t);
    for (let attempt = 0; (!text || badWander(text) || isDup(text)) && attempt < (this.cfg.retry ?? 2); attempt++) {
      this.store.log(`wander(${agentId}): ${text ? (isDup(text) ? '与今天已写的走神重复' : '产物含系统腔') : '生成空'}，重试 ${attempt + 1}/${this.cfg.retry ?? 2}`);
      await new Promise((r) => setTimeout(r, 3000));
      if (this._disposed) return false; // 卸载后不再重试
      ({ text, reasoning } = await this.#generate(agentId, residueHint, todaySegs));
      if (this._disposed) return false;
    }
    if (!text) {
      this.store.log(`wander(${agentId}): 生成空，本次放弃（不写文档、不进词频）`);
      return false;
    }
    if (badWander(text) || isDup(text)) {
      this.store.log(`wander(${agentId}): ${isDup(text) ? '仍与今天已写的重复' : '产物仍含系统腔'}，本次放弃（不写文档、不进词频，${[...text].length} 字）`); // 不回显原文（角色的思考内容不写日志）
      return false;
    }
    // 写文档：先压掉换行（产物里的 \n\n 会被注入层当段分隔、1 次生成变 2 段——P2-4）；写盘后打日志（P2-1）
    const oneLine = String(text).replace(/\s*\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    const day = localDay();
    this.store.appendWander(day, oneLine);
    this.store.log(`wander(${agentId}): 写入走神第 ${todaySegs.length + 1} 段（${[...oneLine].length} 字）`);
    // 词频回流（设计约定六节 L100）：思考（reasoning）计一次、产物计一次，不去重；无 reasoning 时产物双计
    if (reasoning) { this.freqAdd(reasoning); this.freqAdd(oneLine); }
    else { this.freqAdd(oneLine); this.freqAdd(oneLine); }
    // 注入：走神内容进现实角色下一次唤醒的会话（由注入层读取文档）
    this.store.save();
    return true;
    } finally { this._busy = false; }
  }

  overCare() {
    const f = this.freqRef();
    return f ? f.overCare(this.cfg.wander.threshold) : false;
  }

  freqAdd(text) {
    // 由 index.js 注入 addFreq 包装（内含"跨日先清池"），没有则退回裸 add
    if (typeof this._addFreq === 'function') return this._addFreq(text);
    this.freqRef()?.add(text);
  }

  freqRef() {
    // 由 index.js 注入当前词频实例
    return this._freq ?? null;
  }

  async #generate(agentId, residueHint = '', todaySegs = []) {
    const w = this.cfg.wander;
    try {
      const chunks = [];
      const reasoningChunks = [];
      const agent = this.ctx.agents.get(agentId);
      // 方案二.5：走神要注入角色的上下文（最近聊到的事/在意的事）；取不到就退回纯发呆
      const recent = (() => {
        try { return this._signal?.readRecentText?.(agentId, 5) ?? ''; } catch { return ''; }
      })();
      // 口吻样例：角色自己以前独处时想过的句子（同一份走神文档里最近几段），让口气一致
      const voice = (() => {
        try {
          const file = this.store.wanderPath(localDay());
          if (!fs.existsSync(file)) return '';
          const segs = fs.readFileSync(file, 'utf8').split('\n\n').map((s) => s.trim()).filter(Boolean);
          return segs.slice(-3).join('；').slice(0, 200);
        } catch { return ''; }
      })();
      // 不要重复今天已经写过的（复读防护的提示词侧；生成后还有硬去重校验）
      const avoid = todaySegs.length
        ? `今天你已经想过这些（别照抄，换个新的说法/角度）：${todaySegs.slice(-3).join('；').slice(0, 180)}`
        : '';
      const prompt = [
        '此刻你在发呆。',
        recent ? `最近你和对方聊到这些（不用复述，只作为你脑子的背景）：\n${recent}` : '',
        residueHint ? `${residueHint}你忽然想起了这个。` : '',
        avoid,
        voice ? `你平时说话的口气是这样的（只参考口气，内容必须不同）：${voice}` : '',
      ].filter(Boolean).join('\n');
      const ac = new AbortController();
      const watchdog = setTimeout(() => {
        this.store.log('wander stream watchdog: 60 秒无进展，中止');
        ac.abort();
      }, 60_000);
      watchdog?.unref?.();
      const opts = {
        provider: this.cfg.llm?.provider ?? 'deepseek-account',
        model: this.cfg.llm?.model ?? 'deepseek-flash',
        reasoningEffort: 'high',
        maxTokens: 2000, // 50 字输出却带 high reasoning：200 会烧光零文本（日志实证），对齐场景/半幕
        sessionId: agentId,
        signal: ac.signal,
        system: '你是现实中的自己（本人）。独处安静下来时，脑中闪过一个短促的联想。写出来，最多 ' + (w.max ?? 50) + ' 字，一句白话，不要解释，不要引号。要求：第一人称的碎念；只写模糊的联想，不编造具体的时间、人物、作品、地点；用你平时说话的口气（短句、口语、别像写文章）。',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      };
      const stream = agent
        ? this.ctx.agents.withInitiator(agent, () => this.ctx.llm.stream(opts))
        : this.ctx.llm.stream(opts);
      try {
        for await (const c of stream) {
          if (c.type === 'text-delta') chunks.push(c.text);
          else if (c.type === 'reasoning-delta') reasoningChunks.push(c.text ?? '');
          if (c.type === 'finish') {
            this.store.log(`wander stream finish: ${JSON.stringify(c.reason)}`);
            // max-tokens 截断不算失败：有文本就用截断的；只有 error 判失败
            if (c.reason.kind === 'error') return { text: null, reasoning: '' };
          }
        }
      } finally {
        clearTimeout(watchdog);
      }
      this.store.log(`wander stream end: chunks=${chunks.length}`);
      const text = [...chunks.join('').trim()].slice(0, Math.max(1, Number(w.max) || 50)).join('');
      const reasoning = reasoningChunks.join('').trim();
      return { text: text || null, reasoning };
    } catch (e) {
      this.store.log(`wander generate ERROR: ${e?.message ?? e}; cause: ${e?.cause?.stack ?? e?.cause ?? '无'}`);
      return { text: null, reasoning: '' };
    }
  }
}

