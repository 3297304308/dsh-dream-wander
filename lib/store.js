// 落盘存储：state.json（状态机/判定进度/词频）+ 走神/残留/梦境副本 文件
// 数据目录：配置 dataDir ?? 环境变量 DREAM_WANDER_DATA ?? <DSH_HOME>/dream-wander-data
// （插件自写物理存储全部在这里；梦原文只在梦境副本、画面只存内存）
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.statePath = path.join(dataDir, 'state.json');
    fs.mkdirSync(path.join(dataDir, '走神'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, '残留'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, '梦境副本'), { recursive: true });
    this.state = this.#load();
    this.disposed = false;
  }

  // 实例已卸载：此后所有 save 一律 no-op（防旧实例快照覆盖新实例的 state.json）
  dispose() { this.disposed = true; }

  #load() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (e) {
      // 文件不存在 = 首次运行（正常，空状态起步，不要当损坏）
      if (e?.code === 'ENOENT') {
        return { agents: {}, freq: {}, freqDay: '' };
      }
      // 只有语法错误才当"文件损坏"改名；权限/占用等读失败直接抛，避免用空状态覆盖可读的 state.json
      if (!(e instanceof SyntaxError)) throw e;
      // 解析失败：坏文件改名留证，从空状态起步，不许静默覆盖
      if (fs.existsSync(this.statePath)) {
        try {
          const bad = `${this.statePath}.corrupt-${Date.now()}`;
          fs.renameSync(this.statePath, bad);
          this.#diag(`state.json 损坏已改名：${bad}`);
        } catch {}
      }
      return {
        agents: {}, // agentId -> { status, lastActivity, k, remaining, dreamStartedAt, ... }
        freq: {}, // 词频：词 -> 次数（当日）
        freqDay: '', // 词频所属日（当日首次唤醒日期）
      };
    }
  }

  // 原子写：tmp + fsync + rename（崩溃/断电不会留半写文件）
  #writeAtomic(file, data) {
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

  #diag(msg) {
    try {
      fs.appendFileSync(path.join(this.dir, 'plugin.log'), `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
    } catch {}
  }

  save() {
    if (this.disposed) return; // 旧实例已卸载：不再写盘（防快照覆盖）
    try {
      // 原子写：先写 .tmp 再 rename，写一半断电不坏原文件
      const tmp = `${this.statePath}.tmp`;
      // 画面仅存插件内存、崩溃不作留存（设计约定十节/十一节）：落盘副本剔除 frame
      // 梦正文/放字缓冲仅存内存（设计约定八节/十一节、方案七）：整棵 her.dream 不落盘；_finishing 为瞬态标记
      const snapshot = JSON.parse(JSON.stringify(this.state));
      if (snapshot.her?.frame) delete snapshot.her.frame;
    // 瞬态字段（_textBuf/_reasonBuf/_speechMode 等）不落盘：防隐私与热重载粘滞（终审 M P2-2）
    for (const a of Object.values(snapshot.agents ?? {})) {
      for (const k of Object.keys(a)) if (k.startsWith('_')) delete a[k];
    }
      if (snapshot.her?.dream) delete snapshot.her.dream;
      if (snapshot.her && '_finishing' in snapshot.her) delete snapshot.her._finishing; // 瞬态标记不落盘（含 false）
      this.#writeAtomic(this.statePath, JSON.stringify(snapshot, null, 2));
    } catch (e) {
      // 写盘失败要可见，不许吞错
      this.#diag(`save ERROR: ${e?.message ?? e}`);
    }
  }

  // 当日词频
  freq() { return this.state.freq ?? {}; }
  freqDay() { return this.state.freqDay ?? ''; }
  setFreq(freq, day) {
    this.state.freq = freq;
    this.state.freqDay = day;
    this.save();
  }

  // 每 agent 状态（活动计时等会话级信息）
  agent(id) {
    if (!this.state.agents[id]) {
      this.state.agents[id] = { status: 'awake', lastActivity: Date.now(), lastHuman: Date.now() }; // lastHuman 初始化：防首次 tick 独处计时直接满足（P2-7）
    }
    return this.state.agents[id];
  }
  saveAgent(id) { this.save(); }

  // 梦境角色全局状态（设计约定五节：入睡/梦为"角色"一人所有，不按会话分家；此对象=梦境角色的梦进程，醒来后的残留等也归此）
  her() {
    if (!this.state.her) {
      this.state.her = { status: 'awake' };
    }
    return this.state.her;
  }
  saveHer() { this.save(); }

  // 走神文档（当日）
  wanderPath(day) { return path.join(this.dir, '走神', `${day}.md`); }
  appendWander(day, text) {
    fs.appendFileSync(this.wanderPath(day), `${text}\n\n`, 'utf8');
  }
  clearWander(day) {
    const p = this.wanderPath(day);
    if (fs.existsSync(p)) fs.rmSync(p);
  }

  // 清理过期走神文档（保留当日；设计约定：未被注入过的走神随文档清除）
  clearOldWander(today) {
    try {
      const dir = path.join(this.dir, '走神');
      for (const name of fs.readdirSync(dir)) {
        const m = name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
        if (m && m[1] !== today) fs.rmSync(path.join(dir, name), { force: true });
      }
    } catch {}
  }

  // 残留
  residuePath(day, seq = '') { return path.join(this.dir, '残留', `${day}${seq ? `-${seq}` : ''}.md`); }
  writeResidue(day, seq, content) {
    try {
      this.#writeAtomic(this.residuePath(day, seq), content);
    } catch (e) {
      this.#diag(`writeResidue ERROR: ${e?.message ?? e}`);
    }
  }

  // 残留只留最新一份：删掉目录里 keepName 以外的文件（设计约定 覆盖语义）
  pruneResidue(keepName) {
    try {
      const dir = path.join(this.dir, '残留');
      const bm = this.state.memoryBitmaps ?? {};
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.md') && name !== keepName) {
          fs.rmSync(path.join(dir, name), { force: true });
          delete bm[name]; // 位图随文件一起清（防 memoryBitmaps 无界增长）
        }
      }
    } catch {}
  }

  // 残留文件超时清理（设计约定：自角色"真正醒来"起 24 小时；锚点=her.residueWakeAt）
  // 没醒过（锚点=0）→ 当前残留留着等角色醒来（设计约定：醒时无画面/残留按没感觉处理，但文件不能提前没）
  pruneExpiredResidue(hours = 24) {
    try {
      const dir = path.join(this.dir, '残留');
      const her = this.state.her ?? {};
      const limit = Date.now() - hours * 3600_000;
      const anchor = Number(her.residueWakeAt) || 0;
      const bm = this.state.memoryBitmaps ?? {};
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        if (bm[name]) continue; // 打码梦文本由 memory.degradeAll 按自身序列清理，不受 residue.hours 影响
        const p = path.join(dir, name);
        try {
          const isCurrent = her.residuePath && path.basename(String(her.residuePath)) === name;
          // 当前残留按醒来锚点判过期；其它孤儿文件按文件时间兜底（防目录堆积）
          const stale = isCurrent
            ? (anchor > 0 && anchor < limit)
            : fs.statSync(p).mtimeMs < limit;
          if (stale) { fs.rmSync(p, { force: true }); delete this.state.memoryBitmaps?.[name]; }
        } catch {}
      }
    } catch {}
  }

  // 梦境副本（梦原文载体）
  copyPath(day, seq = '') { return path.join(this.dir, '梦境副本', `${day}${seq ? `-${seq}` : ''}.md`); }
  writeCopy(day, seq, content) {
    this.#writeAtomic(this.copyPath(day, seq), content);
  }

  // 最新残留（24h 内的；无则 null）——窗口锚=角色真正醒来的时刻（her.residueWakeAt），与注入层同口径（设计约定）
  latestResidue() {
    try {
      const her = this.state.her;
      const at = Number(her?.residueWakeAt) || Number(her?.residueAt) || 0;
      if (at && Date.now() - at > 24 * 3600_000) return null;
      // 形态二（打码梦文本）不是词句，不参与"残留带入走神"
      const rp = String(her?.residuePath ?? '');
      if (rp && this.state.memoryBitmaps?.[path.basename(rp)]) return null;
      // residuePath 可能是旧绝对路径（换过数据目录）→ 兜底按当前数据目录的 残留/<文件名> 找
      const raw = String(her?.residuePath ?? '');
      if (raw) {
        // 优先当前数据目录的 残留/<文件名>（residuePath 可能是旧数据目录留下的绝对路径）
        const cand = path.join(this.dir, '残留', path.basename(raw));
        if (fs.existsSync(cand)) return fs.readFileSync(cand, 'utf8');
        if (path.isAbsolute(raw) && fs.existsSync(raw)) return fs.readFileSync(raw, 'utf8');
      }
      return null;
    } catch { return null; }
  }

  // 日志（插件自用诊断，非梦原文）
  log(msg) {
    try {
      const f = path.join(this.dir, 'plugin.log');
      // 简单轮转：超过 2MB 换名为 plugin.log.1（覆盖旧的），防长期运行无限增长
      try {
        const st = fs.statSync(f);
        if (st.size > 2 * 1024 * 1024) fs.renameSync(f, `${f}.1`);
      } catch {}
      fs.appendFileSync(f, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
    } catch {}
    // 内存错误环（面板 health 显示最近异常；不进文件，进程重启即清）
    try {
      const s = String(msg ?? '');
      if (/error|失败|异常|占用|超时|不可用|EOF|ECONN/i.test(s)) {
        this._recentErrors = this._recentErrors ?? [];
        this._recentErrors.push({ at: Date.now(), msg: s.slice(0, 160) });
        if (this._recentErrors.length > 200) this._recentErrors.splice(0, this._recentErrors.length - 200);
      }
    } catch {}
  }

  /** 面板 health 用：最近错误（最多 30 条，新的在后）。 */
  recentErrors(limit = 30) {
    if (!(limit > 0)) return [];
    return (this._recentErrors ?? []).slice(-limit);
  }
}

// 日期工具：yyyy-mm-dd（本地时区，自然日口径）
export function localDay(ts = Date.now()) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
