// 每日素材卡：把最近 X 天的零散消息压成一小段"印象"，只给走神生成用。
// 原文只在内存缓冲（不落盘）；卡片已剥掉日期/数字/引号，落 state.material；不进会话、不进注入。
import { localDay } from './store.js';

const MAX_ITEMS = 300;
const MAX_ITEM_CHARS = 120;
const MAX_CARD_CHARS = 120;
const DAY_MS = 86_400_000;

const BAD_LINE = /[0-9０-９]|[一二三四五六七八九十]{1,3}月|[一二三四五六七八九十]{1,3}[日号]|星期|周[一二三四五六日天]|今天|今天|昨天|前天|明天|后天|今晚|明晚|昨晚|上午|下午|中午|晚上|早上|今早|明早|傍晚|深夜|凌晨|夜里|半夜|周末|礼拜|下周|这周|今年|去年|明年|上个月|上周|本周|上次|那天|刚才|刚刚|["“”‘’']|https?:|□□|\[|\]|【|】/;

// 卡片清洗：逐行去掉含具体时间/数字/引号/URL/方块的句子；保留模糊印象
export function sanitizeCard(raw) {
  const lines = String(raw ?? '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const kept = [];
  for (const line of lines) {
    if (BAD_LINE.test(line)) continue;
    const plain = line.replace(/^(事|画面|念头|感觉)[:：]\s*/, '').trim();
    if (!plain) continue;
    if ([...plain].length > 60) continue;
    kept.push(plain);
  }
  return kept
    .map((x) => x.replace(/（[^）]*）|\([^)]*\)/g, '').replace(/「[^」]*」/g, '').trim()) // 去全角括号/直角引号内容
    .map((x) => x.replace(/[。；;，,]+$/g, ''))
    .filter((x) => x && !/对方|她|他们|用户/.test(x)) // 三人称整行剔除（卡是第一人称印象）
    .slice(0, 4)
    .join('；')
    .slice(0, MAX_CARD_CHARS);
}

// 原文模式（form='raw'）：把时间词模糊化、数字打码、去引号/URL，避免把具体时间带进走神
export function cleanRawText(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[0-9０-９]+/g, '…')
    .replace(/[“”"'「」『』【】]/g, '')
    // 时间词处理（2026-11-20 修）：精确时间（日期/星期/时段）直接删掉；"刚才/这会儿/最近/前两天"这类自然口语词保留——
    // 走神要像她的碎念，用词自然多样；统一替换会造出"前些天/那阵子"这类生硬词
    .replace(/今天|昨天|前天|上个?周[一二三四五六日天]?|本周|周末|那天|昨晚|今晚|明晚|明天|后天|明早|明天早上/g, '')
    .replace(/上午|下午|中午|早上|今早|晚上|夜里|半夜|凌晨|傍晚|深夜/g, '')
    .replace(/今年|去年|明年|上个月|下周|这周|礼拜[一二三四五六日天]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Material {
  constructor(ctx, store, cfg) {
    this.ctx = ctx;
    this.store = store;
    this.cfg = cfg;
    this._buffer = [];
    this._busy = false;
    this._disposed = false;
  }

  dispose() { this._disposed = true; }

  // 收一条消息（原文只在内存；who=对方/我）。assistant-stream 是按 delta 逐块来的，5 秒内同人的连续片段合并成一句
  push(who, text) {
    if (this._disposed || !this.#enabled() || !this.cfg.wanderEnabled) return; // 素材只被走神消费
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (/【[^】]*】|系统提示|提示词|token/i.test(t)) return; // 桥接注入模板（【唤醒】【回复检查】【进行中的话题】等）不进缓冲 // 桥接注入模板/系统文本不进缓冲
    const last = this._buffer[this._buffer.length - 1];
    if (last && last.who === who && Date.now() - last.t < 5000) {
      last.text = [...(last.text + t)].slice(0, MAX_ITEM_CHARS).join('');
      last.t = Date.now();
      return;
    }
    this._buffer.push({ t: Date.now(), who, text: [...t].slice(0, MAX_ITEM_CHARS).join('') });
    this.#prune();
  }

  #days() {
    const d = Number(this.cfg.wander?.material?.days);
    return Number.isFinite(d) ? Math.min(14, Math.max(1, Math.round(d))) : 3;
  }

  #enabled() {
    const m = this.cfg.wander?.material;
    return !(m && m.enabled === false);
  }

  #prune() {
    const cutoff = Date.now() - (this.#days() + 1) * DAY_MS;
    this._buffer = this._buffer.filter((x) => x.t >= cutoff).slice(-MAX_ITEMS);
  }

  // 原文模式：最近 X 天的消息片段（每条 80 字、最多 12 条、总 400 字；时间词已模糊化）
  #raw() {
    const cutoff = Date.now() - this.#days() * DAY_MS;
    const items = this._buffer.filter((x) => x.t >= cutoff).slice(-12);
    if (!items.length) return '';
    const lines = items.map((x) => (x.who === '我' ? '我' : '对方') + '：' + cleanRawText(x.text).slice(0, 80));
    return lines.join('；').slice(0, 400);
  }

  // 取素材：form='raw' 直接取内存里的最近消息片段；否则取压缩卡
  get() {
    if (!this.#enabled()) return ''; // 关掉素材卡就不再使用旧卡/缓冲
    const form = this.cfg.wander?.material?.form;
    if (form === 'raw') return this.#raw();
    const m = this.store.state.material;
    if (!m) return '';
    if (m.day === localDay() && m.status === 'ok' && m.text) return m.text;
    if (Array.isArray(m.days) && m.days.length) {
      const cutoff = Date.now() - this.#days() * DAY_MS;
      const hit = m.days.filter((d) => (d.t ?? 0) >= cutoff);
      return hit.length ? hit[hit.length - 1].text : '';
    }
    return '';
  }

  // 每天首次唤醒（或启动后第一次 tick）时调用：无卡且缓冲有内容才生成
  async ensure(agentId) {
    if (this._disposed || !this.#enabled()) return;
    if (!this.cfg.wanderEnabled) return; // 素材卡只被走神消费：只开做梦不生成（省一次每日调用）
    const day = localDay(); // 所有状态判断前先定日（raw 分支也要用）
    // 原文模式：不调用摘要（省一次调用），只登记当天已处理
    if ((this.cfg.wander?.material?.form ?? 'digest') === 'raw') {
      const mm = this.store.state.material;
      if (!mm || mm.day !== day || mm.status !== 'raw') this.#save({ day, status: 'raw', at: Date.now(), days: mm?.days ?? [] }); // 当天状态不是 raw 就登记（面板显示用）
      return;
    }
    const m = this.store.state.material;
    const prevAttempts = m && m.day === day ? (m.attempts ?? 0) : 0; // 跨天从 0 计
    if (m && m.day === day && m.status === 'ok') return; // skipped 不是终态：当天有消息后允许重试生成
    if (m && m.day === day && m.status === 'failed' && prevAttempts >= 3) return;
    if (this._busy) return;
    this._busy = true;
    try {
      this.#prune();
      const cutoff = Date.now() - this.#days() * DAY_MS;
      const items = this._buffer.filter((x) => x.t >= cutoff);
      if (!items.length) {
        if (!m || m.day !== day || m.status !== 'skipped') {
          this.store.log('material: 当天暂无素材（重启后无历史消息），稍后有消息再试');
          this.#save({ day, status: 'skipped', reason: 'no-material', at: Date.now(), days: m?.days ?? [] });
        }
        return;
      }
      const raw = await this.#summarize(agentId, items);
      if (this._disposed) return; // 卸载后不再写 state
      const card = sanitizeCard(raw);
      if (!card) {
        this.store.log(`material: 摘要清洗后为空（原 ${[...String(raw ?? '')].length} 字），本次跳过`);
        this.#save({ day, status: 'failed', reason: 'parse', attempts: prevAttempts + 1, at: Date.now(), days: m?.days ?? [] });
        return;
      }
      const days = [...((m?.days ?? []).filter((d) => d.day !== day)), { day, t: Date.now(), text: card }]
        .filter((d) => (d.t ?? 0) >= Date.now() - (this.#days() + 1) * DAY_MS)
        .slice(-(this.#days() + 1));
      this.#save({ day, status: 'ok', text: card, attempts: 0, at: Date.now(), days });
      const consumed = new Set(items); // 只清已摘要的（await 期间新到的消息保留）
      this._buffer = this._buffer.filter((x) => !consumed.has(x));
      this.store.log(`material: 生成素材卡（${[...card].length} 字，源 ${items.length} 条）`);
    } catch (e) {
      this.store.log(`material ERROR: ${e?.message ?? e}`);
      // 失败也落盘计数：避免 provider 报错/限频时每个 tick 无限重试（当天最多 3 次）
      this.#save({ day, status: 'failed', reason: String(e?.message ?? e).slice(0, 120), attempts: prevAttempts + 1, at: Date.now(), days: this.store.state.material?.days ?? [] });
    } finally {
      this._busy = false;
    }
  }

  #save(material) {
    this.store.state.material = material;
    this.store.save();
  }

  async #summarize(agentId, items) {
    const lines = items.slice(-30).map((x) => (x.who === '我' ? '我' : '对方') + '：' + x.text.slice(0, 100)); // 最多 30 条、每条 100 字
    const prompt = [
      '下面是她最近这些天的零散消息（对方说的、她自己说的）。',
      '把它们压成一小段"她这几天心里留着的印象"，供她发呆时想起。',
      '要求：用"你自己"的第一人称感觉；只写印象、画面、念头，不写具体日期、时间、人名、地名、作品名、数字；',
      '不要写具体日期、钟点，也不要写"今天/昨天/前天/上周"这类精确说法；时间说法要自然、别反复用同一个词；不要引号原话；',
      '最多 4 行，每行 30 字内，用"事：/画面：/念头："开头。',
      '',
      lines.join('\n'),
    ].join('\n');
    const chunks = [];
    const ac = new AbortController();
    const watchdog = setTimeout(() => ac.abort(), 90_000);
    watchdog?.unref?.();
    const opts = {
      provider: this.cfg.llm?.provider ?? 'deepseek-account',
      model: this.cfg.llm?.model ?? 'deepseek-flash',
      reasoningEffort: 'low',
      maxTokens: 1200,
      sessionId: agentId,
      signal: ac.signal,
      system: '你是她自己的记忆，用第一人称写下这几天的零碎印象；只输出要求的几行，不加解释、不加引号、不提"对方/用户/她"。',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    };
    try {
      // 与 wander/dream 一致：账号路由的 provider 需要 initiator 上下文
      // 用 agentId 反查 agent 再 withInitiator：tick 里 currentInitiator 通常为空（默认 digest 路径必需）
      const agent = (() => { try { return this.ctx.agents.get(agentId) ?? this.ctx.agents.currentInitiator() ?? null; } catch { return null; } })();
      const run = () => this.ctx.llm.stream(opts);
      const stream = agent ? await this.ctx.agents.withInitiator(agent, run) : run();
      for await (const c of stream) {
        if (c.type === 'text-delta') chunks.push(c.text);
        if (c.type === 'finish' && (c.reason?.kind === 'error' || c.reason?.kind === 'aborted')) return '';
      }
    } finally {
      clearTimeout(watchdog);
    }
    return chunks.join('').trim();
  }
}
