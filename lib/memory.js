// 梦醒记忆·形态二「打码梦文本」（设计约定十一节新增，2026-11-16 作者拍板）：
// 与「词句残留」同级、二选一。把已放出的梦境正文整段按可见比例随机盖方块，按天逐格降档，
// 比例走独立的 residue.visibility 序列（默认 50/30/10/无/无），到期删除。
// 与副本的区别：副本=给作者查阅的存档（copy.visibility）；本模块=角色自己能记住的版本（residue.visibility）。
// 打码只增不减、随机位置覆盖，不需要原文；替换位图持久化在 state.memoryBitmaps。
import fs from 'node:fs';
import path from 'node:path';
import { localDay } from './store.js';
import { normalizeVisibility } from './copy.js';

const DEFAULT_MEMORY_VISIBILITY = [50, 30, 10, 0, 0];

// 原子写（tmp + rename）：崩溃不会留半写文件
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

export class Memory {
  constructor(store, cfg) {
    this.store = store;
    this.cfg = cfg;
    this.dir = path.join(store.dir, '残留');
  }

  // 角色能看到的比例序列（独立于副本；归一规则与副本一致：5 格、10 的倍数、单调不增）
  visibility() {
    const raw = this.cfg.residue?.visibility;
    // 空/非法序列回退到形态二自己的默认 50/30/10（normalizeVisibility 的空数组默认是副本的 80/40/20）
    return normalizeVisibility(Array.isArray(raw) && raw.length ? raw : DEFAULT_MEMORY_VISIBILITY);
  }

  #bitmaps() {
    if (!this.store.state.memoryBitmaps) this.store.state.memoryBitmaps = {};
    return this.store.state.memoryBitmaps;
  }

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

  #render(chars, maskedSet) {
    return chars.map((c, i) => (maskedSet.has(i) ? '□' : c)).join('');
  }

  // 新梦：按序列第 1 格打码，写 残留/<日期>-<场次>.md（覆盖同一场次旧文件）
  writeNew(day, seq, text) {
    try {
      const vis = this.visibility();
      const first = vis[0];
      if (!(first > 0)) {
        this.store.log(`memory: 第 1 格为「无」，跳过梦醒记忆 ${day}-${seq}`);
        return '';
      }
      const name = `${day}-${seq}.md`;
      const file = path.join(this.dir, name);
      const chars = [...text];
      const order = this.#shuffledOrder(text);
      const visible = first / 100;
      const maskCount = Math.max(0, Math.round(chars.length * (1 - visible)));
      const masked = order.slice(0, maskCount);
      this.#bitmaps()[name] = { total: chars.length, masked };
      writeAtomicSync(file, this.#render(chars, new Set(masked)));
      this.store.save();
      return name;
    } catch (e) {
      this.store.log(`memory.writeNew ERROR: ${e?.message ?? e}`);
      return '';
    }
  }

  pathOf(name) {
    return path.join(this.dir, name);
  }

  #dayDiff(a, b) {
    const [ay, am, ad] = a.split('-').map(Number);
    const [by, bm, bd] = b.split('-').map(Number);
    return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86_400_000);
  }

  #targetRatio(fileDay, today, extraDays = 0) {
    const diff = this.#dayDiff(fileDay, today) + extraDays;
    const v = this.visibility();
    // 天龄 0（当天）=第 1 格、1（隔天）=第 2 格……与设计约定 v22 L183"当天/隔天/再隔天"一致
    // （副本用 0-1 天同格是副本条款 L182 的独立口径，两者不同）
    const idx = Math.max(0, diff);
    if (idx >= v.length) return 0;
    const pct = v[idx];
    return Number.isFinite(pct) && pct > 0 ? pct / 100 : 0;
  }

  // 降档重算（幂等；每日 tick / 唤醒时挂接）。只处理有自己位图的文件，
  // 词句残留（形态一）或人工放入的文件不碰。
  degradeAll(extraDays = 0) {
    const today = localDay();
    const bm = this.#bitmaps();
    let changed = false;
    // 反向对账：文件已不在（被覆盖/过期/手动删）→ 位图条目一并清掉，防 state 无界增胖
    try {
      const files = new Set(fs.readdirSync(this.dir));
      for (const name of Object.keys(bm)) {
        if (!files.has(name)) { delete bm[name]; changed = true; }
      }
    } catch {}
    try {
      for (const name of fs.readdirSync(this.dir)) {
        const m = name.match(/^(\d{4}-\d{2}-\d{2})-(\d+)\.md$/);
        if (!m) continue;
        const entry0 = bm[name];
        if (!entry0) continue; // 不是本形态生成的文件（词句残留等）：不降、不删
        const ratio = this.#targetRatio(m[1], today, extraDays);
        const file = path.join(this.dir, name);
        if (ratio === 0) {
          fs.rmSync(file, { force: true });
          delete bm[name];
          changed = true;
          this.store.log(`memory: 删除过期梦醒记忆 ${name}`);
          continue;
        }
        const targetMasked = Math.max(0, Math.round(entry0.total * (1 - ratio)));
        if (entry0.masked.length >= targetMasked) continue;
        const cur = fs.readFileSync(file, 'utf8');
        const chars = [...cur];
        const order = this.#shuffledOrder(cur);
        const existing = new Set(entry0.masked);
        const fresh = order.filter((i) => !existing.has(i)).slice(0, targetMasked - entry0.masked.length);
        for (const i of fresh) chars[i] = '□';
        entry0.masked.push(...fresh);
        writeAtomicSync(file, chars.join(''));
        changed = true;
        this.store.log(`memory: 降档 ${name} 可见 ${Math.round(ratio * 100)}%（打码 ${entry0.masked.length}/${entry0.total}）`);
      }
      if (changed) this.store.save();
    } catch (e) {
      this.store.log(`memory.degradeAll ERROR: ${e?.message ?? e}`);
    }
  }

  // 读记忆文本（方块保留原样；注入层负责转成自然描述）
  readText(filePath) {
    try {
      if (!filePath) return '';
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }
}
