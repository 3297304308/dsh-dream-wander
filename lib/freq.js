// 词频模块（v25 口径，2026-11-20）：Intl.Segmenter 分词 + 只收 2 字以上 + 停用词 + 双池（素材池/在意池）
// 取词：母本 L94-97 三步 + 首尾边界/碎片审查 + 内置 PICK_BLOCK 屏蔽低信息量叙事词（只影响取词与在意候选，不动计数）
// 设计依据：设计母本 v25 六节（统计对象/双池/过度在意三条件/动态提示词词表；详见母本与实现方案）
import { BUILTIN_STOPWORDS } from './config.js';

export const FREQ_VERSION = 2;

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

export function tokenize(text) {
  const words = [];
  for (const seg of segmenter.segment(text ?? '')) {
    if (!seg.isWordLike) continue;
    const w = seg.segment.trim().toLowerCase();
    if (!w) continue;
    words.push(w);
  }
  return words;
}

// 首尾碎片边界（取词第 3 步回退时用）
const BAD_EDGE = /^(?:的|了|着|过|我|你|他|她|它|这|那|个|们|在|是|和|与|就|都|也|还|又|很|太|没|不|把|被|让|给|对|从|向|往|到|去|来)/;
const BAD_TAIL = /(?:的|了|着|过|得|地|我|你|他|她|它|这|那|个|们|在|是|和|与|就|都|也|还|又|很|太|没|不|把|被|让|给|对|从|向|往|到|去|来)$/;

// 取词屏蔽表（母本 v25 L109：低信息量叙事词不算入梦候选；只作用取词/在意候选层，计数照记）
export const PICK_BLOCK = new Set([
  // 低信息量叙事词（按必要性收录，与当天是否出现过无关）
  '出去', '吃了', '等着', '先去', '没醒', '开始', '顺手', '主动', '打扰', '旁边',
  '心里', '觉得', '知道', '记得', '想起', '想到', '以为', '认为', '明白', '心想',
  '可把', '起眼',
  // 2026-11-21 真实池出现过的情态/副词/碎片（有画面的词如 抬头/脑袋/咕噜 不挡）
  '整天', '难怪', '一直', '可以', '要是', '往后', '找个', '不怕', '扑得', '低下',
]);

export class Freq {
  constructor(cfg) {
    this.cfg = cfg; // cfg.freq: { stopwords, names, pronouns, ... }
    this.stop = new Set([...BUILTIN_STOPWORDS, ...(cfg.freq?.stopwords ?? [])].map((w) => w.toLowerCase()));
    this.names = new Set((cfg.freq?.names ?? []).map((w) => w.toLowerCase()));
    this.pronouns = new Set((cfg.freq?.pronouns ?? []).map((w) => w.toLowerCase()));
    this.pool = new Map(); // 素材池（入梦/走神取词）
    this.care = new Map(); // 在意池（过度在意判定；不含走神产物）
    this.promptWords = new Set(); // 动态提示词词表（只作用会话推理路径）
    this.excludeEcho = cfg.freq?.promptExclude !== false; // 配置开关：关掉则不做提示词回显过滤
  }

  isPronoun(w) { const k = w.toLowerCase(); return this.pronouns.has(k) || this.names.has(k); }

  isStopword(w) { return this.stop.has(w.toLowerCase()); }

  // 计数层过滤：单字不收（主人 2026-11-18 口径）、停用词不收（虚词/时间词/二字虚词组合）
  #keep(w) {
    if ([...w].length < 2) return false;
    if (this.stop.has(w)) return false;
    if (!Freq.valid(w)) return false; // 英文/数字/符号/混排碎片不入池（母本 L105 口径）
    return true;
  }

  // 动态提示词词表：由 system-prompt/assemble 派生（跳过本插件注入段），只作用会话推理路径
  setPromptWords(texts) {
    const next = new Set();
    for (const t of texts ?? []) {
      for (const w of tokenize(String(t ?? ''))) {
        if (next.size >= 5000) break; // 词表规模上限，防异常膨胀
        next.add(w);
      }
    }
    this.promptWords = next;
  }

  // 计入一段文本。care=true 同时进在意池；reasoning=true 时先剔除提示词回显（只对会话推理路径生效）
  add(text, opts = {}) {
    const { care = true, reasoning = false } = opts;
    for (const w of tokenize(text)) {
      if (!this.#keep(w)) continue;
      if (reasoning && this.excludeEcho && this.promptWords.has(w)) continue;
      this.pool.set(w, (this.pool.get(w) ?? 0) + 1);
      if (care) this.care.set(w, (this.care.get(w) ?? 0) + 1);
    }
  }

  // 出词审查（母本 L109）：虚词、乱码、碎片等不合格词在取词层剔除
  static valid(w) {
    if (!w) return false;
    if (/^[\d\s]+$/.test(w)) return false;
    if (/^[a-z0-9]+$/i.test(w)) return false; // 纯 ASCII 字母/数字/混排（3dm/13h/word）
    if (/[^\p{L}\p{N}]/u.test(w)) return false;
    return true;
  }

  #rank(map, opts = {}) {
    const block = !!opts.block;
    return [...map.entries()]
      .filter(([w]) => Freq.valid(w) && !this.isPronoun(w) && !this.isStopword(w) && (!block || !PICK_BLOCK.has(w)))
      .sort((a, b) => b[1] - a[1]);
  }

  // 高频档：素材池前三（人称/称呼/代词排除）
  topHigh() { return this.#rank(this.pool, { block: true }).filter(([w]) => !BAD_EDGE.test(w) && !BAD_TAIL.test(w)).slice(0, 3).map(([w]) => w); }

  // 中频档：第 4-10 名（可含人称/代词，母本 L102）
  mid(highCandidates) {
    // 碎片/边界规则也应用于中频档（母本 L109 对每个取词都做合格性检查；人称/代词豁免以守 L102）
    const entries = [...this.pool.entries()].filter(([w]) => Freq.valid(w) && !this.isStopword(w) && !PICK_BLOCK.has(w) && (this.isPronoun(w) || (!BAD_EDGE.test(w) && !BAD_TAIL.test(w)))).sort((a, b) => b[1] - a[1]);
    const top3 = new Set(highCandidates);
    return entries.slice(3, 10).filter(([w]) => !top3.has(w)).map(([w]) => w);
  }

  // 取词三步（母本 L94-97）：第 3 步从当日出现过的词随机（≥1 次），过首尾边界与屏蔽表；池子太小按 L109 任取回退
  drawWords() {
    const high = this.topHigh();
    if (high.length === 0 && this.pool.size === 0) return [];
    const mid = this.mid(high);
    const used = new Set();
    const result = [];
    if (high.length) { const w = high[Math.floor(Math.random() * high.length)]; result.push(w); used.add(w); }
    const midPool = mid.filter((w) => !used.has(w) && !high.includes(w));
    if (midPool.length) { const w = midPool[Math.floor(Math.random() * midPool.length)]; result.push(w); used.add(w); }
    const pickFrom = (allowBlocked) => {
      const arr = [...this.pool.entries()]
        .filter(([w]) => Freq.valid(w) && !used.has(w) && !this.isPronoun(w) && !this.isStopword(w) && !BAD_EDGE.test(w) && !BAD_TAIL.test(w) && (allowBlocked || !PICK_BLOCK.has(w)))
        .map(([w]) => w);
      for (let i = 0; i < 3 && arr.length > 0; i++) {
        const idx = Math.floor(Math.random() * arr.length);
        const w = arr.splice(idx, 1)[0];
        result.push(w); used.add(w);
      }
    };
    pickFrom(false); // 撤销"≥2 次"门槛（母本 L94-97：当日出现过的词随机；首尾边界与屏蔽表兜底）
    if (result.length < 5) pickFrom(true); // 池子太小：按 L109"同档无词则任取"回退
    return result.slice(0, 5); // 入梦素材最多五个（母本 L31/L92）
  }

  // 过度在意（母本 L61 v24）：在意池 top1 同时满足 次数>threshold、占比>share、≥lead×top2
  overCare(threshold, share = 0, lead = 0) {
    const entries = this.#rank(this.care, { block: true });
    if (!entries.length) return false;
    const top = entries[0][1];
    const second = entries[1] ? entries[1][1] : 0;
    let total = 0;
    for (const n of this.care.values()) total += n;
    if (total <= 0) return false;
    if (!(top > threshold)) return false;
    if (share > 0 && top / total <= share) return false;
    if (lead > 0 && second > 0 && top < lead * second) return false;
    return true;
  }

  // 诊断（面板/日志用）
  stats() {
    const pickable = [...this.pool.entries()].filter(([w]) => Freq.valid(w) && !this.isPronoun(w) && !this.isStopword(w) && !PICK_BLOCK.has(w) && !BAD_EDGE.test(w) && !BAD_TAIL.test(w)).length;
    return { pool: this.pool.size, care: this.care.size, pickable, poolTotal: [...this.pool.values()].reduce((a, b) => a + b, 0), careTotal: [...this.care.values()].reduce((a, b) => a + b, 0) };
  }

  // 序列化（当日池落盘：素材池 + 在意池）
  toJSON() { return { pool: Object.fromEntries(this.pool), care: Object.fromEntries(this.care) }; }

  static fromJSON(json, cfg) {
    const f = new Freq(cfg);
    const src = json && typeof json === 'object' && (json.pool || json.care) ? json : { pool: json ?? {}, care: null };
    for (const [k, v] of Object.entries(src.pool ?? {})) {
      const nk = k.toLowerCase();
      if (!f.#keep(nk)) continue;
      if (!Freq.valid(nk)) continue;
      f.pool.set(nk, (f.pool.get(nk) ?? 0) + (Number(v) || 0));
    }
    for (const [k, v] of Object.entries(src.care ?? {})) {
      const nk = k.toLowerCase();
      if (!f.#keep(nk)) continue;
      if (!Freq.valid(nk)) continue;
      f.care.set(nk, (f.care.get(nk) ?? 0) + (Number(v) || 0));
    }
    if (!src.care) f.care = new Map(f.pool); // 旧格式无在意池：先按全量初始化
    return f;
  }
}
