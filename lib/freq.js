// 词频模块：Intl.Segmenter 分词 + 停用词过滤 + 人称/代词分档
// 设计约定 v22 六节：对象=角色的思考+角色说出的话+走神产物；虚词不计；代词计数但不进高频档。

import { BUILTIN_STOPWORDS } from './config.js';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

export function tokenize(text) {
  const words = [];
  for (const seg of segmenter.segment(text ?? '')) {
    if (!seg.isWordLike) continue;
    // 英文词统一小写（Now/now 同词分家会占双份名额；中文不受影响）
    const w = seg.segment.trim().toLowerCase();
    if (!w) continue;
    words.push(w);
  }
  return words;
}

export class Freq {
  constructor(cfg) {
    this.cfg = cfg; // cfg.freq: { stopwords, names, pronouns }
    this.stop = new Set([...BUILTIN_STOPWORDS, ...(cfg.freq?.stopwords ?? [])].map((w) => w.toLowerCase()));
    this.names = new Set((cfg.freq?.names ?? []).map((w) => w.toLowerCase()));
    this.pronouns = new Set((cfg.freq?.pronouns ?? []).map((w) => w.toLowerCase()));
    this.pool = new Map(); // 词 -> 次数
  }

  isPronoun(w) { const k = w.toLowerCase(); return this.pronouns.has(k) || this.names.has(k); }

  isStopword(w) { return this.stop.has(w.toLowerCase()); }

  // 计入一段文本（角色的思考/说出的/走神产物）
  add(text) {
    for (const w of tokenize(text)) {
      if (this.stop.has(w)) continue; // 虚词不计
      this.pool.set(w, (this.pool.get(w) ?? 0) + 1);
    }
  }

  // 出词审查（设计约定六节 L103）：虚词、乱码、碎片等不合格词在取词层剔除
  static valid(w) {
    if (!w) return false;
    if (/^[\d\s]+$/.test(w)) return false; // 纯数字/空白
    if (/^[a-z]{1,2}$/i.test(w)) return false; // 1-2 字母英文碎片
    // 纯英文词不作入梦素材：梦是中文写的，抽到英文单词（reasoning 碎片）会直接穿帮
    if (/^[a-z]+$/i.test(w)) return false;
    if (/[^\p{L}\p{N}]/u.test(w)) return false; // 含标点/符号的碎片
    return true;
  }

  // 高频档：剔除人称/代词后的前三名（取词层先做合格性审查与停用词过滤）
  topHigh() {
    const entries = [...this.pool.entries()].filter(([w]) => Freq.valid(w) && !this.isPronoun(w) && !this.isStopword(w));
    entries.sort((a, b) => b[1] - a[1]);
    return entries.slice(0, 3).map(([w]) => w);
  }

  // 中频档：全表第 4-10 位（含人称/代词——设计约定六节 L96"第四至第十名可含人称/代词"）
  mid(highCandidates) {
    const entries = [...this.pool.entries()].filter(([w]) => Freq.valid(w) && !this.isStopword(w));
    entries.sort((a, b) => b[1] - a[1]);
    const top3 = new Set(highCandidates);
    const byRank = entries.slice(3, 10); // 排位 4-10
    return byRank.filter(([w]) => !top3.has(w)).map(([w]) => w);
  }

  // 取词三步（设计约定六节）：返回最多 5 词（合格性审查在 topHigh/mid/rest 各层剔除）
  drawWords() {
    const high = this.topHigh();
    if (high.length === 0 && this.pool.size === 0) return [];
    const mid = this.mid(high);
    const used = new Set();
    const result = [];
    // 1. 高频前三随机取一个
    if (high.length) {
      const w = high[Math.floor(Math.random() * high.length)];
      result.push(w); used.add(w);
    }
    // 2. 全列表 4-10 且不在第 1 步候选中随机取一个
    const midPool = mid.filter((w) => !used.has(w) && !high.includes(w));
    if (midPool.length) {
      const w = midPool[Math.floor(Math.random() * midPool.length)];
      result.push(w); used.add(w);
    }
    // 3. 其余三个从当日出现过的合格词随机取（前两步已抽中的除外）
    const rest = [...this.pool.entries()]
      .filter(([w]) => Freq.valid(w) && !used.has(w))
      .map(([w]) => w);
    for (let i = 0; i < 3 && rest.length > 0; i++) {
      const idx = Math.floor(Math.random() * rest.length);
      const w = rest.splice(idx, 1)[0];
      result.push(w); used.add(w);
    }
    return result;
  }

  // 过度在意判定：最高频词（人称/代词除外）次数超阈值
  overCare(threshold) {
    const high = this.topHigh();
    if (!high.length) return false;
    return (this.pool.get(high[0]) ?? 0) > threshold;
  }

  // 序列化（当日池落盘）
  toJSON() { return Object.fromEntries(this.pool); }
  static fromJSON(json, cfg) {
    const f = new Freq(cfg);
    const merged = new Map();
    for (const [k, v] of Object.entries(json ?? {})) {
      // 存量池大小写归并（历史双键迁移，幂等）
      const nk = k.toLowerCase();
      // 历史池里的停用词/英文碎片/数字碎片清掉（旧版池子/旧停用表带进来的，设计约定）
      if (f.stop.has(nk)) continue;
      if (!Freq.valid(nk)) continue;
      merged.set(nk, (merged.get(nk) ?? 0) + v);
    }
    f.pool = merged;
    return f;
  }
}
