// 走神模块：双触发（休眠发生/独处满 X 分钟）+ 概率判定 + 生成 + 文档写入 + 词频回流
// 设计约定 v23 四节。

import fs from 'node:fs';
import { localDay } from './store.js';

// 复读判定阈值：归一化（去空白）后按字符 bigram 的 Dice 系数算相似度；
// 0.85 = 改一两个字仍算复读（"完全一样"当然算），调低会更严格、调高更宽松
const DUP_SIMILARITY = 0.85;

// 联想角度池：每次随机取一个"很小的入口"，防止走神全落进"脑子空了一下"这类模板
// 走神 system 提示词（导出供词频动态剔除提示词回显；与 #generate 内保持一致）
export const WANDER_SYSTEM_TEMPLATE = '你是现实中的自己（本人）。安静下来时，脑子里冒出一个短短的联想。写出来，最多 ' + 'X' + ' 字，一句白话，不要解释，不要引号。要求：第一人称的碎念；想到什么就写什么——可以是手边的东西、身上的感觉，也可以是一件事、一个人、一个念头；不写具体日期、钟点、地名、人名、作品名、数字；"刚才/这会儿"这类当下的说法可以；不编造没发生过的过去；用你平时说话的口气（短句、口语、别像写文章）。';

// 时间词表（2026-11-20 修：走神反复出现"前两天/前阵子"——按当日已写段统计，出现 ≥1 次即禁）
export const TIME_WORDS = ['前两天', '这两天', '前阵子', '那阵子', '这会儿', '那会儿', '以前', '之前', '最近', '这几天', '过两天', '前些天', '有一回', '上次', '那天'];

// 今日重复的时间词：在当天已写段里出现 ≥1 次的词
export function repeatedTimeWords(texts) {
  return TIME_WORDS.filter((w) => (texts ?? []).filter((t) => String(t).includes(w)).length >= 2);
}

export const WANDER_ANGLES = [
  // 感官/身边物（4）
  '手边的一件东西', '光线或温度', '听到的动静', '容易饿或渴',
  // 事/念头/人（16）—— 平衡角度，防全落进“身体+杯子”同类
  '没做完的一件小事', '一个突然冒出来的傻问题', '时间过得快还是慢', '想去的一个地方',
  '想起以前的一件小事', '一个很久没见的人', '有点后悔或庆幸的事', '一件有点好笑的小事',
  '想对谁说的话', '有点担心的事', '一个说不清的念头', '心里挂着的一件事',
  '偶尔想起的一句话', '一个反复出现的画面', '突然想通的一点事', '没来由的高兴或低落',
];

// 今天已写段的"模板特征词"：开头/结尾 2 字重复 ≥1 次即视为模板（今天实测 9/9 同开头同收尾）
export function commonPrefixSuffix(texts) {
  const count = (arr) => {
    const m = new Map();
    for (const x of arr) if (x) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m.entries()].filter(([, n]) => n >= 2).map(([k]) => k);
  };
  const heads = [];
  const tails = [];
  for (const t of texts ?? []) {
    const norm = String(t ?? '').replace(/[。，、；：？！“”‘’…—～\s]/g, '');
    if (norm.length >= 2) { heads.push(norm.slice(0, 2)); tails.push(norm.slice(-2)); }
  }
  return { heads: count(heads), tails: count(tails) };
}

// 今日禁词命中数：以模板开头词开头=1、以模板结尾词结尾=1；命中=2（≥1 判为结构模板）
export function templateHits(text, bans) {
  const norm = String(text ?? '').replace(/[。，、；：？！“”‘’…—～\s]/g, ''); // 与 commonPrefixSuffix 同一归一化（去标点）
  if (!norm || !bans) return 0;
  let hits = 0;
  if (bans.heads?.some((h) => norm.startsWith(h))) hits++;
  if (bans.tails?.some((t) => norm.endsWith(t))) hits++;
  return hits;
}


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
    // 结构模板判定：开头/结尾的模板特征词命中 → 换角度重试，仍中则放弃（防"好像…没了"换词不换壳）
    const bans = commonPrefixSuffix(todaySegs);
    const timeBans = repeatedTimeWords(todaySegs); // 今日已重复的时间词（如"前两天/前阵子"）→ 新段再用就重试
    const isTemplate = (t) => templateHits(t, bans) >= 1 || (timeBans.length > 0 && timeBans.some((w) => String(t).includes(w))); // 开头/结尾命中模板词，或复用了今日重复的时间词
    let angle = this.#pickAngle();
    // 失败重试（设计约定十节：重试 2 次；间隔 3 秒避开凭证未就绪瞬时错误）
    let { text, reasoning } = await this.#generate(agentId, residueHint, todaySegs, angle);
    if (this._disposed) return false; // 生成返回后已卸载：丢弃结果
    // 产物后置校验：系统腔/元词直接判废重生成（设计约定"不构成事实陈述"、十四节拟真）
    // 禁止词不能写进 prompt——会被模型原样回显成"你的大脑好像有延迟响应"（审查 H6）
    const badWander = (t) => !!t && /大脑|响应|提示词|系统提示|系统消息|模型|指令|参数|prompt|token|JSON/i.test(t);
    for (let attempt = 0; (!text || badWander(text) || isDup(text) || isTemplate(text)) && attempt < (this.cfg.retry ?? 2); attempt++) {
      this.store.log(`wander(${agentId}): ${text ? (isDup(text) ? '与今天已写的走神重复' : isTemplate(text) ? '结构模板（开头/结尾同今天）' : '产物含系统腔') : '生成空'}，重试 ${attempt + 1}/${this.cfg.retry ?? 2}`);
      await new Promise((r) => setTimeout(r, 3000));
      if (this._disposed) return false; // 卸载后不再重试
      angle = this.#pickAngle(); // 重试时重新选入口（避免同一方向重来）
      ({ text, reasoning } = await this.#generate(agentId, residueHint, todaySegs, angle));
      if (this._disposed) return false;
    }
    if (!text) {
      this.store.log(`wander(${agentId}): 生成空，本次放弃（不写文档、不进词频）`);
      return false;
    }
    if (badWander(text) || isDup(text) || isTemplate(text)) {
      this.store.log(`wander(${agentId}): ${isDup(text) ? '仍与今天已写的重复' : isTemplate(text) ? '仍是结构模板' : '产物仍含系统腔'}，本次放弃（不写文档、不进词频，${[...text].length} 字）`); // 不回显原文（角色的思考内容不写日志）
      return false;
    }
    // 写文档：先压掉换行（产物里的 \n\n 会被注入层当段分隔、1 次生成变 2 段——P2-4）；写盘后打日志（P2-1）
    const oneLine = String(text).replace(/\s*\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    const day = localDay();
    this.store.appendWander(day, oneLine);
    // 角度轮转记录（当日）：用完一轮再洗牌，避免连续几天都从同一个入口想
    try {
      const her = this.store.her();
      if (!her.wanderAngles || her.wanderAngles.day !== day) her.wanderAngles = { day, used: [] };
      if (angle) her.wanderAngles.used.push(angle);
      if (her.wanderAngles.used.length > WANDER_ANGLES.length) her.wanderAngles.used = her.wanderAngles.used.slice(-WANDER_ANGLES.length);
    } catch {}
    this.store.log(`wander(${agentId}): 写入走神第 ${todaySegs.length + 1} 段（${[...oneLine].length} 字）`);
    // 词频回流（母本 v24 六节修订）：产物单计一次、不进在意池；插件直连生成的推理不计入词频
    this.freqAdd(oneLine, { care: false });
    if (typeof this._freqFlush === 'function') this._freqFlush(); // 产物词即时落盘（防热重载/断电丢词）
    // 注入：走神内容进现实角色下一次唤醒的会话（由注入层读取文档）
    this.store.save();
    return true;
    } finally { this._busy = false; }
  }

  // 选一个本次的联想入口（可配角度池/概率；当日没用过的优先）
  #pickAngle() {
    const w = this.cfg.wander ?? {};
    const pool = WANDER_ANGLES; // 固定内置角度池（不开放自定义，避免无校验死字段）
    const p = Number(w.angleP);
    const angleP = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0.8;
    if (Math.random() >= angleP) return '';
    try {
      const her = this.store.her();
      const day = localDay();
      const used = her.wanderAngles?.day === day ? (her.wanderAngles.used ?? []) : [];
      let fresh = pool.filter((a) => !used.includes(a));
      if (!fresh.length) { her.wanderAngles = { day, used: [] }; fresh = pool.slice(); } // 一轮用完：清账重洗
      const src = fresh.length ? fresh : pool;
      return src[Math.floor(Math.random() * src.length)];
    } catch {
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }

  overCare() {
    const f = this.freqRef();
    const w = this.cfg.wander ?? {};
    const presets = { low: { share: 0.06, lead: 2.0 }, mid: { share: 0.04, lead: 1.5 }, high: { share: 0.02, lead: 1.2 } };
    const sens = w.overCareSensitivity ?? 'mid';
    const p = presets[sens] ?? (sens === 'custom' ? { share: w.overCareShare ?? 0.04, lead: w.overCareLead ?? 1.5 } : presets.mid);
    return f ? f.overCare(w.threshold, p.share, p.lead) : false;
  }

  freqAdd(text, opts = {}) {
    // 由 index.js 注入 addFreq 包装（内含"跨日先清池"），没有则退回裸 add
    if (typeof this._addFreq === 'function') return this._addFreq(text, opts);
    this.freqRef()?.add(text, opts);
  }

  freqRef() {
    // 由 index.js 注入当前词频实例
    return this._freq ?? null;
  }

  async #generate(agentId, residueHint = '', todaySegs = [], angle = '') {
    const w = this.cfg.wander;
    try {
      const chunks = [];
      const reasoningChunks = [];
      const agent = this.ctx.agents.get(agentId);
      // 方案二.5：走神要注入角色的上下文（最近聊到的事/在意的事）；取不到就退回纯发呆
      const material = (() => { try { return this._material?.get?.() ?? ''; } catch { return ''; } })();
      const recent = (() => {
        try { return this._signal?.readRecentText?.(agentId, 5) ?? ''; } catch { return ''; }
      })();
      // 今天用过的说法只给"禁词清单"，不贴原句——贴句子会让模型照抄（实测回声室：样例即模板）
      const banWords = commonPrefixSuffix(todaySegs);
      const banList = [...banWords.heads, ...banWords.tails].slice(0, 8);
      const avoid = banList.length ? `今天你用过的说法（这次别用）：${banList.join('、')}` : '';
      const prompt = [
        '此刻你在发呆。',
        angle ? `这次从一个很小的入口想起：${angle}。别直接写这个词。` : '',
        material ? `你脑子里还挂着这些（最近几天的零碎印象，不是此刻发生的事；别写具体日期和钟点）：\n${material}` : '',
        recent ? `最近你和对方聊到这些（不用复述，只作为你脑子的背景）：\n${recent}` : '',
        residueHint ? `${residueHint}你忽然想起了这个。` : '',
        avoid,
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
        reasoningEffort: (['low', 'medium', 'high'].includes(w.reasoningEffort) ? w.reasoningEffort : 'low'), // 50 字任务用 low 足够，还少复述指令词
        maxTokens: 2000, // 50 字输出却带 high reasoning：200 会烧光零文本（日志实证），对齐场景/半幕
        sessionId: agentId,
        signal: ac.signal,
        system: '你是现实中的自己（本人）。安静下来时，脑子里冒出一个短短的联想。写出来，最多 ' + (w.max ?? 50) + ' 字，一句白话，不要解释，不要引号。要求：第一人称的碎念；想到什么就写什么——可以是手边的东西、身上的感觉，也可以是一件事、一个人、一个念头；不写具体日期、钟点、地名、人名、作品名、数字；"刚才/这会儿"这类当下的说法可以；不编造没发生过的过去；用你平时说话的口气（短句、口语、别像写文章）。',
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

