// 信号适配器：桥接 unread 只读轮询 + 会话 token 代发（设计约定十节、方案二.2b/c）
// 实测口径（2026-11-15 验证 1/2/8/9）：
//  - GET /api/socialV2/unread?key=&afterSeq= 带 x-console-token 且不带 x-agent-token = 纯只读（不抬水位）
//  - POST /api/send/{group|private} 带会话 agentToken = 代发被动回应，桥接不翻活跃
//  - 桥接 state：<dir>/state/console-token（控制台令牌）、<dir>/state/social-v2.json（conversations[key].agentToken/lastUnreadSeq）
//  - 消息对象：{seq, sender, userId, text, plain, quoteTargetIsSelf, kind:'poke'?, poke?{targetIsSelf}, time}
import fs from 'node:fs';
import path from 'node:path';

export class Signal {
  constructor(store, cfg) {
    this.store = store;
    this.cfg = cfg;
    this.timer = null;
    this.lastSeq = 0; // 桥接 seq 水位（只增；梦开演时取当前值起算）
    this.port = Number(cfg.bridge?.port) || 3100;
    this.bridgeDir = cfg.bridge?.dir || '';
    this.consoleToken = '';
    this.sessionId = ''; // 当前作用的会话（轮询用的映射来源）
    this.onSignal = null;
    this.#loadToken();
  }

  log(msg) { this.store.log(msg); }

  #loadToken() {
    try {
      const f = path.join(this.bridgeDir, 'state', 'console-token');
      if (fs.existsSync(f)) this.consoleToken = fs.readFileSync(f, 'utf8').trim();
    } catch { this.consoleToken = ''; }
    if (!this.consoleToken) this.log('signal: 未读到 console-token，轮询/代发将失败');
  }

  // 会话 id ↔ 桥接 key（设计约定十二节映射表）
  keyFor(sessionId) {
    const map = this.cfg.bridge?.keys ?? {};
    return String(map[sessionId] ?? '');
  }

  #agentTokenFor(key) {
    try {
      const f = path.join(this.bridgeDir, 'state', 'social-v2.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      return String(j?.conversations?.[key]?.agentToken ?? '');
    } catch { return ''; }
  }

  #currentSeq(key) {
    try {
      const f = path.join(this.bridgeDir, 'state', 'social-v2.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const v = j?.conversations?.[key]?.lastUnreadSeq;
      return v === undefined ? null : Number(v) || 0;
    } catch { return null; }
  }

  // 读桥接当前潜水状态（设计约定四节：DSH 自动休眠发生=桥接进入潜水；走神双源之一）
  // 桥接 mode 长期是 diving（只有 set_wake_config 写），不可靠；改用 confirmedAt 变化
  // ——她每次完成收尾设唤醒条件时都写 confirmedAt，这就是"她刚潜水/刚睡下"的时刻（审查 A02）
  // 返回 { mode, lastWakeAt, confirmedAt, confirmedBy }
  readDiveState(sessionId) {
    const key = this.keyFor(sessionId);
    if (!key) return { mode: null, lastWakeAt: 0, confirmedAt: 0 };
    try {
      const f = path.join(this.bridgeDir, 'state', 'social-v2.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const wc = j?.conversations?.[key]?.wakeConfig ?? {};
      return {
        mode: wc.mode === 'diving' ? 'diving' : (wc.mode ? 'active' : null),
        lastWakeAt: Number(wc.lastWakeAt) || 0,
        confirmedAt: Number(wc.confirmedAt) || 0,
        // 谁写的 confirmedAt：set_wake_config（她完成收尾=真入睡）还是 mark_read（只是划已读）
        confirmedBy: String(wc.confirmedBy ?? ''),
      };
    } catch {
      return { mode: null, lastWakeAt: 0, confirmedAt: 0, confirmedBy: '' };
    }
  }

  // 读她最近的外部对话（给走神生成提供上下文，方案二.5"注入其上下文"）
  readRecentText(sessionId, n = 5) {
    const key = this.keyFor(sessionId);
    if (!key) return '';
    try {
      const f = path.join(this.bridgeDir, 'state', 'social-v2.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const msgs = Array.isArray(j?.conversations?.[key]?.recentMessages) ? j.conversations[key].recentMessages : [];
      const recent = msgs.filter((m) => m && !m.isSelf && (m.plain || m.text)).slice(-n);
      return recent
        .map((m) => `${String(m.sender ?? '对方')}：${String(m.plain ?? m.text ?? '').slice(0, 60)}`)
        .join('\n');
    } catch { return ''; }
  }

  // 梦开演：启动轮询（只处理开演后的新消息）
  start(sessionId, onSignal) {
    this.stop();
    this.sessionId = String(sessionId);
    this.onSignal = onSignal;
    this.#loadToken(); // 每次启动重读令牌（DSH 先于桥接启动时，构造期拿不到令牌）
    const key = this.keyFor(this.sessionId);
    if (!key || !this.consoleToken) {
      this.log(`signal: 未配置桥接映射或令牌（key=${key || '空'}），轮询不启动`);
      return;
    }
    const base = this.#currentSeq(key);
    if (base === null) {
      // 起始水位读不到就不启动：把历史未读当新信号会直接断梦（审查 E13）
      this.log('signal: 读不到桥接 unread 水位，轮询不启动（本场梦无信号通道）');
      return;
    }
    this.lastSeq = base;
    this.failCount = 0;
    this.generation = (this.generation ?? 0) + 1; // 新一场轮询：代数+1（旧的在飞请求作废）
    const sec = this.cfg.signal?.pollIntervalSec ?? [2, 5];
    const lo = Array.isArray(sec) ? Math.max(0.5, Number(sec[0]) || 2) : 2;
    const hi = Array.isArray(sec) ? Math.max(lo, Number(sec[1]) || 5) : lo;
    this.intervalMs = Math.round((lo + Math.random() * (hi - lo)) * 1000);
    this.timer = setInterval(() => { this.#poll().catch(() => {}); }, this.intervalMs);
    this.timer?.unref?.();
    this.log(`signal: 轮询启动（${this.intervalMs}ms，key=${key}，起始 seq=${this.lastSeq}）`);
  }

  stop() {
    // 停干净：代数+1 让在飞 fetch 返回后不再 dispatch；清回调与翻页定时器（防卸载后继续代发/写盘）
    this.generation = (this.generation ?? 0) + 1;
    this.onSignal = null;
    this.sessionId = '';
    if (this.pageTimer) { clearTimeout(this.pageTimer); this.pageTimer = null; }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log('signal: 轮询停止');
    }
  }

  /** 轮询是否在跑（pre-step 通道据此决定"等轮询判定"还是降级为文本计数）。 */
  polling() { return !!this.timer; }

  /** 健康摘要（面板 GET 用）：轮询是否在跑、最近一次成功/失败、失败次数、最近水位。 */
  health() {
    return {
      polling: !!this.timer,
      intervalMs: this.intervalMs ?? null,
      lastSeq: this.lastSeq ?? null,
      failCount: this.failCount ?? 0,
      lastPollAt: this.lastPollAt ?? null,
      lastPollOk: this.lastPollOk ?? null,
      lastPollError: this.lastPollError ?? '',
      lastSignalAt: this.lastSignalAt ?? null,
      lastRollbackAt: this.lastRollbackAt ?? null,
      lastRollbackCount: this.lastRollbackCount ?? 0,
    };
  }

  /** 一个轮询周期 + 余量（毫秒）：pre-step 等轮询把这条消息计完/判完的最长时间。 */
  waitCycleMs() {
    const iv = Number(this.intervalMs) || 5000;
    return iv + 1200;
  }

  async #poll() {
    if (!this.sessionId) return;
    this.generation = this.generation ?? 0;
    const gen = this.generation;
    const key = this.keyFor(this.sessionId);
    if (!key) return;
    this.lastPollAt = Date.now();
    // 连续失败指数退避（方案六.3）：失败后挡掉后 n 次 tick，最多退到 30s
    if (this.skipTicks > 0) { this.skipTicks -= 1; return; }
    let res;
    try {
      const url = `http://127.0.0.1:${this.port}/api/socialV2/unread?key=${encodeURIComponent(key)}&afterSeq=${this.lastSeq}&limit=30`;
      res = await fetch(url, { headers: { 'x-console-token': this.consoleToken }, signal: AbortSignal.timeout(5000) });
    } catch (e) {
      this.#onPollFail(`signal poll ERROR: ${e?.message ?? e}`);
      return;
    }
    if (!res.ok) { this.#onPollFail(`signal poll HTTP ${res.status}`); return; }
    if (gen !== this.generation) return; // 期间已被 stop/重启：丢弃本次结果
    let data = {};
    try { data = await res.json(); } catch { return; }
    if (gen !== this.generation) return;
    if (data?.ok === false) { this.#onPollFail(`signal poll 返回失败：${data?.error ?? ''}`); return; }
    this.failCount = 0;
    this.skipTicks = 0;
    this.lastPollOk = Date.now();
    this.lastPollError = '';
    const msgs = Array.isArray(data?.messages) ? data.messages : [];
    // 空结果也可能意味着"水位回退"：真实桥接的 unread 按 afterSeq 严格过滤（> afterSeq），
    // 桥接重启后 seq 回到小值，用旧 afterSeq 会永远拿到空数组（2026-11-16 复测发现）。
    // 这里读桥接 state 的未读水位对齐，并同步清业务层去重（index.onDreamSignal 的 her.lastSignalSeq）。
    if (!msgs.length) {
      try {
        const cur = this.#currentSeq(key);
        if (cur !== null && this.lastSeq !== null && cur < this.lastSeq - 5) {
          this.log(`signal: 水位回退（插件 ${this.lastSeq} > 桥接 ${cur}，桥接可能重启），从头拉取未读`);
          this.lastRollbackAt = Date.now();
          this.lastRollbackCount = (this.lastRollbackCount ?? 0) + 1;
          this.lastSeq = 0; // 从 0 拉，避免 seq≤新水位的那批消息被跳过（桥接 unread 缓冲最多 30 条）
          try { const h = this.store.her?.(); if (h) delete h.lastSignalSeq; } catch {}
          if (this.pageTimer) clearTimeout(this.pageTimer);
          this.pageTimer = setTimeout(() => { this.pageTimer = null; this.#poll().catch(() => {}); }, 300);
        }
      } catch {}
      return;
    }
    // 有消息但 seq 明显回退（mock/兼容场景）：按新水位重置
    const seqs = msgs.map((m) => Number(m?.seq)).filter((n) => Number.isSafeInteger(n));
    if (seqs.length && this.lastSeq !== null && Math.max(...seqs) < this.lastSeq - 5) {
      this.log(`signal: 水位回退（当前 ${this.lastSeq}，收到 ${Math.min(...seqs)}-${Math.max(...seqs)}，桥接可能重启），按新水位重置`);
      this.lastRollbackAt = Date.now();
      this.lastRollbackCount = (this.lastRollbackCount ?? 0) + 1;
      this.lastSeq = Math.min(...seqs) - 1;
      try { const h = this.store.her?.(); if (h) delete h.lastSignalSeq; } catch {}
    }
    for (const m of msgs) {
      const seq = Number(m?.seq);
      if (Number.isSafeInteger(seq) && seq > this.lastSeq) this.lastSeq = seq;
      try { this.onSignal?.(m, key); } catch (e) { this.log(`signal onSignal ERROR: ${e?.message ?? e}`); }
    }
    // 一页拉满还有更多：同 tick 继续翻（unread 缓冲上限 30，冲过去就丢尾，方案验证 7）
    if (msgs.length >= 30 && gen === this.generation) {
      this.skipTicks = 0;
      if (this.pageTimer) clearTimeout(this.pageTimer);
      this.pageTimer = setTimeout(() => { this.pageTimer = null; this.#poll().catch(() => {}); }, 300);
    }
  }

  #onPollFail(msg) {
    this.failCount = Math.min(10, (this.failCount ?? 0) + 1);
    this.lastPollError = msg;
    this.lastPollOk = null;
    // 第一次失败立即记，之后降噪（每 10 次才记一次）
    if (this.failCount === 1 || this.failCount % 10 === 0) this.log(`${msg}（连续失败 ${this.failCount} 次，退避中）`);
    this.skipTicks = Math.min(8, Math.floor(this.failCount / 2));
  }

  // 代发被动回应（设计约定十节：弱/中档未断时插件代发迷糊语；失败不降级为中断）
  async sendPassive(sessionId, text) {
    const key = this.keyFor(sessionId);
    if (!key) return false;
    const token = this.#agentTokenFor(key);
    if (!token) { this.log('signal: 无会话 agentToken，代发放弃'); return false; }
    const [kind, id] = key.split(':');
    const url = `http://127.0.0.1:${this.port}/api/send/${kind === 'private' ? 'private' : 'group'}`;
    const body = kind === 'private'
      ? { token, userId: id, message: text }
      : { token, groupId: id, message: text };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-console-token': this.consoleToken },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        this.log(`signal: 代发失败 HTTP ${res.status} ${j?.error ?? ''}（梦继续，计数照常）`);
        return false;
      }
      this.log(`signal: 代发成功（${key}）${text}`);
      return true;
    } catch (e) {
      this.log(`signal: 代发失败 ${e?.message ?? e}（梦继续，计数照常）`);
      return false;
    }
  }
}
