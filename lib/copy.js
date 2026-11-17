// 副本降档（设计约定十一节）：可见比例序列固定 5 格（第 1 格管今天/昨天、第 2 格管前天…），
// 0（无）= 当天删除；降档=从当前可见字符中随机替换（设计约定），直接在副本文件上打码、不需要原文。
// 替换位图持久化（state.copyBitmaps），只增不减；降档按自然日、幂等重算。
import fs from 'node:fs';
import path from 'node:path';
import { localDay } from './store.js';

const DEFAULT_VISIBILITY = [80, 40, 20, 0, 0];

// 副本可见比例归一：非数组/空→默认 5 格；补 0 到 5 格、超 5 截断；非数值→0；吸附到 10 的倍数；单调不增
export function normalizeVisibility(raw) {
  const base = Array.isArray(raw) && raw.length ? raw.slice(0, 5) : DEFAULT_VISIBILITY.slice();
  while (base.length < 5) base.push(0);
  const out = base.map((v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.min(100, Math.max(0, Math.round(n / 10) * 10));
  });
  for (let i = 1; i < out.length; i++) if (out[i] > out[i - 1]) out[i] = out[i - 1];
  return out;
}

// 保留期 N：第一个「无」（0）的格号减 1；没有 0 则 = 5。删除发生在天龄 d = N+1
export function retentionDays(raw) {
  const v = normalizeVisibility(raw);
  const i = v.indexOf(0);
  return i < 0 ? v.length : i;
}

// 原子写（tmp + rename）：崩溃不会留半写文件被降档逻辑当"现状"接管
function writeAtomicSync(file, data) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export class Copy {
  constructor(store, cfg) {
    this.store = store;
    this.cfg = cfg;
    this.dir = path.join(store.dir, '梦境副本');
  }

  #bitmaps() {
    if (!this.store.state.copyBitmaps) this.store.state.copyBitmaps = {};
    return this.store.state.copyBitmaps;
  }

  // 确定性种子（同文本随机顺序稳定）
  #seedOf(text) {
    let seed = 0;
    for (const ch of text) seed = (seed * 31 + ch.codePointAt(0)) % 1_000_000_007;
    return seed;
  }

  #shuffledOrder(text) {
    let seed = this.#seedOf(text);
    const order = [...text].map((_, i) => i);
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  }

  // 新梦写副本：可见比例取归一化序列第 1 格；第 1 格为 0（无）则不生成副本
  writeNew(day, seq, text) {
    try {
      const vis = normalizeVisibility(this.cfg.copy?.visibility);
      const first = vis[0];
      if (!(first > 0)) {
        this.store.log(`copy: 第 1 格为「无」，跳过副本 ${day}-${seq}`);
        return '';
      }
      const name = `${day}-${seq}.md`;
      const file = path.join(this.dir, name);
      const chars = [...text];
      const order = this.#shuffledOrder(text);
      const visible = first / 100;
      const maskCount = Number.isFinite(visible) ? Math.max(0, Math.round(chars.length * (1 - visible))) : 0;
      const masked = order.slice(0, maskCount);
      this.#bitmaps()[name] = { total: chars.length, masked };
      writeAtomicSync(file, this.#render(chars, new Set(masked)));
      this.store.save();
      return name;
    } catch (e) {
      this.store.log(`copy.writeNew ERROR: ${e?.message ?? e}`);
      return '';
    }
  }

  #render(chars, maskedSet) {
    return chars.map((c, i) => (maskedSet.has(i) ? '□' : c)).join('');
  }

  // 目标可见比例：按归一化序列走（第 1 格管今天/昨天、第 2 格管前天…；0 或超出序列=删除）
  #targetRatio(fileDay, today, extraDays = 0) {
    const diff = this.#dayDiff(fileDay, today) + extraDays;
    const v = normalizeVisibility(this.cfg.copy?.visibility);
    const idx = Math.max(0, diff - 1);
    if (idx >= v.length) return 0; // 超出配置的档数 → 删除
    const pct = v[idx];
    return Number.isFinite(pct) && pct > 0 ? pct / 100 : 0;
  }

  #dayDiff(a, b) {
    const [ay, am, ad] = a.split('-').map(Number);
    const [by, bm, bd] = b.split('-').map(Number);
    return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86_400_000);
  }

  // 降档重算（幂等；唤醒/重启时挂接）
  degradeAll(extraDays = 0) {
    const today = localDay();
    const bm = this.#bitmaps();
    let changed = false;
    // 反向对账：位图键对应文件已不在（手动删/恢复旧 state）→ 清掉，防孤儿位图长期堆积
    try {
      const files = new Set(fs.readdirSync(this.dir));
      for (const k of Object.keys(bm)) if (!files.has(k)) { delete bm[k]; changed = true; }
    } catch {}
    try {
      for (const name of fs.readdirSync(this.dir)) {
        const m = name.match(/^(\d{4}-\d{2}-\d{2})-(\d+)\.md$/);
        if (!m) {
          // 不合命名规范的文件：不删（可能是作者自己放的笔记/说明），只跳过
          continue;
        }
        const ratio = this.#targetRatio(m[1], today, extraDays);
        const file = path.join(this.dir, name);
        if (ratio === 0) {
          fs.rmSync(file, { force: true });
          delete bm[name];
          changed = true;
          this.store.log(`copy: 删除过期副本 ${name}`);
          continue;
        }
        let entry = bm[name];
        if (!entry) {
          // 历史无位图文件：按现状登记（□ 位置即已打码），此后纳入正常降档日程
          const cur = fs.readFileSync(file, 'utf8');
          const chars0 = [...cur];
          const masked0 = chars0.map((c, i) => (c === '□' ? i : -1)).filter((i) => i >= 0);
          entry = bm[name] = { total: chars0.length, masked: masked0 };
          this.store.log(`copy: 补位图 ${name}（已打码 ${masked0.length}/${chars0.length}）`);
          changed = true;
        }
        const targetMasked = Math.max(0, Math.round(entry.total * (1 - ratio)));
        if (entry.masked.length >= targetMasked) continue; // 已达标（只增不减）
        // 从当前可见字符中随机再替换（设计约定）
        const cur = fs.readFileSync(file, 'utf8');
        const chars = [...cur];
        const order = this.#shuffledOrder(cur);
        const existing = new Set(entry.masked);
        const fresh = order.filter((i) => !existing.has(i)).slice(0, targetMasked - entry.masked.length);
        for (const i of fresh) chars[i] = '□';
        entry.masked.push(...fresh);
        writeAtomicSync(file, chars.join(''));
        changed = true;
        this.store.log(`copy: 降档 ${name} 可见 ${Math.round(ratio * 100)}%（打码 ${entry.masked.length}/${entry.total}）`);
      }
      if (changed) this.store.save();
    } catch (e) {
      this.store.log(`copy.degradeAll ERROR: ${e?.message ?? e}`);
    }
  }
}
