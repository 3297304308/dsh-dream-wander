// 做梦主链路：入睡判定 → 曲线命中（判定时长内抽命中时刻）→ 执笔生成半幕
// → 内存缓冲 → 按时长注入滴放 → 收尾/中断 → 残留与副本（B 计划载体）
// 设计约定 v23 五节/八节/十一节/十七节：初始场景单独生成、单独先滴放；每半幕一次直连生成；
// 幕拍由插件判定、结果写进该幕提示词；收尾/中断/梦时长上限统一结算出口 #finish。

import fs from 'node:fs';
import path from 'node:path';
import { drawHitTime, pickRange } from './clock.js';
import { localDay } from './store.js';
import { Freq } from './freq.js';

export class Dream {
  constructor(ctx, store, cfg) {
    this.ctx = ctx;
    this.store = store;
    this.cfg = cfg;
    this.timers = new Map(); // agentId -> drip interval
    this._disposed = false;
  }

  // 插件卸载/热重载：旧实例必须停手（否则在飞生成结束后还会写 state/文件，覆盖新实例 —— 审查 H10）
  dispose() {
    this._disposed = true;
    try { this.#stopDrip(); } catch {}
    try { this._signal?.stop(); } catch {}
  }

  // 外部信号中断入口（index.js 敏感度判定后调用）
  async finishBySignal(agentId) {
    await this.#finishWithJudge(agentId, this.store.her(), 'interrupt');
  }

  // 非自然收尾统一出口：先停滴放→补梦境角色的判断（中断/超时都没有【收尾】标记）→再结算
  // _finishing 必须包住整个结算过程：结算里有 await（三词档的画面词调用最长 30 秒），
  // 若中途放开，60 秒 tick 或信号通道会二次进入、重复写副本/残留（审查 2026-11-16）
  async #finishWithJudge(agentId, st, reason) {
    if (this._disposed) return; // 旧实例卸载后不再结算
    if (st.status !== 'dreaming' || st._finishing) return;
    st._finishing = true;
    try {
      this.#stopDrip();
      let judgeOk = true;
      try {
        judgeOk = await this.#judgeBeforeFinish(agentId, st, reason);
      } catch (e) {
        this.store.log(`dream(${agentId}): 收尾判断异常 ${e?.message ?? e}`);
        judgeOk = false;
      }
      if (this._disposed) return;
      if (this.store.her().status !== 'dreaming') return; // judge 期间可能已被收尾
      if (judgeOk === false) {
        // 设计约定：判断调用失败→重试 2 次；仍失败按中断处理、残留"什么都没有"、心情"没感觉"
        this.store.log(`dream(${agentId}): 判断调用最终失败，按十节降级（残留=无、心情=没感觉）`);
        await this.#finish(agentId, st, 'judgefail', reason);
        return;
      }
      await this.#finish(agentId, st, reason);
    } finally {
      st._finishing = false;
    }
  }

  // 中断/超时收尾前补一次"梦境角色的判断+最深句指认"（设计约定十节 L110、十一节 L173）
  // 返回 true=判断已就绪/无需判断；false=调用最终失败（调用方按十节降级）
  async #judgeBeforeFinish(agentId, st, reason) {
    const d = st.dream;
    if (!d) return true;
    // 收尾/惊醒半幕里梦中角色已给出判断与最深句（含"中性"）→ 不再重复调用：
    // 否则二次判断会覆盖它自己指认的最深句（设计约定十一节 L173：最深句由梦中角色在收尾时指认；审查 M1）
    if (d.judgedByCharacter) return true;
    const releasedNow = d.released + [...(d.buffer ?? '')].slice(0, d.dripIdx ?? 0).join('');
    if (!releasedNow.trim()) return true; // 无已放出文本=初始场景未完成，残留 0、无判断
    let j = await this.#judgeAtInterrupt(releasedNow, reason);
    for (let attempt = 0; !j && attempt < (this.cfg.retry ?? 2); attempt++) {
      this.store.log(`dream(${agentId}): 判断调用空，重试 ${attempt + 1}/${this.cfg.retry ?? 2}`);
      await new Promise((r) => setTimeout(r, 3000));
      j = await this.#judgeAtInterrupt(releasedNow, reason);
    }
    if (!j) return false;
    if (j.moodKind && j.moodKind !== 'neutral') d.moodKind = j.moodKind;
    if (j.deepSentence) d.deepSentence = j.deepSentence;
    return true;
  }

  // 中断瞬间判断（只用已放出的文本；好/坏/中性 + 最深句原样摘抄）
  // reason 决定提示词里的情境：外部中断/时长上限/内部惊醒/自然收尾各有不同（设计约定/L143/L165）
  async #judgeAtInterrupt(released, reason = 'interrupt') {
    try {
      const situation = reason === 'timeout'
        ? '这场梦放到了时长上限、按自然结束收场。'
        : reason === 'internal'
          ? '梦里的角色在梦中惊醒/坠落，梦断在这里。'
          : reason === 'natural'
            ? '梦已经自然收尾。'
            : '梦被外面的动静叫醒了、断在这里。';
      const chunks = [];
      const ac = new AbortController();
      const watchdog = setTimeout(() => ac.abort(), 60_000);
      watchdog?.unref?.();
      const opts = {
        provider: this.cfg.llm?.provider ?? 'deepseek-account',
        model: this.cfg.llm?.model ?? 'deepseek-flash',
        reasoningEffort: 'low',
        maxTokens: 1000,
        sessionId: this._scopeSessionId || undefined,
        signal: ac.signal,
        system: `你是这场梦里的角色。${situation}只按两行格式回答：第一行只写"好"或"坏"或"中性"（这场梦给你的感觉）；第二行写"最深："加一句从梦文本里原样抄出的、这场梦记得最深的一句话（必须原样摘抄，不改写、不加解释）。`,
        messages: [{ role: 'user', content: [{ type: 'text', text: `已放出的梦（最后一部分）：\n${released.slice(-800)}\n请按格式回答两行。` }] }],
      };
      const agent = this.ctx.agents.get(this._scopeSessionId ?? '');
      const stream = agent
        ? this.ctx.agents.withInitiator(agent, () => this.ctx.llm.stream(opts))
        : this.ctx.llm.stream(opts);
      try {
        for await (const c of stream) {
          if (c.type === 'text-delta') chunks.push(c.text);
          if (c.type === 'finish' && c.reason?.kind === 'error') return null;
        }
      } finally {
        clearTimeout(watchdog);
      }
      const text = chunks.join('').trim();
      if (!text) return null;
      // 好坏：第一行优先严格接受"好/坏/中性"；不按格式时退回关键词启发式（并记日志）
      const firstLine = (text.split('\n')[0] ?? '').trim();
      let moodKind = 'neutral';
      if (/^好$/.test(firstLine)) moodKind = 'good';
      else if (/^坏$/.test(firstLine)) moodKind = 'bad';
      else if (/^中性$/.test(firstLine)) moodKind = 'neutral';
      else {
        this.store.log(`dream: 判断首行不是标准格式（${firstLine.slice(0, 12)}），退回关键词`);
        if (/不好|不美|不甜|不开心|不温暖|不舒服/.test(firstLine)) moodKind = 'bad';
        else if (/不坏|不糟|不难过/.test(firstLine)) moodKind = 'good';
        else if (/坏|噩|糟|难过|吓|可怕/.test(firstLine)) moodKind = 'bad';
        else if (/好|美|甜|开心|温暖/.test(firstLine)) moodKind = 'good';
      }
      // 最深句：必须真是已放出文本里的原样摘抄，否则丢弃（结算处会回退到最后一句）
      const dm = text.match(/最深[：:\s]*([^\n]+)/);
      let deepSentence = dm ? dm[1].trim() : '';
      if (deepSentence) {
        const norm = (s) => s.replace(/[。！？!?…\s「」"'']/g, '');
        if (!released.includes(deepSentence) && !norm(released).includes(norm(deepSentence))) {
        this.store.log('dream: 最深句不是原样摘抄，丢弃（不写日志正文）');
          deepSentence = '';
        }
      }
      this.store.log(`dream: 中断判断=${moodKind} 最深句=${deepSentence ? '有' : '无'}`); // 不把梦的原句写进日志
      return { moodKind, deepSentence };
    } catch (e) {
      this.store.log(`dream judge ERROR: ${e?.message ?? e}`);
      return null;
    }
  }

  // 启动恢复：崩溃/断电后未完成梦一律作废（设计约定：残留"什么都没有"、心情"没感觉"、画面不作留存）
  bootRecover() {
    const st = this.store.her();
    if (st.status === 'dreaming') {
      this.store.log('dream: 崩溃恢复，梦一律作废（不补做残留/心情/画面）');
      this.#stopDrip();
      this._signal?.stop();
      delete st._finishing; // 瞬态标记：崩溃/重载后不得残留（否则后续收尾永远被挡）
      delete st.dream;
      delete st.hitAt;
      delete st.pendingShapes;
      delete st.frame; // 未完成梦的画面不作留存
      delete st.groggy;
      delete st.groggyAt;
      // 不删 awakeAt/wokeBy/mood/residueAt：上一场已完成梦的残留与心情窗口继续有效（设计约定 只作废未完成的梦）
      this._interrupt?.clearCount(st);
      st.status = 'awake';
      st.wokeDay = localDay();
      // 开演时已扣额度（作者口径 2026-11-15：命中开演即扣，断不断都算），崩溃恢复不再重复扣
      this.store.saveHer();
    }
  }

  /** 健康摘要（面板 GET 用）：当前状态、今日额度、进行中的梦进度、最近一次收尾。 */
  health() {
    const st = this.store.her();
    const d = st?.dream;
    const releasedNow = d
      ? [...(d.released ?? '')].length + [...(d.buffer ?? '')].slice(0, d.dripIdx ?? 0).length
      : null;
    return {
      status: st?.status ?? 'awake',
      hitAt: st?.hitAt ?? null,
      remaining: st?.remaining ?? null,
      usedCount: st?.usedCount ?? null,
      allocDay: st?.allocDay ?? null,
      dreamAt: st?.dreamAt ?? null,
      dreamHalfN: d?.halfN ?? null,
      dreamReleasedChars: releasedNow,
      dreamStartAt: d?.startAt ?? null,
      lastFinish: this._lastFinish ?? null,
    };
  }

  // 巡检（index.js 周期调用）
  tick(agentId, aloneMs) {
    const j = this.cfg.judge;
    const st = this.store.her();
    const now = Date.now();
    const freqEmpty = !this.freqRef() || this.freqRef().pool.size === 0;

    if (st.status === 'awake') {
      if (aloneMs < j.confirmH * 3600_000) return;
      // 确认入睡（静默满 confirmH）。入睡状态机与"做梦"开关解耦：只关做梦、开着走神时也要能识别角色睡着
      st.status = 'sleeping';
    // 额度日=入睡日（最后活动那天），不是确认入睡那天：跨 0 点的梦占入睡日名额、不占次日（设计约定）
    const sleepDay = localDay(now - aloneMs);
      const maxK = Math.max(0, Math.floor(Number(j.dreamsPerDay) || 0)); // Kmax：当日允许的梦数上限（Kmin 已废弃）
      // 新的一天：当天额度 = Kmax（作者口径：K 不是抽的，是用户配置的允许值）
      if (st.allocDay !== sleepDay) {
        st.allocDay = sleepDay;
        st.usedCount = 0;
        st.remaining = maxK;
        this.store.log(`dream(${agentId}): 新的入睡日（${sleepDay}），额度 ${st.remaining}/${maxK}`);
      }
      if (!this.cfg.dreamEnabled) { this.store.saveHer(); return; }
      if ((st.remaining ?? 0) <= 0) {
        // 额度用完：当天后续睡眠段不再判定（作者口径：K=0 就不判做不做梦了）
        this.store.saveHer();
        return;
      }
      if (freqEmpty) {
        // 池空：本段不判定（设计约定：无素材不做梦），有词入池后的下一段睡眠再判，不占额度
        this.store.log(`dream(${agentId}): 入睡但池空，本段不判定（有词后下段再判）`);
        this.store.saveHer();
        return;
      }
      // 本段睡眠：从曲线抽命中时刻（睡满判定时长的命中率 = hitP）
      this.#armHit(agentId, st, now);
      this.store.saveHer();
      return;
    }

    if (st.status === 'sleeping') {
      // 命中时刻到且还有额度 → 开演；开演即扣额度（断不断都算，作者口径 2026-11-15）
      if (st.hitAt && now >= st.hitAt && (st.remaining ?? 0) > 0) {
        if (!this.cfg.dreamEnabled) {
          delete st.hitAt;
          this.store.saveHer();
          return;
        }
        st.remaining = Math.max(0, (st.remaining ?? 1) - 1);
        st.usedCount = (st.usedCount ?? 0) + 1;
        delete st.hitAt;
        this.store.log(`dream(${agentId}): 命中时刻到，开演（当日已用 ${st.usedCount}，剩 ${st.remaining}）`);
        this.#startDream(agentId, st).catch((e) => this.store.log(`dream(${agentId}): 开演流程异常 ${e?.message ?? e}`));
      }
      return;
    }

    if (st.status === 'dreaming') {
      const p = this.cfg.play;
      if (now - st.dream.startAt >= p.maxDurationMin * 60_000) {
        this.store.log(`dream(${agentId}): 梦时长上限到点，自然结束`);
        this.#finishWithJudge(agentId, st, 'timeout').catch(() => {}); // 先补判断再结算（异步）
      }
    }
  }

  // 新消息到达（外部信号）
  onMessage(agentId) {
    const st = this.store.her();
    if (st.status === 'dreaming') {
      this.store.log(`dream(${agentId}): 外部中断`);
      this.#finishWithJudge(agentId, st, 'interrupt').catch(() => {});
      return;
    }
    if (st.status === 'sleeping') {
      // 睡眠中醒来：本段判定作废。命中时刻没到就不扣额度（作者口径：判上了才 K−1）
      const hadHit = !!st.hitAt;
      delete st.hitAt;
      delete st.hitMissed;
      st.status = 'awake';
      st.wokeDay = localDay();
      // 做过梦（dreamAt）也算"有东西可注入"：生成失败的梦没有心情/残留，但"做过梦"事实要能注入（归属检查需要 wokeBy）
      if (st.mood || st.residueAt || st.dreamAt) {
        st.awakeAt = Date.now();
        st.wokeBy = agentId;
        st.wokeAt = st.awakeAt; // 画面/做过梦/归属用唤醒时刻（审查 P0-4）
      }
      // 残留 24h 锚点=角色真正醒来那一刻（每场新梦结算时清空重记，设计约定）
      if (st.residueAt && st.awakeAt && !st.residueWakeAt) st.residueWakeAt = st.awakeAt;
      if (hadHit) this.store.log(`dream(${agentId}): 本段命中时刻未到就醒了，本段作废（不扣额度）`);
      this.store.saveHer();
    }
  }

  // 本段睡眠：从曲线抽命中时刻（判定时长从"确认入睡"起算；睡满整段的命中率 = hitP）
  // 命中时刻到了角色还在睡 → 开演并扣 1 场额度；提前醒 → 本段作废、不扣额度。
  #armHit(agentId, st, now) {
    const j = this.cfg.judge;
    delete st.hitAt;
    delete st.hitMissed;
    const T = drawHitTime(j.windowH, j.hitP, j.lambdaHours, j.lambdaRatio);
    if (T === null) {
      st.hitMissed = true;
      this.store.log(`dream(${agentId}): 本段睡眠未命中（曲线，睡满时长 hitP=${j.hitP}），继续睡不扣额度`);
      return;
    }
    st.hitAt = now + T * 3600_000;
    const eta = new Date(st.hitAt).toLocaleTimeString('zh-CN', { hour12: false });
    this.store.log(`dream(${agentId}): 本段命中时刻 ≈ ${T.toFixed(2)}h 后（${eta}；判定时长 ${j.windowH}h，当日额度剩 ${st.remaining}）`);
  }

  async #startDream(agentId, st) {
    st.status = 'dreaming';
    // 信号轮询启动（设计约定十节：做梦期间按敏感度分流外部信号；只读 unread、不抬水位）
    this._signal?.start(this._scopeSessionId || agentId, this._onSignal);
    st.dream = {
      startAt: Date.now(),
      released: '',
      halfN: 0,
      buffer: '',
      dripIdx: 0,
      dripIntervalMs: 1000,
    };
    // 新一场梦：信号去重基线重置——桥接重启/重建 state 后 seq 会回退，
    // 若沿用上一场的 lastSignalSeq，新消息会被当旧消息全部跳过（审查 2026-11-16）
    delete st.lastSignalSeq;
    this.store.saveHer();
    // 初始场景单独生成、单独先滴放（设计约定九节：≤50 字；计入第一半幕配额与放送间隔）
    let sceneRes = await this.#generateScene(agentId, st);
    if (this._disposed) return; // 旧实例卸载后不再往下走（审查 H10）
    // 失败重试（与半幕同口径：间隔 3 秒避开凭证瞬时错误）
    for (let attempt = 0; !sceneRes && attempt < this.cfg.retry; attempt++) {
      this.store.log(`dream(${agentId}): 场景生成空，重试 ${attempt + 1}/${this.cfg.retry}`);
      await new Promise((r) => setTimeout(r, 3000));
      if (this._disposed) return;
      if (this._disposed || !st.dream || st.status !== 'dreaming') {
        this.store.log(`dream(${agentId}): 场景重试返回时梦已结束，丢弃`);
        return;
      }
      sceneRes = await this.#generateScene(agentId, st);
      if (this._disposed) return;
    }
    if (this._disposed || !st.dream || st.status !== 'dreaming') {
      this.store.log(`dream(${agentId}): 场景生成返回时梦已结束，丢弃`);
      return;
    }
    if (!sceneRes || !sceneRes.text) {
      this.store.log(`dream(${agentId}): 场景生成失败`);
      await this.#finish(agentId, st, 'genfail');
      return;
    }
    const scene = sceneRes.text;
    // 方向词=素材里没用于开场的词（设计约定；解析不到开场词时退回按索引发，至少不重复已确认的）
    const allWords = this.#words(agentId);
    let dirWords = allWords.slice();
    if (sceneRes.used?.length) dirWords = allWords.filter((w) => !sceneRes.used.includes(w));
    st.dream.dirWords = dirWords.slice(0, 3);
    const p = this.cfg.play;
    const intervalMin = pickRange(p.intervalMin);
    // 首幕配额与放送间隔：场景 + 首幕剩余共享同一个放送间隔（设计约定），
    // 实现=两段共用同一字速（间隔 ÷ 首幕配额字数），而不是各吃一个完整间隔。
    const firstBase = Math.max(1, Math.round(pickRange(p.halfChars)));
    st.dream.intervalMin = intervalMin; // 兼容字段（旧逻辑读取）
    st.dream.firstBaseChars = firstBase;
    st.dream.firstBudgetMs = intervalMin * 60_000;
    st.dream.sceneChars = [...scene].length; // 第一半幕配额扣减
    st.dream.buffer = scene;
    st.dream.dripIdx = 0;
    st.dream.dripIntervalMs = st.dream.firstBudgetMs / firstBase;
    this.store.log(`dream(${agentId}): 初始场景 ${[...scene].length} 字（首幕配额 ${firstBase} 字，字速 ${Math.round(st.dream.dripIntervalMs)}ms/字，首幕合计约 ${intervalMin} 分钟）`);
    this.store.saveHer();
    this.#stopDrip();
    const t = setInterval(() => this.#drip(agentId, st), st.dream.dripIntervalMs);
    this.timers.set(agentId, t);
  }

  // 初始场景生成（≤50 字，只写场景；设计约定：哪两个词关联最强、怎么组合，全由幻觉自行决定）
  async #generateScene(agentId, st) {
    const words = this.#words(agentId);
    const wordsHint = words.length
      ? `素材词：${words.join('、')}。由其中关联最强的两个词搭出初始场景（50 字内，只写场景本身，不展开情节）。`
        + `\n写完后另起一行，用【用词】标出你实际用于开场的两个词（用顿号隔开），例如：【用词】${words[0] ?? 'A'}、${words[1] ?? 'B'}`
      : '请写一个梦的开场场景（50 字内，只写场景本身，不展开情节）。';
    try {
      const chunks = [];
      const agent = this.ctx.agents.get(this._scopeSessionId || agentId);
      this.store.log(`scene stream start`);
      const ac = new AbortController();
      const watchdog = setTimeout(() => {
        this.store.log('scene stream watchdog: 60 秒无进展，中止');
        ac.abort();
      }, 60_000);
      watchdog?.unref?.();
      const stream = agent
        ? this.ctx.agents.withInitiator(agent, () => this.ctx.llm.stream({
          provider: this.cfg.llm?.provider ?? 'deepseek-account',
          model: this.cfg.llm?.model ?? 'deepseek-flash',
          reasoningEffort: 'high',
          maxTokens: 2000, // 与半幕对齐：400 会被 reasoning 烧光 → finish length 零文本
          sessionId: this._scopeSessionId || agentId,
          signal: ac.signal,
          system: '你是梦境中的自己，正在经历一场梦。只输出梦境的开场场景本身（环境、氛围，50 字内），不要任何解释、不要情节推进。',
          messages: [{ role: 'user', content: [{ type: 'text', text: wordsHint }] }],
        }))
        : this.ctx.llm.stream({
          provider: this.cfg.llm?.provider ?? 'deepseek-account',
          model: this.cfg.llm?.model ?? 'deepseek-flash',
          reasoningEffort: 'high',
          maxTokens: 2000,
          sessionId: this._scopeSessionId || agentId,
          signal: ac.signal,
          system: '你是梦境中的自己，正在经历一场梦。只输出梦境的开场场景本身（环境、氛围，50 字内），不要任何解释、不要情节推进。',
          messages: [{ role: 'user', content: [{ type: 'text', text: wordsHint }] }],
        });
      let text = '';
      try {
        for await (const c of stream) {
          if (c.type === 'text-delta') chunks.push(c.text);
          if (c.type === 'finish') {
            this.store.log(`scene stream finish: ${JSON.stringify(c.reason)}`);
            if (c.reason.kind === 'error') return null;
          }
        }
      } finally {
        clearTimeout(watchdog);
      }
      text = chunks.join('').trim();
      if (!text) return null;
      // 解析"实际用到的开场词"：方向词只能用素材里没用于开场的词（设计约定；审查 H8）
      const usedM = text.match(/【用词】\s*([^\n【]+)/);
      const used = usedM
        ? usedM[1].split(/[、,，\s]+/).map((x) => x.trim()).filter((x) => x && words.includes(x))
        : [];
      const body = text.replace(/【用词】[\s\S]*$/, '').trim();
      const scene = [...body].slice(0, 50).join('');
      return scene ? { text: scene, used } : null;
    } catch (e) {
      this.store.log(`scene generate ERROR: ${e?.message ?? e}`);
      return null;
    }
  }

  // 生成下一半幕并开始滴放
  async #nextHalf(agentId, st) {
    const p = this.cfg.play;
    const words = this.#words(agentId);
    const base = st.dream.halfN === 0 && st.dream.firstBaseChars
      ? st.dream.firstBaseChars
      : Math.round(pickRange(p.halfChars));
    // 第一半幕配额扣场景字数（设计约定九节：场景计入第一半幕字数配额与放送间隔）
    const halfChars = st.dream.halfN === 0 && st.dream.sceneChars
      ? Math.max(30, base - st.dream.sceneChars)
      : base;
    // 变形素材（拍/@/点名未断信号，设计约定十节）：写入本半幕生成提示词
    let shapeHint = '';
    if (st.pendingShapes?.length) {
      shapeHint = `【入梦变形】梦里忽然混进这些动静（与原声保持关联、别太离谱，可化入情节）：\n${st.pendingShapes.map((x) => `· ${x}`).join('\n')}`;
      delete st.pendingShapes;
    }
    // actsPerRelease≥1 时可能攒着未放的半幕：生成前文要带上，否则上下文断裂（终审 P2-21）
    const priorText = st.dream.released + (st.dream.pendingHalf ?? '');
    let text = await this.#generate(agentId, st, priorText, words, halfChars, st.dream.halfN, shapeHint);
    // await 期间 tick 可能已收尾（1h 超时/中断）删掉 st.dream——判空防竞态
    if (this._disposed || !st.dream || st.status !== 'dreaming') {
      this.store.log(`dream(${agentId}): 生成返回时梦已结束，丢弃`);
      return;
    }
    // 失败重试（设计约定十节：重试 2 次；间隔 3 秒以避开重启后凭证未就绪的瞬时错误）
    for (let attempt = 0; !text && attempt < this.cfg.retry; attempt++) {
      this.store.log(`dream(${agentId}): 半幕生成空，重试 ${attempt + 1}/${this.cfg.retry}`);
      await new Promise((r) => setTimeout(r, 3000));
      // 睡醒后先判空，防 st.dream 已被 tick 收尾删掉（空指针）
      if (this._disposed || !st.dream || st.status !== 'dreaming') {
        this.store.log(`dream(${agentId}): 重试等待时梦已结束，丢弃`);
        return;
      }
      text = await this.#generate(agentId, st, priorText, words, halfChars, st.dream.halfN, shapeHint);
      if (this._disposed || !st.dream || st.status !== 'dreaming') {
        this.store.log(`dream(${agentId}): 重试返回时梦已结束，丢弃`);
        return;
      }
    }
    if (!text) { // 生成失败：按中断处理
      this.store.log(`dream(${agentId}): 半幕生成失败`);
      await this.#finish(agentId, st, 'genfail');
      return;
    }
    const [body, closed, moodKind, deepSentence, closeKind] = this.#stripCloseMark(text);
    // 每次放送幕数（设计约定十二节 actsPerRelease）：0.5=每半幕一次放送（默认）；≥1=攒整幕再一次放送
    const apr = Number(this.cfg.play?.actsPerRelease ?? 0.5);
    if (closed) {
      // 收尾/惊醒半幕也先滴放再结束（设计约定八节：只放出过的文本才算"已放出"，档位/副本/画面按此计）
      st.dream.moodKind = moodKind;
      if (deepSentence) st.dream.deepSentence = deepSentence;
      st.dream.closing = true;
      // 只有"判断+最深句都在"才算收尾判断完成；只给了【收尾】中性却没给【最深】的，
      // 结束后仍要补判一次（否则残留兜底句会落到元信息上，审查 H9）
      st.dream.judgedByCharacter = !!deepSentence;
      // 内部中断（梦内坠落/失足/剧痛自断，设计约定十节 L143）：滴放后按中断结算（角色惊醒、画面 30min）
      st.dream.internalInterrupt = closeKind === 'wake';
      st.dream.halfN += 1;
      // 收尾文本接在已缓存半幕之后（actsPerRelease≥1 时可能攒着半幕未放）
      const pending = st.dream.pendingHalf ?? '';
      st.dream.pendingHalf = '';
      st.dream.pendingActs = 0;
      // 设计约定：收尾标记与判断不剥离、计入字数——滴放全量原文
      st.dream.buffer = pending + text;
      st.dream.dripIdx = 0;
      // 首幕剩余与场景共用同一字速（设计约定：两段合计约一个放送间隔）；之后各半幕各自抽间隔再按字数分摊
      const perCharMs = st.dream.halfN === 1 && st.dream.firstBudgetMs && st.dream.firstBaseChars
        ? st.dream.firstBudgetMs / st.dream.firstBaseChars
        : (pickRange(p.intervalMin) * 60_000) / Math.max(1, [...st.dream.buffer].length);
      st.dream.dripIntervalMs = perCharMs;
      this.store.log(`dream(${agentId}): ${closeKind === 'wake' ? '惊醒（内部中断）' : '收尾'}半幕 ${[...text].length} 字（${moodKind}），滴放后结束`);
      this.store.saveHer();
      this.#stopDrip();
      const t = setInterval(() => this.#drip(agentId, st), st.dream.dripIntervalMs);
      this.timers.set(agentId, t);
      return;
    }
    st.dream.halfN += 1;
    // 攒整幕放送：先入缓存、立即触发下一半幕生成（不等待滴放，防死锁）
    let sendText = body;
    if (apr >= 1) {
      const pending = st.dream.pendingHalf ?? '';
      if ((st.dream.pendingActs ?? 0) + 0.5 < apr) {
        st.dream.pendingHalf = pending + body;
        st.dream.pendingActs = (st.dream.pendingActs ?? 0) + 0.5;
        this.store.log(`dream(${agentId}): 第 ${st.dream.halfN} 半幕入缓存（累计 ${st.dream.pendingActs} 幕 < ${apr}），继续生成`);
        this.store.saveHer();
        this.#nextHalf(agentId, st).catch(() => {});
        return;
      }
      sendText = pending + body;
      st.dream.pendingHalf = '';
      st.dream.pendingActs = 0;
    }
    st.dream.buffer = sendText;
    st.dream.dripIdx = 0;
    // 场景与首幕共享同一放送间隔（设计约定）：首幕剩余用与场景相同的字速；
    // 后续半幕各自抽 intervalMin，再按字数分摊成每字毫秒（不能把整幕时长当每字时长）
    const perCharMs = st.dream.halfN === 1 && st.dream.firstBudgetMs && st.dream.firstBaseChars
      ? st.dream.firstBudgetMs / st.dream.firstBaseChars
      : (pickRange(p.intervalMin) * 60_000) / Math.max(1, [...sendText].length);
    st.dream.dripIntervalMs = perCharMs;
    this.store.log(`dream(${agentId}): 第 ${st.dream.halfN} 半幕 ${[...sendText].length} 字，间隔 ${Math.round(st.dream.dripIntervalMs)}ms/字`);
    this.store.saveHer();
    // 滴放定时器
    this.#stopDrip();
    const t = setInterval(() => this.#drip(agentId, st), st.dream.dripIntervalMs);
    this.timers.set(agentId, t);
  }

  #drip(agentId, st) {
    try {
      const d = st.dream;
      if (this._disposed || !d || st.status !== 'dreaming') return;
      const chars = [...d.buffer];
      if (d.dripIdx < chars.length) {
        d.dripIdx += 1;
        // 每 30 字落一次盘（状态持久化）
        if (d.dripIdx % 30 === 0) this.store.saveHer();
      } else {
        // 半幕滴完：并入 released；收尾半幕滴完则结束（自然 or 内部中断），否则生成下一半幕
        d.released += d.buffer;
        d.buffer = '';
        this.#stopDrip();
        if (d.closing) {
          if (d.internalInterrupt) {
            // 内部中断（设计约定：角色未醒，待真正醒来方算梦醒）——补判断后按 internal 结算
            this.store.log(`dream(${agentId}): 惊醒半幕滴放完毕，内部中断结束`);
            this.#finishWithJudge(agentId, st, 'internal').catch(() => {});
          } else {
            this.store.log(`dream(${agentId}): 收尾半幕滴放完毕，自然结束`);
            // 自然收尾也走统一出口：已有收尾判断时直接结算，没有（缺最深句）时补判一次；
            // 同时拿到 _finishing 防重入保护，避免收尾期间外部信号并发结算
            this.#finishWithJudge(agentId, st, 'natural').catch(() => {});
          }
        } else {
          this.#nextHalf(agentId, st).catch((e) => this.store.log(`dream(${agentId}): 生成下一半幕异常 ${e?.message ?? e}`));
        }
      }
    } catch (e) {
      // 定时器回调内任何异常不得炸进程（落盘/结算失败只记日志）
      this.store.log(`drip ERROR: ${e?.message ?? e}`);
    }
  }

  #stopDrip() {
    // 滴放定时器全局唯一（梦状态在"角色"上），清全部、防键错配留僵尸
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }

  async #finish(agentId, st, reason, originalReason) {
    this.#stopDrip();
    this._signal?.stop();
    this._interrupt?.clearCount(st); // 梦结束计数随梦清空（设计约定十节）
    delete st.pendingShapes; // 未混入的变形随梦结束作废（设计约定十节）
    const d = st.dream ?? { released: '' };
    // 生成失败降级（设计约定十节 L163）：残留"什么都没有"、心情"没感觉"
    if (reason === 'genfail' || reason === 'judgefail') {
      this.store.log(`dream(${agentId}): ${reason === 'judgefail' ? '判断失败' : '生成失败'}，残留=无、心情=没感觉`);
      // 设计约定：副本只存档已放出的文本 → 有已放出的文本就照常归档（否则这场梦在存档里凭空消失）
      const releasedPartial = (d.released ?? '') + [...(d.buffer ?? '')].slice(0, d.dripIdx ?? 0).join('');
      if (releasedPartial.trim() && this._copy) {
        try {
          const day = localDay(d.startAt ?? Date.now());
          const seq = (st.usedSeq = (st.usedSeq ?? 0) + 1);
          const finalSeq = Math.max(seq, this.#nextSeqFor(day) + 1);
          this._copy.writeNew(day, finalSeq, releasedPartial);
          this.store.log(`dream(${agentId}): 失败但已放出 ${[...releasedPartial].length} 字，已归档副本 ${day}-${finalSeq}`);
        } catch (e) {
          this.store.log(`dream(${agentId}): 失败归档副本异常 ${e?.message ?? e}`);
        }
      }
      // 生成失败/判断失败也要归档已放出的文本、记"做过梦"（设计约定/L163/L179）
      if (releasedPartial && releasedPartial.trim()) st.dreamAt = d.startAt ?? Date.now();
      this._lastFinish = { reason, chars: [...(releasedPartial ?? '')].length, at: Date.now(), degraded: true };
      // 只有真放出过文本才算"做过梦"（0 字失败不注入做过梦事实——终审 P2）
      const wasDreaming = st.status === 'dreaming';
      delete st.mood;
      delete st.residueAt;
      delete st.residuePath;
      delete st.frame;
      // 额度在"命中开演"时已扣（作者口径 2026-11-15：断不断都算用掉一场），这里不再扣
      if (reason === 'judgefail') {
        // 判断失败仍按原中断路径结算醒睡（设计约定"按中断处理"）；但状态若已被别处结算（外部唤醒），不覆写
        if (!wasDreaming) {
          this.store.log(`dream(${agentId}): 判断失败时状态已是 ${st.status}（已由别处结算），不覆写`);
        } else {
          const sheWoke = originalReason === 'interrupt';
          st.status = sheWoke ? 'awake' : 'sleeping';
          if (sheWoke) {
            const wakeAt = Date.now();
            st.awakeAt = wakeAt;
            st.wokeBy = agentId;
            st.wokeAt = st.awakeAt; // 画面/做过梦/归属用唤醒时刻（审查 P0-4）
            st.residueWakeAt = wakeAt;
          } else {
            delete st.awakeAt;
            delete st.wokeBy;
          }
        }
      } else if (wasDreaming) {
        st.status = 'sleeping';
        delete st.awakeAt;
        delete st.wokeBy;
      } else {
        this.store.log(`dream(${agentId}): 生成失败时状态已是 ${st.status}（已由别处结算），不覆写`);
      }
      delete st.dream;
      delete st.hitAt;
      delete st.groggy;
      delete st.groggyAt;
      this.store.saveHer();
      return;
    }
    // 未滴完的缓冲丢弃（丢尾）；已放出文本=released+已滴放部分
    let released = d.released + [...(d.buffer ?? '')].slice(0, d.dripIdx ?? 0).join('');
    // 初始场景未完成即中断：残留按 0 处理（设计约定十一节：放多少算多少、场景未放完为 0）
    const sceneDone = !(d.sceneChars && [...released].length < d.sceneChars);
    if ((reason === 'interrupt' || reason === 'internal') && !sceneDone) {
      this.store.log(`dream(${agentId}): 初始场景未完成即中断，残留=0`);
      released = '';
    }
    this.store.log(`dream(${agentId}): 结束(${reason})，已放出 ${[...released].length} 字`);
    // 最后画面（设计约定十节/十一节）：中断=滴放末尾最后文本；自然=收尾前最后文本。
    // 剔除【收尾】/【惊醒】之后的判断与【最深】元标记：画面是角色脑中场景，不带格式标签（字数口径不动）
    const cleanTail = released.replace(/【(收尾|惊醒)】[\s\S]*$/, '');
    const chars = [...cleanTail];
    // 画面=最后"一帧"而不是最后 100 字剧情：优先取最后一句（。！？）；太长再截到 60 字。
    // 设计约定十一节："除该最后画面外，其余梦的内容一律不进角色的意识"——100 字常含多句对话/跨场景叙事，
    // 角色于是能复述远超"画面"的内容（审查 H1）。
    let frameText = '';
    if (chars.length) {
      const lastSentence = (() => {
        for (let i = chars.length - 1; i >= 0; i--) {
          if (/[。！？…]/.test(chars[i])) return chars.slice(i + 1).join('').trim() || chars.slice(-60).join('');
        }
        return chars.join('');
      })();
      frameText = [...lastSentence].slice(-60).join('').trim();
    }
    if (frameText) {
      // 1h 到点=自然结束（设计约定九节），画面按自然 2h；中断/内部中断按 30min 打码
      const frameKind = (reason === 'natural' || reason === 'timeout') ? 'natural' : 'interrupt';
      st.frame = { text: frameText, at: Date.now(), kind: frameKind };
    } else {
      // 没有已放出的文本（=初始场景未完成即中断）就没有"最后画面"：
      // 不能留着上一场梦的画面继续注入（设计约定十节 L164：画面只能是这一场中断瞬间的；审查 M2）
      delete st.frame;
    }
    // 心情（设计约定十一节）：按好坏标记定档；中性/未标=平淡（不设 mood 即不注入）
    const moodKind = d.moodKind ?? 'neutral';
    if (moodKind !== 'neutral') {
      st.mood = { kind: moodKind };
    } else {
      delete st.mood;
    }
    st.dreamAt = Date.now(); // "我做了个梦"基本事实的注入锚点
    this._lastFinish = { reason, chars: [...released].length, at: Date.now() };
    await this.#settleResidue(agentId, st, released, reason, frameText, d.deepSentence);
    if (this._disposed) return; // 卸载后不再写状态（防旧实例快照覆盖新实例）
    // 额度在"命中开演"时已扣（断不断都算），这里不再扣
    // 自然/超时/内部中断：现实角色仍在睡（回 sleeping，本段睡眠不再放场）；
    // 外部中断：角色已醒（回 awake），梦醒时刻当场记（设计约定/L191：内部中断角色未醒，待真正醒来方算梦醒）
    if (reason === 'interrupt') {
      st.status = 'awake';
      st.wokeDay = localDay();
      const wakeAt = Date.now();
      st.awakeAt = wakeAt;
      st.wokeBy = agentId;
      st.wokeAt = st.awakeAt; // 画面/做过梦/归属用唤醒时刻（审查 P0-4）
      st.residueWakeAt = wakeAt; // 残留 24h 锚点=梦醒那次（设计约定，其他唤醒不重置；每场新残留结算时清空重设）
    } else {
      st.status = 'sleeping';
      delete st.awakeAt; // 梦醒时刻随梦重置：残留/心情窗口自角色真正醒来起算
      delete st.wokeBy;
    }
    delete st.dream;
    delete st.hitAt;
    delete st.groggy; // 旧迷糊语不得带到下一场梦（设计约定十节：未断即废）
    delete st.groggyAt;
    delete st.releaseUntil; // 放行窗口（pre-step 等轮询判定用）随梦结束作废
    this.store.saveHer();
  }

  // 画面注入文本（按经过时间现算打码；过期返回 null）
  frameTextFor(st) {
    const f = st?.frame;
    if (!f || !f.text) return null;
    const cfg = this.cfg.frame ?? {};
    const now = Date.now();
    const ageMin = (now - f.at) / 60_000;
    if (f.kind === 'natural') {
      if (ageMin >= (cfg.naturalMin ?? 120)) return null;
      return f.text;
    }
    // 中断：留存期内按三等分阶梯打码（前 1/3 完整、中 1/3 遮一半、后 1/3 再遮一半，到点清空；默认 30 分钟即 0-10/10-20/20-30）
    const total = Math.max(1, Number(cfg.interruptMin ?? 30));
    if (ageMin >= total) return null;
    const p = ageMin / total;
    const ratio = p < 1 / 3 ? 1 : p < 2 / 3 ? 0.5 : 0.25;
    return this.#maskTo(f.text, ratio);
  }

  // 心情注入文本（2 小时窗口自现实角色真正醒来起算；画面已过期则没感觉、心情不变，设计约定）
  moodTextFor(st) {
    const m = st?.mood;
    if (!m) return null;
    if (!st.awakeAt) return null; // 现实角色还没醒，窗口未起算
    const sinceWake = Date.now() - st.awakeAt;
    if (sinceWake >= (this.cfg.mood?.hours ?? 2) * 3600_000) return null;
    if (!this.frameTextFor(st)) return null; // 无画面可凭=没感觉
    if (m.kind === 'good') return '你醒来后胸口暖洋洋的，像是刚做了什么好梦，心情还不错。';
    if (m.kind === 'bad') return '你醒来后心里有点沉，像是刚做了什么不好的梦，情绪还没散。';
    return null;
  }

  #nextSeqFor(day) {
    // 当日已有副本/残留文件的最大序号（文件已按 day-seq 命名）
    let max = 0;
    try {
      const dirs = [
        path.join(this.store.dir, '梦境副本'),
        path.join(this.store.dir, '残留'),
      ];
      for (const d of dirs) {
        for (const name of fs.readdirSync(d)) {
          const m = name.match(new RegExp(`^${day}-(\\d+)\\.md$`));
          if (m) max = Math.max(max, parseInt(m[1], 10));
        }
      }
    } catch {}
    return max;
  }

  // 残留与副本（档位按已放出字数；画面词仅 3 词档进入；最深句优先梦角色指认、中断回退最后一句）
  // 3 词档第三词：从"最后的画面"按重要性提取（一次小调用，设计约定十一节 L178；方案 v4 十节预留）
  async #pickFrameWord(frameText, excludeKeys) {
    try {
      const chunks = [];
      const ac = new AbortController();
      const watchdog = setTimeout(() => ac.abort(), 30_000);
      watchdog?.unref?.();
      const agent = this.ctx.agents.get(this._scopeSessionId ?? '');
      const opts = {
        provider: this.cfg.llm?.provider ?? 'deepseek-account',
        model: this.cfg.llm?.model ?? 'deepseek-flash',
        reasoningEffort: 'low',
        maxTokens: 200,
        sessionId: this._scopeSessionId || undefined,
        signal: ac.signal,
        system: '你只输出一个词，不要解释、不要标点。',
        messages: [{ role: 'user', content: [{ type: 'text', text: `这是梦的最后画面：\n${String(frameText ?? '').slice(0, 300)}\n哪个词是画面里最重要的东西（2-4 个字，名词或画面感强的词）？只输出这个词。` }] }],
      };
      const stream = agent
        ? this.ctx.agents.withInitiator(agent, () => this.ctx.llm.stream(opts))
        : this.ctx.llm.stream(opts);
      try {
        for await (const c of stream) {
          if (c.type === 'text-delta') chunks.push(c.text);
          if (c.type === 'finish' && c.reason?.kind === 'error') return '';
        }
      } finally { clearTimeout(watchdog); }
      const w = chunks.join('').trim().split('\n')[0].replace(/[^\p{L}\p{N}]/gu, '').trim();
      if (!w || [...w].length > 6) { this.store.log(`dream: 画面重要词非法（${JSON.stringify(w)}），回退词频`); return ''; }
      const k = w.toLowerCase();
      if (excludeKeys.includes(k)) { this.store.log(`dream: 画面重要词与前两词重复（${w}），回退词频`); return ''; }
      const f = this.freqRef();
      if (f?.isPronoun(k) || f?.isStopword(k) || !Freq.valid(k)) { this.store.log(`dream: 画面重要词不合格（${w}），回退词频`); return ''; }
      this.store.log(`dream: 画面重要词=${w}`);
      return w;
    } catch (e) { this.store.log(`frameWord ERROR: ${e?.message ?? e}`); return ''; }
  }

  async #settleResidue(agentId, st, released, reason, frameText, deepSentence) {
    const r = this.cfg.residue;
    const chars = [...released].length;
    if (chars === 0) { // 什么都没有：清旧残留（新梦覆盖旧梦，设计约定十一节）
      this.store.log(`dream(${agentId}): 残留=无`);
      delete st.residueAt;
      delete st.residuePath;
      this.store.saveHer();
      return;
    }
    const seq = (st.usedSeq = (st.usedSeq ?? 0) + 1);
    // 归档日期取梦开始时刻的自然日（设计约定十一节 L180；名额归属才是入睡日 st.day）
    const day = localDay(st.dream?.startAt ?? Date.now());
    // 副本序号单调递增：取"下一个场次号"与"已有文件最大号+1"的较大者（防重置/重启后覆盖旧文件）
    const finalSeq = Math.max(seq, this.#nextSeqFor(day) + 1);
    // 副本=梦原文载体（B 计划）：起始 80% 可见版（降档见 copy 模块）
    if (this._copy) this._copy.writeNew(day, finalSeq, released); // 写副本（副作用；失败内部已兜底）
    const releasedForMemory = String(released).replace(/【(收尾|惊醒)】[\s\S]*$/, ''); // 去掉协议标记（终审 M P1-4：副本/记忆只留正文）
    if (!this._copy) this.store.writeCopy(day, finalSeq, releasedForMemory);
    // 形态二：打码梦文本（设计约定十一节 2026-11-16 新增；与词句残留二选一）。
    // 全文按 residue.visibility 序列第 1 格打码，之后由 memory.degradeAll 按天降档、到期删。
    if (this.cfg.residue?.form === 'blur' && this._memory) {
      const name = this._memory.writeNew(day, finalSeq, releasedForMemory);
      if (name) {
        this.store.pruneResidue(name); // 角色手里只有最近一场梦的那份（新旧覆盖）
        st.residueAt = Date.now();
        st.residuePath = this._memory.pathOf(name);
        delete st.residueWakeAt;
        this.store.log(`dream(${agentId}): 梦醒记忆=打码梦文本（${name}，${chars} 字）`);
        this.store.saveHer();
        return;
      }
      this.store.log(`dream(${agentId}): 打码梦文本写入失败，回退词句残留`);
    }
    // 档位
    const tiers = r.tiers; // [50,100,200,300]
    let wordsN = 0, sentence = false;
    if (chars < tiers[0]) wordsN = 1;
    else if (chars < tiers[1]) sentence = true;
    else if (chars < tiers[2]) { wordsN = 1; sentence = true; }
    else if (chars < tiers[3]) { wordsN = 2; sentence = true; }
    else { wordsN = 3; sentence = true; }
    // 词：从 released（不含最后一句）按词频取 top N；代词/称呼/虚词不计入（设计约定六节）
    const f = this.freqRef();
    // 提词文本：排除保留句（设计约定十一节：三个关键词不从该保留句中提取）；
    // 另剔除【收尾】/【惊醒】之后的判断/【最深】元标记（判断词不参与提词；字数口径不动）
    const sourceText = released.replace(/【(收尾|惊醒)】[\s\S]*$/, '');
    // 最深一句：优先梦角色指认；无指认（中断梦）回退已放出正文的最后一句——
    // 必须从 sourceText 取，否则会兜底到"【收尾】中性"这类元信息（审查 H9）
    const fallbackSentences = sourceText.split(/[。！？.!?]/).map((x) => x.trim()).filter(Boolean);
    let deep = deepSentence || (fallbackSentences.length ? fallbackSentences[fallbackSentences.length - 1] : '');
    const freqSource = deep ? sourceText.replace(deep, '') : sourceText;
    const freq = new Map();
    const orig = new Map(); // 小写键 -> 原文词形
    const seg = new Intl.Segmenter('zh', { granularity: 'word' });
    for (const s of seg.segment(freqSource)) {
      if (!s.isWordLike) continue;
      const w = s.segment.trim();
      if (!w) continue;
      const k = w.toLowerCase();
      if (f?.isPronoun(k) || f?.isStopword(k)) continue;
      if (!Freq.valid(k)) continue; // 出词审查：英文碎片/纯数字不进取词（审查 B08）
      freq.set(k, (freq.get(k) ?? 0) + 1);
      if (!orig.has(k)) orig.set(k, w);
    }
    const topWords = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, wordsN === 3 ? 2 : wordsN).map(([k]) => orig.get(k) ?? k);
    // 3 词档：第三词从"最后的画面"按重要性提取（设计约定十一节 L178；方案 v4 十节预留的那次小调用）。
    // 先让模型判一次"画面里最重要的东西"，失败/不合格再回退到画面词频最高者（旧行为）。
    if (wordsN === 3 && frameText) {
      const topKeys = new Set(topWords.map((w) => w.toLowerCase()));
      let frameWord = await this.#pickFrameWord(frameText, [...topKeys]);
      if (this._disposed) return; // 卸载后不再继续结算
      if (!frameWord) {
        const fm = new Map();
        const origF = new Map();
        for (const s3 of seg.segment(frameText)) {
          if (!s3.isWordLike) continue;
          const w3 = s3.segment.trim();
          if (!w3) continue;
          const k3 = w3.toLowerCase();
          if (f?.isPronoun(k3) || f?.isStopword(k3)) continue;
          if (!Freq.valid(k3)) continue; // 出词审查（审查 B08）
          fm.set(k3, (fm.get(k3) ?? 0) + 1);
          if (!origF.has(k3)) origF.set(k3, w3);
        }
        frameWord = [...fm.entries()].sort((a, b) => b[1] - a[1]).find(([k3]) => !topKeys.has(k3))?.[0] ?? '';
        if (frameWord) frameWord = origF.get(frameWord) ?? frameWord;
      }
      if (frameWord) topWords.push(frameWord);
    }
    if (sentence && deep) {
      const deepChars = [...deep];
      const pick = (len) => Math.floor(Math.random() * Math.max(1, deepChars.length - len + 1));
      // 保留词取本句内最高频非代词词（优先 2+ 字词组）
      const wordInSentence = (() => {
        const m = new Map();
        const origS = new Map();
        for (const s2 of seg.segment(deep)) {
          if (!s2.isWordLike) continue;
          const w2 = s2.segment.trim();
          if (!w2) continue;
          const k2 = w2.toLowerCase();
          if (f?.isPronoun(k2) || f?.isStopword(k2)) continue;
          if (!Freq.valid(k2)) continue; // 出词审查（审查 B08）
          m.set(k2, (m.get(k2) ?? 0) + 1);
          if (!origS.has(k2)) origS.set(k2, w2);
        }
        if (!m.size) return '';
        const entries = [...m.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
        const multi = entries.find(([k2]) => [...k2].length >= 2);
        const k = (multi ?? entries[0])[0];
        // 输出原文词形：后面用 deep.indexOf 定位保留位，小写键在原文里找不到
        return origS.get(k) ?? k;
      })();
      // 保留位置全随机、互不重叠（设计约定十一节）：随机 3 字位 + 词组在句中出现位（随机挑一个不重叠的）
      let threeStart = pick(3);
      let wordIdx = -1;
      if (wordInSentence) {
        const positions = [];
        let idx = deep.indexOf(wordInSentence);
        while (idx >= 0) { positions.push(idx); idx = deep.indexOf(wordInSentence, idx + 1); }
        for (const pos of positions) {
          const wEnd = pos + [...wordInSentence].length;
          if (threeStart + 3 <= pos || threeStart >= wEnd) { wordIdx = pos; break; } // 不重叠
        }
        if (wordIdx < 0 && positions.length) {
          // 所有出现位都重叠：重抽三字位直到不重叠
          for (let tries = 0; tries < 30 && wordIdx < 0; tries++) {
            threeStart = pick(3);
            for (const pos of positions) {
              const wEnd = pos + [...wordInSentence].length;
              if (threeStart + 3 <= pos || threeStart >= wEnd) { wordIdx = pos; break; }
            }
          }
        }
      }
      const keepSet = new Set();
      for (let i = threeStart; i < threeStart + 3 && i < deepChars.length; i++) keepSet.add(i);
      if (wordIdx >= 0) {
        for (let i = wordIdx; i < wordIdx + [...wordInSentence].length && i < deepChars.length; i++) keepSet.add(i);
      }
      deep = deepChars.map((c, i) => (keepSet.has(i) ? c : '□')).join('');
    }
    const residueText = [
      `梦（${reason}）`,
      topWords.length ? `词：${topWords.join('、')}` : '',
      // 设计约定：不足 50 字=1 词（无句子档）；句子只在 sentence 档写入
      (sentence && deep) ? `记得最深的一句：${deep}` : '',
    ].filter(Boolean).join('\n');
    this.store.writeResidue(day, finalSeq, residueText);
    // 残留只留最新一份（设计约定：角色手里只有最近一场梦的那份；旧文件被覆盖即物理删除）
    this.store.pruneResidue(`${day}-${finalSeq}.md`);
    // 残留 24h 计时与文件位置（注入层用）
    st.residueAt = Date.now();
    st.residuePath = this.store.residuePath(day, finalSeq);
    // 新残留覆盖旧梦：24h 锚点作废，等角色真正醒来时再记（设计约定：只在梦醒那次起算）
    delete st.residueWakeAt;
    // 心情（中性不注入；"双重判断"口径=现实角色看到画面后自行反应，不做系统计算，见设计约定）
    this.store.log(`dream(${agentId}): 残留档位 词x${wordsN} 句=${sentence}`);
  }

  // 打码到目标可见比例（位置随机、不塌缩；同一文本同比例结果稳定——用文本 hash 做种子）
  #maskTo(text, visibleRatio) {
    const chars = [...text];
    if (!chars.length) return text;
    const keepN = Math.max(0, Math.round(chars.length * visibleRatio));
    if (keepN >= chars.length) return text;
    // 确定性随机排列（seed=文本 hash）
    let seed = 0;
    for (const ch of text) seed = (seed * 31 + ch.codePointAt(0)) % 1_000_000_007;
    const order = chars.map((_, i) => i);
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const maskIdx = new Set(order.slice(0, chars.length - keepN));
    return chars.map((c, i) => (maskIdx.has(i) ? '□' : c)).join('');
  }

  #stripCloseMark(text) {
    // 收尾标记【收尾】=自然收尾；内部中断标记【惊醒】=梦内坠落/失足/剧痛等自断（设计约定十节 L143）
    const closeMark = '【收尾】';
    const wakeMark = '【惊醒】';
    const ci = text.indexOf(closeMark);
    const wi = text.indexOf(wakeMark);
    const useWake = wi >= 0 && (ci < 0 || wi < ci);
    const mark = useWake ? wakeMark : closeMark;
    const i = useWake ? wi : ci;
    if (i < 0) return [text, false];
    const tail = text.slice(i + mark.length).trim();
    // 好坏判断只用【最深】之前的文本；先严格接受"好/坏/中性"，不按格式再退回关键词
    const judgePart = tail.split('【最深】')[0];
    const firstJudgeLine = (judgePart.split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? '');
    let moodKind = 'neutral';
    if (/^好$/.test(firstJudgeLine)) moodKind = 'good';
    else if (/^坏$/.test(firstJudgeLine)) moodKind = 'bad';
    else if (/^中性$/.test(firstJudgeLine)) moodKind = 'neutral';
    else {
      if (/不好|不美|不甜|不开心|不温暖|不舒服|不痛快/.test(judgePart)) moodKind = 'bad';
      else if (/不坏|不糟|不难过/.test(judgePart)) moodKind = 'good';
      else if (/坏|噩|糟|难过|吓|可怕/.test(judgePart)) moodKind = 'bad';
      else if (/好|美|甜|开心|温暖/.test(judgePart)) moodKind = 'good';
    }
    // 梦角色指认的最深句（【最深】包裹；无则空）
    const deepM = tail.match(/【最深】([^【】]+)/);
    let deepSentence = deepM ? deepM[1].trim() : '';
    // 设计约定：最深句必须是已写出文本的原样摘抄；模型自造/改写就丢弃（结算回退最后一句）
    if (deepSentence && !text.includes(deepSentence)) {
      this.store.log('dream: 自然收尾的最深句不是原样摘抄，丢弃');
      deepSentence = '';
    }
    return [text.slice(0, i).trim(), true, moodKind, deepSentence, useWake ? 'wake' : 'close'];
  }

  #words(agentId) {
    // 入梦素材：开演时一次性抽词存 dream.words，逐幕发放（设计约定六节：未发放的词不进提示词）
    const st = this.store.her();
    if (!st.dream?.words) {
      const f = this.freqRef();
      st.dream.words = f ? f.drawWords() : [];
    }
    return st.dream.words ?? [];
  }

  async #generate(agentId, st, released, words, halfChars, halfN, shapeHint = '') {
    const p = this.cfg.play;
    const jump = this.cfg.actJump;
    // 幕拍：整幕判定（设计约定十七节）；首幕（halfN 0/1）不判定；场景跳与时间跳按基础概率独立判定、可同时发生
    let scene = false, time = false;
    if (halfN >= 2 && halfN % 2 === 0) {
      scene = Math.random() < jump.sceneP;
      time = Math.random() < jump.timeP;
    }
    // 跳跃关联程度（0-1）：跳跃发生时与上一幕的关联松紧，只写进提示词、不参与概率判定
    const linkage = (() => {
      const v = Number(jump.linkage);
      if (!Number.isFinite(v)) return '较紧'
      if (v <= 0.1) return '完全断开（可以直接跳到无关的场面）'
      if (v <= 0.3) return '松散（只保留一点点联系）'
      if (v <= 0.55) return '中等（看得出与上一幕相关）'
      if (v <= 0.75) return '较紧（与上一幕有明显关联）'
      return '紧密（几乎无缝衔接、像同一场面的延续）'
    })()
    // 基础幕拍规则对每一幕都下发（设计约定：因果不断、动作可断、要有心理活动）；首幕没有跳跃判定
    const baseRules = '因果不断、动作可断；要有心理活动（"我觉得""我想"）；若想收尾，结尾输出【收尾】标记。';
    const jumpHint = halfN === 0
      ? `【幕拍】${baseRules}`
      : `【幕拍】${scene ? '本幕场景更换（地点变化，不交代如何过去）。' : ''}${time ? '本幕时间跳跃（略去中间一段时间，位置不变）。' : ''}${!scene && !time ? '本幕场景与时间延续上一幕。' : ''}${scene || time ? `跳跃时与上一幕的关联程度：${linkage}。` : ''}${baseRules}`;
    // 方向词=未用于开场的词（st.dream.dirWords），逐幕发放（设计约定八节 L127-128）：
    // 首幕（halfN=0，即场景之后的第一次生成）发第 1 个，之后每幕开头各发一个（halfN=2、4）。
    // 注意 halfN 是"已生成半幕数"（生成时还没自增），旧映射按 1/3/5 写会整体晚一幕（审查 2026-11-16）
    const dirWords = st?.dream?.dirWords ?? [];
    const wordsHint = dirWords.length
      ? (() => {
          const idx = halfN === 0 ? 0 : halfN === 2 ? 1 : halfN === 4 ? 2 : -1;
          if (idx < 0 || idx >= dirWords.length) return '';
          return `方向词（可选入梦）：${dirWords[idx]}。`;
        })()
      : '';
    try {
      const chunks = [];
      const agent = this.ctx.agents.get(this._scopeSessionId || agentId);
      const ac = new AbortController();
      const watchdog = setTimeout(() => {
        this.store.log('half stream watchdog: 60 秒无进展，中止');
        ac.abort();
      }, 60_000);
      watchdog?.unref?.();
      const opts = {
        provider: this.cfg.llm?.provider ?? 'deepseek-account',
        model: this.cfg.llm?.model ?? 'deepseek-flash',
        reasoningEffort: 'high',
        maxTokens: 2000,
        sessionId: this._scopeSessionId || agentId,
        signal: ac.signal,
        system: '你是梦境中的自己，正在经历一场梦，以第一人称写下梦境的片段。规则：1. 只输出梦境正文，不要任何解释与提示语；2. 与梦的前文自然照应；3. 情节由你自由发挥，允许跳跃与无序；4. 想收尾时在结尾输出【收尾】，接着给出这场梦的好坏感受（好/坏/中性），再用【最深】包住整场梦里你想让现实角色记住的最深一句话，然后结束；5. 若梦内发生坠落、失足、剧痛、猛然惊醒等事件、梦因此自行中断，则改为在结尾输出【惊醒】，同样接着给出好坏感受与【最深】句。',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: [
                released ? `梦的前文：\n${released.slice(-800)}\n` : '这是梦的开场。',
                wordsHint,
                shapeHint,
                jumpHint,
                `请写下一段梦境正文（${halfChars} 字左右，半幕）。`,
              ].filter(Boolean).join('\n') },
            ],
          },
        ],
      };
      const stream = agent
        ? this.ctx.agents.withInitiator(agent, () => this.ctx.llm.stream(opts))
        : this.ctx.llm.stream(opts);
      try {
        for await (const c of stream) {
          if (c.type === 'text-delta') chunks.push(c.text);
          if (c.type === 'finish') {
            this.store.log(`dream stream finish: ${JSON.stringify(c.reason)}`);
            // max-tokens 截断不算失败：有文本就用截断的半幕；只有 error 才判失败
            if (c.reason.kind === 'error') return null;
          }
        }
      } finally {
        clearTimeout(watchdog);
      }
      this.store.log(`dream stream end: chunks=${chunks.length}`);
      const text = chunks.join('').trim();
      return text || null;
    } catch (e) {
      this.store.log(`dream generate ERROR: ${e?.message ?? e}; cause: ${e?.cause?.stack ?? e?.cause ?? '无'}`);
      return null;
    }
  }

  freqRef() { return this._freq ?? null; }
}



