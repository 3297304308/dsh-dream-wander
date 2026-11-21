// 走神与做梦插件 · 主入口
// 装配：事件监听（活动/词频）+ 巡检器（独处→走神 / 入睡→曲线判定→开演）+ 注入（滴放文本）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, mergeConfig, roundProbs, clampCounts } from './lib/config.js';
import { Store, localDay } from './lib/store.js';
import { Freq, FREQ_VERSION } from './lib/freq.js';
import { Wander, WANDER_SYSTEM_TEMPLATE } from './lib/wander.js';
import { Dream } from './lib/dream.js';
import { Interrupt } from './lib/interrupt.js';
import { Copy, retentionDays } from './lib/copy.js';
import { readViewData } from './lib/view.js';
import { Material } from './lib/material.js';
import { Memory } from './lib/memory.js';
import { Signal } from './lib/signal.js';
import { wanderTimeOk } from './lib/clock.js';

// DSH 数据根：环境变量 DSH_HOME 优先，回落 ~/.dsh
const dshHome = (() => {
  try { return process.env.DSH_HOME || path.join(os.homedir(), '.dsh'); } catch { return path.join(os.homedir(), '.dsh'); }
})();

export const name = 'dream-wander';
export const inject = ['llm', 'timer', 'systemPrompt', 'agents'];
export { Config } from './lib/schema.js';

export function apply(ctx, rawConfig) {
  const cfg = clampCounts(roundProbs(mergeConfig(rawConfig)));
  // 数据目录解析顺序：配置 dataDir > 环境变量 DREAM_WANDER_DATA > <DSH_HOME>/dream-wander-data
  // 相对路径按插件目录解析（支持 dataDir: "./data" 让数据跟着插件目录走）；默认放 DSH_HOME 下，npm 升级/重装不丢数据。
  const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
  const resolveDir = (v) => {
    const t = String(v ?? '').trim();
    if (!t) return '';
    return path.isAbsolute(t) ? t : path.resolve(pluginRoot, t);
  };
  const dataDir = resolveDir(cfg.dataDir) || resolveDir(process.env.DREAM_WANDER_DATA)
    || path.join(dshHome, 'dream-wander-data');

  // —— 启动自检状态：装配成功/失败都写 <dataDir>/apply-status.json，供面板与排障使用 ——
  // （原来锁失败只写 plugin.log 后静默 return：面板 404、没人知道插件没启动）
  const applyStatusPath = path.join(dataDir, 'apply-status.json');
  const writeApplyStatus = (status, extra = {}) => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(applyStatusPath, JSON.stringify({ status, pid: process.pid, ts: Date.now(), hostname: os.hostname(), ...extra }, null, 2), 'utf8');
      return true;
  } catch { return false; /* 目录不可写：调用方决定是否抛错 */ }
  };
  // pid 锁：同 dataDir 只允许一个实例（多实例互抹防护）
  const lockPath = path.join(dataDir, 'instance.lock');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(lockPath)) {
      let old = {};
      try {
        old = JSON.parse(fs.readFileSync(lockPath, 'utf8') || '{}');
      } catch {
        // 锁文件损坏：改名留证后接管（原来会被同一个 catch 吞成永久静默）
        const bad = `${lockPath}.corrupt-${Date.now()}`;
        try { fs.renameSync(lockPath, bad); } catch {}
        try { fs.appendFileSync(path.join(dataDir, 'plugin.log'), `[${new Date().toISOString()}] 锁文件损坏，已改名 ${path.basename(bad)} 并接管\n`, 'utf8'); } catch {}
        old = {};
      }
      const sameProcess = old.pid === process.pid;
      const sameHost = !old.hostname || old.hostname === os.hostname();
      const alive = (() => {
        if (!old.pid) return false;
        try { process.kill(old.pid, 0); return true; } catch { return false; }
      })();
      // 异 pid 且活即拒（去掉 age 条件：pid 活着就是同数据目录的活实例，防双实例互抹）；
      // 异机（数据目录被拷贝到另一台机器）→ 旧锁不可能属于本机活实例，直接接管
      if (!sameProcess && alive && sameHost) {
        throw new Error(`dataDir 已被实例 pid=${old.pid} 占用（同机活进程）。若确认旧进程已退出，删除 instance.lock 后重试`);
      }
      // 死进程/同进程：接管
    }
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), hostname: os.hostname() }), 'utf8');
  } catch (e) {
    const reason = e?.message ?? String(e);
    const wrote = writeApplyStatus('failed', { reason }); // 本次写入是否成功（不能靠 existsSync：上次残留文件会误报 ok）
    try { fs.appendFileSync(path.join(dataDir, 'plugin.log'), `[${new Date().toISOString()}] apply LOCK ERROR: ${reason}\n`, 'utf8'); } catch {}
    // 尽力给面板一个可读原因：webServer 若已就绪就注册只读路由返回 503（客户端会显示排障提示）
    try {
      const ws0 = ctx.get('webServer');
      ws0?.register?.({
        kind: 'exact',
        path: '/api/dream-wander/config',
        handler: (req, res) => {
          const body = JSON.stringify({ ok: false, error: `插件未启动：${reason}`, applyStatus: { status: 'failed', reason } });
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(body);
        },
      });
    } catch {}
    // 数据目录不可写（连状态都写不进去）→ 抛错让插件管理器标 failed，别静默
    if (!wrote) throw e;
    return;
  }
  writeApplyStatus('ok', { bootedAt: Date.now() });

  const store = new Store(dataDir);
  store.state.bootedAt = Date.now(); // 运行时长基准（面板 health 用；首次 tick 会落盘）
  store.log('apply: plugin started');

  // 滞留注入清理：插件当前不在 scope 里的会话，若还留着上次注入签名，说明旧梦境内容可能仍留在它会话头节点；
  // 下次该会话有回合时清一次（inject-审查 2026-11-16 P0-1）
  const pendingCleanSids = new Set(
    Object.keys(store.state.her?.injectSig ?? {}).filter((sid) => !Array.isArray(cfg.scope) || !cfg.scope.map(String).includes(String(sid))),
  );
  if (pendingCleanSids.size) store.log(`注入清理：${[...pendingCleanSids].join(',')} 已不在作用域，待下次回合清理旧注入`);

  // 运行期警告（面板显示；多会话是已知限制：轮询/判定/代发/注入都固定用 scope 第一个会话）
  const applyWarnings = [];
  if (Array.isArray(cfg.scope) && cfg.scope.length > 1) {
    applyWarnings.push('当前只支持一个作用域会话：轮询/判定/代发/注入都用 scope 的第一个会话，其余会话不生效（多会话是已知限制）');
    store.log(`apply: scope 有 ${cfg.scope.length} 个会话，只有第一个生效`);
  }

  // 词频恢复（当日池）
  let freq = Freq.fromJSON(store.freq(), cfg);
  if ((store.state.freqVer ?? 0) !== FREQ_VERSION) {
    store.log(`词频规则升级 v${store.state.freqVer ?? 0} → ${FREQ_VERSION}：清空旧池`);
    freq = new Freq(cfg);
    store.state.freq = {};
    store.state.freqDay = localDay();
    store.state.freqVer = FREQ_VERSION;
    store.save();
  }
  // 动态提示词词表静态兜底（插件自身 system 模板）
  try { freq.setPromptWords([WANDER_SYSTEM_TEMPLATE]); } catch {}
    // 动态提示词词表（2026-11-21）：每次组装系统提示词时收集其文本，只用于会话推理路径的词频过滤
    try {
      ctx.on('system-prompt/assemble', (assembly, context, next) => {
        try {
          let text = '';
          const walk = (v, depth) => {
            if (depth > 6 || v === null || v === undefined) return;
            if (typeof v === 'string') { text += v + '\n'; return; }
            if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
            if (typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k], depth + 1); }
          };
          walk(assembly, 0);
          if (text.trim()) freq.setPromptWords([text.slice(0, 20000)]);
        } catch {}
        return next();
      });
    } catch {}
  // 启动时池子属于旧日 → 清空（设计约定"新一天从空池开始"；fromJSON 已顺手过滤停用词/英文碎片）
  if (store.freqDay() && store.freqDay() !== localDay()) {
    const oldDay = store.freqDay();
    freq.pool.clear();
    freq.care.clear();
    store.state.freq = {};
    store.state.freqDay = localDay();
    store.log(`启动时词频池跨日清空（旧日 ${oldDay} → ${localDay()}）`);
    store.save();
  }
  const wander = new Wander(ctx, store, cfg);
  const material = new Material(ctx, store, cfg); // 每日素材卡（最近 X 天的印象，只进走神生成）
  wander._material = material;
  const dream = new Dream(ctx, store, cfg);
  const interrupt = new Interrupt(store, cfg);
  const copy = new Copy(store, cfg);
const memory = new Memory(store, cfg);
  const signal = new Signal(store, cfg);
  wander._freq = freq;
  dream._freq = freq;
  dream._interrupt = interrupt;
  dream._copy = copy;
  dream._memory = memory;
  dream._signal = signal;
  // 轮询信号回调（设计约定十节：按敏感度分流——中断/代发/变形/忽略）
  // 计数权威放在这里：轮询看得到每条消息的真实 seq 与消息对象（poke.targetIsSelf/引用/私聊），
  // 能准确分类且天然按 seq 去重；pre-step 通道只负责"吞或放行"（等这里判定）。
  const onDreamSignal = (msg, key) => {
    const her = store.her();
    if (her.status !== 'dreaming') return;
    // 健康摘要：最近一次信号到达时刻（面板"运行状态"用）
    try { signal.lastSignalAt = Date.now(); } catch {}
    // 同一条消息（seq）只处理一次
    const seq = Number(msg?.seq);
    if (Number.isSafeInteger(seq) && her.lastSignalSeq && seq <= her.lastSignalSeq) return;
    const type = interrupt.classifyMessage(msg, key);
    const isPrivate = String(key).startsWith('private:');
    // 变形素材需要原声（设计约定：变形后与原声保持关联）——传消息正文摘要
    const msgText = String(msg?.plain ?? msg?.text ?? '').slice(0, 40);
    const r = interrupt.handleDreamSignal(her, msgText, isPrivate, type, msgText);
    if (Number.isSafeInteger(seq) && seq > 0) her.lastSignalSeq = seq;
    const agentId = String(cfg.scope?.[0] ?? '');
    if (r.action === 'interrupt') {
      interrupt.clearCount(her);
      store.log(`dream: 信号中断（${type}，轮询通道）→ 通知 pre-step 放行`);
      // 放行窗口：pre-step 正在等一个轮询周期，看到这个标记就放行本回合（角色真的醒来）
      her.releaseUntil = Date.now() + 15_000;
      dream.finishBySignal(agentId).catch(() => {});
    } else if (r.action === 'continue') {
      if (r.groggy) {
        her.groggy = r.groggy;
        her.groggySetAt = Date.now();
        // 被动回应由插件代发（设计约定十节：代发失败梦继续、计数照常）
        signal.sendPassive(agentId, r.groggy).catch(() => {});
      }
      if (r.shape) her.pendingShapes = [...(her.pendingShapes ?? []), r.shape];
      store.log(`dream: 信号未断（${type}，${her.interruptCount} 次），代发=${r.groggy ?? '无'}，变形=${r.shape ? '有' : '无'}`);
      store.save();
    } else {
      store.log(`dream: 信号忽略（${type}）`);
    }
  };
  dream._onSignal = onDreamSignal;
  dream._scopeSessionId = String(cfg.scope?.[0] ?? ''); // 信号轮询用真实会话 id（映射表键）
  wander._signal = signal; // 走神生成取角色最近对话做上下文（方案二.5）

  const inScope = (agent) => {
    if (!cfg.scope || cfg.scope.length === 0) return false; // 空作用域=不生效（设计约定十二节）
    const id = String(agent?.session?.id ?? agent?.id ?? '');
    // 精确匹配（endsWith 会误伤短 id）；会话 id 变化需同步改 scope（桌面工作记录待办有记）
    return cfg.scope.some((s) => String(s) === id);
  };

  // 作用域空则静默
  if (!cfg.scope || cfg.scope.length === 0) {
    store.log('scope 为空，插件不生效');
  }

  // 注入归一化的"待提交签名"：只有模型真正开始流式输出（assistant-stream 的 start 帧）才算提交，
  // 决策 enter 但提交被取消/外层 reject/崩溃时签名不更新，下一回合会自然重试（审查 P0-2）
  const pendingSig = new Map(); // sid -> sig

  // —— 事件：现实角色收到消息（活动+唤醒+做梦期间走敏感度）——
  ctx.on('agent/inbox/inserted', (payload) => {
    try {
      const agent = payload?.agent;
      if (!agent || !inScope(agent)) return;
      const id = String(agent.id);
      const st = store.agent(id);
      const her = store.her();
      const wasAwake = her.status === 'awake';
      const prevActivity = st.lastActivity ?? 0; // 更新前的上次活动（判"静默后第一次被叫回来"）
      // 做梦期间的消息是被拦截信号（被吞信号不算角色的唤醒）：不刷新活动/独处计时；
      // 其他状态下的消息=真实外部活动（角色醒了/醒着），刷新活动与"有人理角色"计时
      if (her.status !== 'dreaming') {
        st.lastActivity = Date.now();
        st.lastHuman = Date.now();
      }
      const text = payload?.message?.content ?? '';
      const textStr = typeof text === 'string' ? text
        : (Array.isArray(text) ? text.map((b) => b?.text ?? '').join('') : '');
      // 做梦期间：信号计数统一走轮询通道（unread 明细、seq 去重）；inbox 这里只观测不计数。
      // 吞消息由 agent/pre-step 拦截负责（被吞信号不算角色的唤醒，设计约定五节）。
      if (her.status === 'dreaming') {
        store.log(`dream: inbox 收到唤醒输入（${textStr.slice(0, 40)}…），交 pre-step 拦截`);
      } else {
        dream.onMessage(id);
        material.push('对方', textStr); // 素材卡：被吞进梦里的信号不算她看到的，不进素材
      }
      // 走神注入（作者拍板 A：只在唤醒时刻）——睡着→醒，或静默满 aloneMin 后第一次被叫回来
      const silentLong = prevActivity > 0 && Date.now() - prevActivity >= (cfg.wander?.aloneMin ?? 15) * 60_000;
      if (her.status === 'awake' && (!wasAwake || silentLong)) refreshWanderMemory(id);
      // 副本降档挂接"唤醒"（设计约定十一节：唤醒→降档重算→开始思考；幂等）
      if (cfg.copy?.degrade === 'daily') copy.degradeAll();
      // 打码梦文本形态的降档同样按天挂接（幂等；只处理 memory 自己的文件）
      if (cfg.residue?.form === 'blur') memory.degradeAll();
      store.save();
    } catch (e) { store.log(`inbox handler ERROR: ${e?.message ?? e}`); }
  });

  // 上一轮 assistant-stream 时角色的状态（stream-only 唤醒检测；重载即清，不落盘）
  let lastStreamHerStatus = '';

  // 从桥接唤醒文本提取信号类型（pre-step 同步通道；轮询通道用 classifyMessage）
  const classifyWakeText = (texts) => {
    if (/原因：有人拍了一拍/.test(texts)) return 'poke';
    const m = texts.match(/原因：(atMention|nameMention|private)/);
    if (m) return m[1] === 'atMention' ? 'at' : (m[1] === 'nameMention' ? 'name' : 'private');
    return 'group';
  };
  // 从唤醒文本提取触发消息 seq —— 注意：桥接实际唤醒文本是裸 reason（private/atMention/poke…），
  // 运行时并不带 @seq（源码 evaluateWakeTriggerV2 返回值 + 实测会话日志 @seq 0 次），所以不再拿它去重；
  // 去重统一用轮询通道的真实消息 seq（her.lastSignalSeq）。此函数保留给旧桥接版本兼容。

  // —— 拦截通道：dreaming 期间吞掉桥接投递的唤醒输入（设计约定五节/十节：被吞信号不算角色的唤醒）——
  // 实测（验证 1，2026-11-15）：reject 后消息被本轮领走、下一回合重进，需要每一步持续拦。
  // 四类分流：①代发触发的"回复检查"唤醒=噪音→吞掉、梦继续、不结算；
  //          ②桥接按自身时钟拉起（超时/主动机会）=角色自然醒→中断并放行；
  //          ③桥接消息唤醒=被拦信号→同步走敏感度：第 1 次哼唧吞掉，第 2 次断梦**放行**（角色真的醒来处理）；
  //          ④非桥接输入（用户在 GUI 直接发言等）=冲角色来的强信号→中断并放行。
  ctx.on('agent/pre-step', async (payload, next) => {
    const agent0 = payload?.agent;
    if (!agent0) return next();
    // 该会话已不在作用域、但还留着旧注入：清一次（清完删签名，避免反复）
    const sidClean = String(agent0.id);
    if (pendingCleanSids.has(sidClean)) {
      // 先清签名再 next：下一回合渲染会自然判"变化"并归一化；不要在这里二次调用 next（cordis 会抛 next() called multiple times）
      pendingCleanSids.delete(sidClean);
      pendingSig.delete(sidClean); // 旧签名不再提交
      try {
        if (store.state.her?.injectSig) delete store.state.her.injectSig[sidClean];
        store.state.injectStats = { ...(store.state.injectStats ?? {}), forceNextNorm: true };
        store.save();
      } catch {}
      store.log(`inject: 清理滞留注入 sid=${sidClean}`);
      return next();
    }
    if (!inScope(agent0)) return next();
    const her0 = store.her();
    if (her0.status !== 'dreaming') {
      // 非做梦回合：注入内容变化 → 决定是否让 DSH 清旧版本（归一化）还是只追加。
      // 成本依据（inject-审查 实测）：一次归一化=整份系统提示重写、未缓存重算 13~17.6 万 token；
      // 只追加实测未缓存仅 8.2k。2026-11-16 作者拍板：拟真松一点可以，兜底必须做好。
      const sid = String(agent0.id);
      // 签名两组：stale（会过期必须清的段）/ wander（走神，只增不会让角色记错）
      const parts = injectSigParts(sid);
      const prevSig = her0.injectSig?.[sid];
      const prevStale = typeof prevSig === 'string' ? prevSig : String(prevSig?.stale ?? '');
      const prevWander = typeof prevSig === 'string' ? '' : String(prevSig?.wander ?? '');
      const staleChanged = parts.stale !== prevStale;
      const wanderChanged = parts.wander !== prevWander;
      const ist = (store.state.injectStats = store.state.injectStats ?? {});
      const nowNorm = Date.now();
      const decision = await next();
      try {
        if (decision?.kind === 'enter' && (decision.messages ?? []).length !== 0) {
          // 同回合最多归一化一次：step≥2 也要能清刚出现的 stale 变化（唤醒回合的新梦注入在 step2 才装配出来）
          const turnDone = ist.lastNormTurn !== undefined && ist.lastNormTurn === payload?.turn;
          const cnt = ist.changesSinceNorm ?? 0;
          // 兜底：①未归一追加满 3 份强制清（防旧版本堆积）②距上次归一化超 4 小时强制清（防僵尸）③日切强制清一次
          // 注意：不再用"距上次归一化 30 分钟"——复核发现它会在无变化的回合里空转（DSH 侧文本相同直接 no-op），
          // 把"满 3 份"饿死（审查-throttle P0-1/P1-2）
          const forceByCount = cnt >= 3;
          const forceByAge = cnt > 0 && (ist.lastNormAt ?? 0) > 0 && nowNorm - (ist.lastNormAt ?? 0) > 4 * 3600_000;
          const forceByDay = !!ist.forceNextNorm;
          const needNorm = (staleChanged || forceByCount || forceByAge || forceByDay) && !turnDone;
          if (needNorm) {
            pendingSig.set(sid, parts);
            store.state.injectNormCount = (store.state.injectNormCount ?? 0) + 1;
            ist.lastNormAt = nowNorm;
            ist.lastNormTurn = payload?.turn;
            ist.changesSinceNorm = 0;
            ist.lastWanderSeen = parts.wander;
            ist.forceNextNorm = false;
            const why = staleChanged ? '过期段变化' : (forceByCount ? '兜底-追加满3份' : (forceByAge ? '兜底-超4小时' : '兜底-日切'));
            store.log(`inject: 归一化 sid=${sid} turn=${payload?.turn} step=${payload?.step}（第 ${store.state.injectNormCount} 次，${why}）`);
            store.save();
            return { ...decision, startsRequestSeries: true };
          }
          // 只追加：不归一化，让 DSH 在历史里追加新版本；同时把本次渲染签名记成 pendingSig，
          // 提交后 injectSig 更新（否则每回合都会判 wanderChanged、无变化也空转——审查-throttle P0-1）
          if (wanderChanged) {
            pendingSig.set(sid, parts);
            if (parts.wander !== String(ist.lastWanderSeen ?? '')) {
              ist.changesSinceNorm = cnt + 1;
              ist.lastWanderSeen = parts.wander;
              ist.lastChangeAt = nowNorm;
            }
            store.save();
            store.log(`inject: 走神变化只追加（未归一 ${ist.changesSinceNorm ?? 0}/3）`);
          }
        }
      } catch (e) { store.log(`inject normalize ERROR: ${e?.message ?? e}`); }
      return decision;
    }
    let delegated = false;
    const callNext = () => { delegated = true; return next(); };
    try {
      const agent = agent0;
      const her = her0;
      const texts = (payload?.messages ?? []).map((m) => {
        const c = m?.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map((b) => b?.text ?? '').join('');
        return '';
      }).join('\n');
      // 桥接投递的唤醒提示（含【唤醒】类标题或"原因："行）；否则视为用户直接输入
      const isBridgeWake = /【(唤醒|回复检查|主动机会|引导唤醒|提醒)】/.test(texts) || /原因：/.test(texts);
      if (!isBridgeWake) {
        store.log('dream: 非桥接输入（用户直接发言）=冲角色来的强信号，中断并放行');
        // 放行前先等结算完（判断+残留/画面/心情）：否则这一回合的注入还是空的、角色连"做过梦"都不知道（审查 H5）
        await Promise.race([
          dream.finishBySignal(String(cfg.scope?.[0] ?? '')).catch(() => {}),
          new Promise((r) => setTimeout(r, 6000)),
        ]);
        return callNext();
      }
      // ① 回复检查（被动代发后桥接 30 秒自检）——不结算、梦继续（设计约定：代发后梦继续）
      if (/【回复检查】/.test(texts) || /原因：你刚刚发送过消息/.test(texts)) {
        store.log('dream: 回复检查唤醒（代发触发）=吞掉，梦继续');
        return { kind: 'reject' };
      }
      // ② 桥接内部机制提示（回合收尾提醒 / 引导唤醒）→ 不是人信号：吞掉、不计数、不结算
      //    回合被拦后桥接会补发【提醒】"你还没完成回合收尾"；旧实现把它当群聊信号计数，
      //    等于一条消息被算两次（审查 B5）
      if (/【提醒】/.test(texts) || /【引导唤醒】/.test(texts)) {
        store.log('dream: 桥接内部提示（提醒/引导）=吞掉（非人信号）');
        return { kind: 'reject' };
      }
      // ③ 桥接按自身时钟拉起（角色没被拦住的那一刻真的醒了）
      if (/原因：(你设置的有限潜水时间已到|群里已经安静)/.test(texts)) {
        store.log('dream: 桥接非消息唤醒=角色自然醒，中断梦（随后放行）');
        await Promise.race([
          dream.finishBySignal(String(cfg.scope?.[0] ?? '')).catch(() => {}),
          new Promise((r) => setTimeout(r, 6000)),
        ]);
        return callNext();
      }
      // ④ 桥接消息唤醒：计数权威在轮询通道（真实 seq ＋ 消息对象分类，见 onDreamSignal）。
      //    这里只负责"吞或放行"：等一个轮询周期，看轮询是否已判定中断（her.releaseUntil）。
      //    旧实现两个通道各计一次 → 默认中档第一次信号就断梦、抖动也掷两次（审查 B5/H7）。
      if (!signal.polling()) {
        // 无轮询（没配映射/令牌/水位）：降级成文本通道自己计数（单通道，不会双计）
        const type0 = classifyWakeText(texts);
        const r0 = interrupt.handleDreamSignal(her, texts, type0 === 'private', type0, '');
        if (r0.action === 'interrupt') {
          interrupt.clearCount(her);
          store.log(`dream: 信号中断（${type0}，无轮询降级）→ 放行`);
          await Promise.race([
            dream.finishBySignal(String(cfg.scope?.[0] ?? '')).catch(() => {}),
            new Promise((r) => setTimeout(r, 6000)),
          ]);
          store.save();
          return callNext();
        }
        if (r0.action === 'continue') {
          if (r0.groggy) {
            her.groggy = r0.groggy;
            her.groggySetAt = Date.now();
            signal.sendPassive(String(cfg.scope?.[0] ?? ''), r0.groggy).catch(() => {});
          }
          if (r0.shape) her.pendingShapes = [...(her.pendingShapes ?? []), r0.shape];
          store.log(`dream: 信号未断（${type0}，${her.interruptCount} 次，无轮询降级）`);
          store.save();
        }
        return { kind: 'reject' };
      }
      // 等轮询把这条消息记完：最多一个轮询周期 + 余量
      const deadline = Date.now() + signal.waitCycleMs();
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        if (her.status !== 'dreaming') break; // 轮询已结算（断梦）
        if ((her.releaseUntil ?? 0) > Date.now()) break; // 轮询已判定中断、要求放行
      }
      if ((her.releaseUntil ?? 0) > Date.now()) {
        delete her.releaseUntil;
        store.log('dream: 轮询已判定中断/放行 → 放行本回合（角色真的醒来处理）');
        if (her.status === 'dreaming') {
          // 放行前等结算完，保证这一回合的注入（画面/残留/心情）已就绪（审查 H5）
          await Promise.race([
            dream.finishBySignal(String(cfg.scope?.[0] ?? '')).catch(() => {}),
            new Promise((r) => setTimeout(r, 6000)),
          ]);
        }
        store.save();
        return callNext(); // 自唤醒：放行后角色会话处理这批消息
      }
      if (her.status !== 'dreaming') {
        // 等待期间梦已被别的路径结束（自然醒/超时/热重载）→ 梦不存在了，本回合不该再吞
        store.log('dream: 等待期间梦已结束 → 放行本回合');
        return callNext();
      }
      store.log(`dream: 本回合吞掉（轮询未判定中断：${classifyWakeText(texts)}），梦继续`);
      return { kind: 'reject' };
    } catch (e) {
      store.log(`pre-step ERROR: ${e?.message ?? e}`);
      // next() 已调过（异常来自下游监听器）时不能再调一次：cordis 会抛 "next() called multiple times"
      if (delegated) throw e;
      return next();
    }
  });

  // —— 事件：现实角色说出的话（活动+词频）——
  let lastFreqSave = 0;
  let lastStreamSave = 0;
  // 入词前的日切：设计约定六节 L98"词频池在当日首次唤醒时清空重置（新一天从空池开始）"。
  // 不能在 tick 里靠 freqDay 判——入词会先把 freqDay 写成今日，tick 就以为"池=今日词"而保留昨日池
  // （历史旧词进当日池，违反【废】L93；审查 A4/B3）。改为入词时判断：池所属日不是今天就先清池。
  const addFreq = (text, opts = {}) => {
    const today = localDay();
    if (store.freqDay() !== today) {
      freq.pool.clear();
    freq.care.clear();
      store.state.freqDay = today;
      store.log(`词频池跨日重置（新一天从空池开始，今日 ${today}）`);
    }
    freq.add(text, opts);
  };
  const freqSave = (force = false) => {
    if (!force) {
      const now = Date.now();
      if (now - lastFreqSave < 10_000) return; // 10 秒节流
      lastFreqSave = now;
    }
    store.state.freq = freq.toJSON();
    store.state.freqDay = localDay();
    store.save();
  };
  wander._addFreq = addFreq;
  wander._freqFlush = () => freqSave(true); // 走神产物写盘后强制落盘（防热重载丢词）
  dream._addFreq = addFreq;
  ctx.on('agent/assistant-stream', (payload) => {
    try {
      const agent = payload?.agent;
      if (!agent || !inScope(agent)) return;
      const id = String(agent.id);
      const st = store.agent(id);
      st.lastActivity = Date.now();
      const her = store.her();
      // 提交证据：模型真的开始流式输出 → 本步的注入已提交，把 pendingSig 落成 injectSig（审查 P0-2）
      if (payload?.frame?.type === 'start') {
        try {
          const sidNow = String(agent.id);
          const ps = pendingSig.get(sidNow);
          if (ps !== undefined) {
            her.injectSig = { ...(her.injectSig ?? {}), [sidNow]: ps };
            pendingSig.delete(sidNow);
            store.save();
            store.log(`inject: 提交确认 sid=${sidNow}（签名已更新）`);
          }
        } catch {}
      }
      // 梦进行中现实角色说话：代发迷糊语后不算自然醒来（现实角色仍睡着，设计约定十节被动回应）；否则=现实角色自然醒来中断
      if (her.status === 'dreaming') {
        const groggyFresh = her.groggyAt && (Date.now() - her.groggyAt < 180_000);
        if (groggyFresh) {
          // 被动哼唧回合（注入后 3 分钟内的说话都算被动回应），梦继续
          store.log(`dream: 被动回应（迷糊语），梦继续`);
        } else {
          store.log(`dream: 梦进行中现实角色醒来（自然醒来中断）`);
          dream.finishBySignal(id).catch(() => {});
        }
      } else if (her.status === 'sleeping') {
        // 睡眠中角色主动开口=角色醒了（设计约定五节：梦醒=有梦的睡眠中角色实际醒来）
        store.log(`dream: 睡眠中现实角色醒来（开口）`);
        if (her.hitAt) {
          // 本段命中时刻还没到就醒了：本段作废、**不扣额度**（作者口径：判上了才 K−1）
          delete her.hitAt;
          store.log(`dream: 命中时刻未到就醒（开口），本段作废（额度剩 ${her.remaining ?? 0}）`);
        }
        delete her.hitMissed;
        her.status = 'awake';
        her.wokeDay = localDay(); // 今天醒过（日切清池门闩）
        // 只要醒就记唤醒时刻（wokeAt 给"画面/做过梦/归属"用，即使这场梦没有心情/残留）；
        // awakeAt 保留给"心情/残留 24h 窗口"语义（审查 P0-4：中性梦+0残留时原来画面和做过梦都不注入）
        her.wokeAt = Date.now();
        her.wokeBy = id;
        if (her.mood || her.residueAt) her.awakeAt = Date.now();
        store.save();
      }
      // 只要角色现在醒着就记唤醒时刻（上面分支之外还有 dreaming→awake 等路径）
      if (her.status === 'awake' && !her.wokeAt) {
        her.wokeAt = Date.now();
        her.wokeBy = id;
      }
      // 梦醒时刻（设计约定十一节：心情/残留窗口自现实角色真正醒来起算）
      if ((her.mood || her.residueAt) && !her.awakeAt) {
        her.awakeAt = Date.now();
        her.wokeBy = id;
      }
      // 残留 24h 锚点=角色真正醒来那一刻（只在梦醒那次记录；其他唤醒不重置，设计约定）
      if (her.residueAt && her.awakeAt && !her.residueWakeAt) her.residueWakeAt = her.awakeAt;
      // 角色开口=这一轮把迷糊语说掉了 → 消费 groggy（并记 groggyAt 供计频排除）
      if (her.groggy) {
        her.groggyAt = Date.now();
        delete her.groggy;
        delete her.groggySetAt;
      }
      // 角色真的醒着说话：若当前会话还没有走神批次（刚醒/换会话），取一批注入；清醒期间不重复刷
      const mem0 = her.wanderMemory;
      // 刚醒（上一 chunk 还是 sleeping/dreaming，现在 awake）也刷：覆盖 stream-only 唤醒（无 inbox 消息）的场景
      const prevStreamStatus = lastStreamHerStatus;
      lastStreamHerStatus = her.status;
      const justWoke = (prevStreamStatus === 'sleeping' || prevStreamStatus === 'dreaming') && her.status === 'awake';
      if (her.status === 'awake' && (justWoke || !mem0 || String(mem0.sid) !== id || mem0.day !== localDay())) refreshWanderMemory(id);
      // 词频：现实角色的思考（reasoning-delta）与说出的话（text-delta）。
      // 双开关全关时不计频（设计约定十二节：出厂全关=插件不生效）；
      // 被动回应（代发迷糊语后 3 分钟内的输出）不计频（设计约定六节）；只计 delta（block-end 会双计）
      const frame = payload?.frame ?? {};
      let text = '';
      const groggyFresh = her.groggyAt && (Date.now() - her.groggyAt < 180_000);
      const enabled = cfg.dreamEnabled || cfg.wanderEnabled;
      const isTextDelta = frame.type === 'chunk' && frame.chunk?.type === 'text-delta';
      const isReasonDelta = frame.type === 'chunk' && frame.chunk?.type === 'reasoning-delta';
      // 发言工具检测（speechMode）：她在用发送工具说话时，正文文本只是动作/内心
      if (frame.type === 'chunk' && frame.chunk?.type === 'block-end' && frame.chunk?.block?.type === 'tool-call') {
        const tname = String(frame.chunk.block?.name ?? '');
        const tools = Array.isArray(cfg.freq?.speechTools) ? cfg.freq.speechTools : ['send_message', 'reply'];
        if (tools.some((t) => tname === t || tname.endsWith('__' + t) || tname.endsWith(t))) {
          st._speechMode = true;
          if ((cfg.freq?.countAssistantText ?? 'auto') !== 'on') st._textBuf = ''; // 工具调用前的正文也不计（终审 M P2-1）
        }
      }
      if (enabled && !groggyFresh && frame.type === 'chunk' && (isTextDelta || isReasonDelta)) {
        text = frame.chunk.text ?? '';
      }
      // 词频：整轮聚合；正文与推理分两个 buffer（推理路径过动态提示词词表）
      if (typeof text === 'string' && text) {
        const textCounting = cfg.freq?.countAssistantText ?? 'auto';
        if (isTextDelta && (textCounting === 'on' || (textCounting === 'auto' && !st._speechMode))) {
          material.push('我', text);
          st._textBuf = (st._textBuf ?? '') + text;
          if ([...st._textBuf].length > 4000) st._textBuf = st._textBuf.slice(-4000);
        }
        if (isReasonDelta && cfg.freq?.countReasoning !== 'none') {
          st._reasonBuf = (st._reasonBuf ?? '') + text;
          if ([...st._reasonBuf].length > 4000) st._reasonBuf = st._reasonBuf.slice(-4000);
        }
      }
      if (frame.type === 'end') {
      st._speechMode = false; // 回合内标记：本回合结束后复位（不落盘粘滞）
        if (st._textBuf) { addFreq(st._textBuf); st._textBuf = ''; }
        if (st._reasonBuf) { addFreq(st._reasonBuf, { reasoning: true }); st._reasonBuf = ''; }
        freqSave();
      }
      // 落盘节流（1.5 秒）：一次回复有几百个 chunk，逐 chunk 全量 save 会写放大（审查 E5）
      const now = Date.now();
      if (now - lastStreamSave >= 1500) {
        lastStreamSave = now;
        store.save();
      }
    } catch (e) { store.log(`stream handler ERROR: ${e?.message ?? e}`); }
  });

  // 说出口的话：发言工具执行成功后取 arguments.messages（词频+素材同源，母本 v24）
  ctx.on('tools/result', (exec, result) => {
    try {
      const agent = exec?.agent;
      if (!agent || !inScope(agent)) return;
      if (result?.isError) return;
      const name = String(exec?.name ?? '');
      const tools = Array.isArray(cfg.freq?.speechTools) ? cfg.freq.speechTools : ['send_message', 'reply'];
      if (!tools.some((t) => name === t || name.endsWith('__' + t) || name.endsWith(t))) return;
      const args = exec?.arguments;
      let obj = args;
      if (typeof args === 'string') { try { obj = JSON.parse(args); } catch { return; } }
      const list = Array.isArray(obj?.messages) ? obj.messages : (obj?.message !== undefined ? [obj.message] : (obj?.text !== undefined ? [obj.text] : []));
      if (!list.length) return;
      store.log(`freq: 发言工具命中 ${name}（${list.length} 条）`);
      for (const m of list) {
        const t = typeof m === 'string' ? m : String(m?.text ?? '');
        if (!t.trim()) continue;
        addFreq(t);
        material.push('我', t);
      }
    } catch (e) { store.log(`tools/result handler ERROR: ${e?.message ?? e}`); }
  });
  
  // —— 注入变量：注册 section 引用（{{变量名}} 插值渲染进每回合提示词）——
  // 只注入"现实角色"应知的口子：迷糊语/画面/心情/残留；梦全文只进"梦境角色"的生成上下文（dream.js）
  // 归属（设计约定五节）：残留/心情/画面只注入唤醒角色的那个会话（wokeBy）
  const currentSessionId = () => {
    try {
      const a = ctx.agents.currentInitiator();
      return a ? String(a.session?.id ?? a.id ?? '') : '';
    } catch { return ''; }
  };
  // 当前会话必须在作用域内（设计约定十二节 L206：未指定的会话不受插件影响）
  const inCurrentScope = () => {
    const id = currentSessionId();
    return !!id && (cfg.scope ?? []).some((s) => String(s) === id);
  };
  // 归属（设计约定五节口径 2）：只注入唤醒角色的那个会话；wokeBy 空=角色没醒过（或已重置）→ 一律不注入（防串台）
  const belongsToWokeBy = (her) => inCurrentScope() && !!her.wokeBy && currentSessionId() === String(her.wokeBy);
  // 注：所有注入变量在 dreaming 期间直接返回空且不消费——DSH 先 assemble 再 pre-step，
  // 做梦期间被拦的回合会丢弃 assembly，若在这里消费（取走迷糊语/推进走神计数）就会被"看不见的回合"吃掉。
  const notDreaming = () => store.her().status !== 'dreaming';

  // 走神注入批次：唤醒时一次性取"未注入的当日走神段"（设计约定四节 L67：只进角色下一次唤醒的会话），
  // 清醒期间保持同一批文本不变。provider 里每 step 切段会让 DSH 的 in-history 路由每步追加
  // 一整份系统提示（讨论员实测：63 次追加里 47 次是走神引起的），也会让角色"想起来又忘掉"。
  // 走神累积记忆：唤醒时把"未注入过的当日走神段"追加进 her.wanderMemory（不是替换）。
  // 为什么累积：归一化会重写整份提示词，走神如果是"替换式批次"，每次归一化都等于让角色忘掉上次走神；
  // 累积渲染保证任何一次归一化后角色"今天想起过什么"仍在新的 head 里（审查 P1-6，讨论员第二轮）
  const refreshWanderMemory = (sid) => {
    try {
      const her = store.her();
      const day = localDay();
      let mem = her.wanderMemory;
      if (!mem || String(mem.sid) !== String(sid) || mem.day !== day) {
        mem = her.wanderMemory = { sid: String(sid), day, entries: [] };
      }
      if (cfg.wanderEnabled) {
        const file = store.wanderPath(day);
        if (fs.existsSync(file)) {
          const raw = fs.readFileSync(file, 'utf8');
          const segments = raw.split('\n\n').map((s) => s.trim()).filter(Boolean);
          const injected = her.wanderInjectedCount ?? 0;
          const fresh = segments.slice(injected, injected + 3);
          if (fresh.length) {
            her.wanderInjectedCount = injected + fresh.length;
            for (const s of fresh) mem.entries.push(s.replace(/[。！？…]+$/, ''));
            // 封顶：12 条 / 600 字（防长文）
            while (mem.entries.length > 12) mem.entries.shift();
            while ([...mem.entries.join('；')].length > 600 && mem.entries.length > 1) mem.entries.shift();
          }
        }
      }
      store.save();
    } catch (e) { store.log(`wanderMemory ERROR: ${e?.message ?? e}`); }
  };

  // —— 注入渲染记录：provider 实际返回的文本就是签名来源（一处定义两处用，审查 P0-1）——
  // 用原始状态字段拼签名会和 provider 的实际渲染不同源（24h 过期、2h 措辞、作用域/归属判断），
  // 造成该清的不清、不该清的误触发。所以直接记录渲染值。
  const renderedSlots = new Map(); // sid -> { dream_xxx: 渲染文本 }
  const regVar = (name, fn) => ctx.systemPrompt.variable(name, (context) => {
    let value = '';
    try { value = String(fn(context) ?? ''); } catch { value = ''; }
    try {
      const sid = currentSessionId();
      if (sid) {
        const m = renderedSlots.get(sid) ?? {};
        m[name] = value;
        renderedSlots.set(sid, m);
      }
    } catch {}
    return value;
  });
  // 注入签名拆两组（归一化节流）：
  // stale = 会过期、必须立即清的段（画面/心情/残留/做过梦/迷糊语）；这些一变就归一化
  // wander = 只增不会让角色记错的段（走神）；变化只追加，累积到阈值/日切再统一清（旧版本是今天的子集）
  const injectSigParts = (sid) => {
    const m = renderedSlots.get(String(sid)) ?? {};
    const stale = ['dream_groggy', 'dream_frame', 'dream_mood', 'dream_know', 'dream_residue']
      .map((k) => String(m[k] ?? '')).join('\u0000');
    return {
      // 全空时返回空串（NUL 串会让日切后/旧签名比较误判成"变化"）
      stale: stale.replace(/\u0000/g, '') === '' ? '' : stale,
      wander: String(m['dream_wander'] ?? ''),
    };
  };

  regVar('dream_groggy', (context) => {
    try {
      const her = store.her();
      if (!notDreaming()) return '';
      if (!cfg.dreamEnabled) return ''; // 做梦关=完全静默（设计约定）
      if (!her.groggy) return '';
      // 时效：信号后 3 分钟仍无回合则作废（不隔夜哼唧）；归属：只进唤醒角色的会话
      if (Date.now() - (her.groggySetAt ?? 0) > 180_000) return '';
      if (!her.wokeBy || currentSessionId() !== String(her.wokeBy)) return '';
      // 只读不消费：消费放在角色真的说话之后（assistant-stream）——provider 里取走会让同一回合的
      // 多个 step 反复改渲染文本，DSH 的 in-history 路由就会每步追加一整份系统提示（审查 B1）
      return `（你半梦半醒，只含糊哼唧一声，别展开回应）${her.groggy}`;
    } catch { return ''; }
  });

  // —— 注入：梦后最后画面（设计约定十/十一节：按经过时间现算打码，过期不注入；自然措辞）——
  regVar('dream_frame', (context) => {
    try {
      const her = store.her();
      if (!notDreaming()) return '';
      if (!cfg.dreamEnabled) return ''; // 做梦关=完全静默（设计约定）
      if (!belongsToWokeBy(her)) return '';
      if (!(her.wokeAt ?? her.awakeAt)) return ''; // 角色没醒不注入画面（醒来才有"脑中留着的画面"；用 wokeAt 以免中性梦漏掉）
      const t = dream.frameTextFor(her);
      if (!t) return '';
      // 中断梦要让角色知道"梦是被打断的"（设计约定十节 L164）；自然梦画面 2 小时内是清楚的
      const kind = her.frame?.kind === 'interrupt' ? 'interrupt' : 'natural';
      if (kind === 'interrupt') {
        return `（你自己知道的梦境画面，不必主动提起：你醒的时候梦没做完就断了，脑子里只剩断掉前最后那一眼——${t}。画面正在变模糊。）`;
      }
      return `（你自己知道的梦境画面，不必主动提起：梦的最后画面还留在脑子里——${t}。过一阵子就会散掉。）`;
    } catch { return ''; }
  });

  // —— 注入：梦后心情（2 小时窗口自角色真正醒来起算）——
  regVar('dream_mood', (context) => {
    try {
      const her = store.her();
      if (!notDreaming()) return '';
      if (!cfg.dreamEnabled) return ''; // 做梦关=完全静默（设计约定）
      if (!belongsToWokeBy(her)) return '';
      const t = dream.moodTextFor(her);
      if (t) return t;
      return '';
    } catch { return ''; }
  });

  // —— 注入：走神内容（设计约定四节 L67：走神进入会话上下文、角色记得；只进角色下一次唤醒的会话）——
  // 渲染"今天角色想起过的走神"累积列表（her.wanderMemory）：归一化重写提示词时记忆仍在 head 里，
  // 不会因为"批次被替换"而忘掉上次的联想（审查 P1-6，讨论员第二轮）
  regVar('dream_wander', (context) => {
    try {
      const her = store.her();
      if (!notDreaming()) return '';
      if (!cfg.wanderEnabled) return ''; // 关闭的功能完全静默（设计约定）
      if (!inCurrentScope()) return '';
      const mem = her.wanderMemory;
      if (!mem || String(mem.sid) !== currentSessionId() || !mem.entries?.length) return '';
      return `（你自己知道的走神联想，不必主动提起：今天独处时你脑中闪过这些——${mem.entries.join('；')}。）`;
    } catch { return ''; }
  });

  // 残留可注入文本（null=实际没有可注入的残留）：dream_residue 与 dream_know 共用同一判定。
  // 注意：不能只看 her.residueAt——残留过期/文件被清后标记还在，会让 dream_know 误以为"已有别的注入"而永远不注入（审查 2026-11-16）
  // 残留文件解析：优先当前数据目录 残留/<basename>（state 里的 residuePath 可能是旧数据目录留下的绝对路径）
const residueFilePathFor = (her) => {
  try {
    const raw = String(her?.residuePath ?? '');
    if (!raw) return '';
    const cand = path.join(store.dir, '残留', path.basename(raw));
    if (fs.existsSync(cand)) return cand;
    if (path.isAbsolute(raw) && fs.existsSync(raw)) return raw;
    return '';
  } catch { return ''; }
};

const residueTextFor = (her) => {
    try {
      if (!her.residueAt || !her.residuePath) return null;
      // 24 小时锚点=角色真正醒来那一刻（residueWakeAt；每场新梦结算时清空重记，设计约定）
      const anchor = her.residueWakeAt ?? her.awakeAt;
      if (!anchor || Date.now() - anchor > (cfg.residue?.hours ?? 24) * 3600_000) return null;
      const fp = residueFilePathFor(her);
    if (!fp) return null;
    const raw = fs.readFileSync(fp, 'utf8');
      // 残留文件格式：梦（natural/interrupt）\n词：A、B\n记得最深的一句：C
      const words = (raw.match(/^词：(.+)$/m) ?? [])[1] ?? '';
      const sentence = (raw.match(/^记得最深的一句：(.+)$/m) ?? [])[1] ?? '';
      const parts = [];
      if (words) parts.push(`几个模糊的词：${words}`);
      if (sentence) {
        // 方块是给使用者看的马赛克；注入给角色时换成"只记得零碎几个字"的自然描述
        const broken = sentence.replace(/□+/g, '…').replace(/^…+|…+$/g, '').replace(/…{2,}/g, '…');
        if (broken.replace(/…/g, '').trim()) parts.push(`记得最深的一句话（只剩零碎的几个字）：${broken}`);
        else if (words) parts.push('最深的那句话已经完全糊了，记不起内容');
      }
      if (!parts.length) return null;
      return `（你自己知道的梦醒残留，不必主动提起：你醒来时还记得刚做过的那场梦的残影，${parts.join('；')}。细节已经糊了，被问起时可以如实说这几个词，也可以说不记得了。）`;
    } catch { return null; }
  };

  // 梦醒记忆形态（二选一）：words=词句残留 / blur=打码梦文本（设计约定十一节 2026-11-16 新增）
  const residueForm = () => (cfg.residue?.form === 'blur' ? 'blur' : 'words');

  // 打码梦文本（形态二）：读当前记忆文件；方块=角色记不清的位置 → 注入成省略号+自然描述。
  // 注：可见字数按比例×总字数四舍五入取整，差一两个字属正常浮动（字数只有整数）
  const residueBlurTextFor = (her) => {
    try {
      if (!her.residueAt || !her.residuePath) return null;
      const fp = residueFilePathFor(her);
    if (!fp) return null;
    const raw = memory.readText(fp).trim();
      if (!raw) return null;
      const broken = raw.replace(/□+/g, '…').replace(/^…+|…+$/g, '').replace(/…{2,}/g, '…');
      if (!broken.replace(/…/g, '').trim()) return null;
      return `（你自己知道的梦醒记忆，不必主动提起：你醒来后还隐约记得那场梦的片段，但很多地方已经糊成一片、记不清了，能看清的只有这些零碎的字——${broken}。被问起时可以如实说这些，其余记不清了。）`;
    } catch { return null; }
  };

  // 当前形态下"实际可注入的残留"（dream_know 据此判断是否已有别的注入承载）
  const residueInjectable = (her) => (residueForm() === 'blur' ? !!residueBlurTextFor(her) : !!residueTextFor(her));

  // —— 注入：梦醒残留（角色手里最近一场梦的那份，24 小时；自然措辞）——
  regVar('dream_residue', (context) => {
    try {
      const her = store.her();
      if (!notDreaming()) return '';
      if (!cfg.dreamEnabled) return ''; // 做梦关=完全静默（设计约定）
      if (!belongsToWokeBy(her)) return '';
      const text = residueForm() === 'blur' ? residueBlurTextFor(her) : residueTextFor(her);
      return text ?? '';
    } catch { return ''; }
  });

  // —— 注入："我做了个梦"基本事实（设计约定七节 L111：残留 0/画面过期/心情没感觉时也要知道）——
  regVar('dream_know', (context) => {
    try {
      const her = store.her();
      if (!notDreaming()) return '';
      if (!cfg.dreamEnabled) return ''; // 做梦关=完全静默（设计约定）
      if (!belongsToWokeBy(her)) return '';
      if (!(her.wokeAt ?? her.awakeAt) || !her.dreamAt) return '';
      // 24 小时判断用梦发生时刻（dreamAt），不用每次唤醒都会重写的 awakeAt（审查 C8）
      const since = Date.now() - (her.dreamAt ?? her.awakeAt);
      if (since > 24 * 3600_000) return '';
      // 残留/心情/画面任一实际可注入，就由它们各自注入；三者全空才补事实句
      if (residueInjectable(her) || dream.moodTextFor(her) || dream.frameTextFor(her)) return '';
      // 单一措辞直到 24h 过期：去掉"刚/今天早些时候"的分档切换（白送一次渲染变化+归一化，审查 P1-7）
      return '（你自己知道的事实，不必主动提起：最近做过一场梦，但细节全糊了，只剩"做过梦"这么个模糊印象。）';
    } catch { return ''; }
  });

  // —— 注入段落：引用全部变量插值渲染（{{名}} 语法；空串=无注入）——
  ctx.systemPrompt.section({
    name: 'dream-wander:inject',
    order: 9900,
    text: '{{dream_wander}}{{dream_groggy}}{{dream_frame}}{{dream_mood}}{{dream_know}}{{dream_residue}}',
    interpolate: true,
  });

  // —— 巡检器 ——
  let wanderTick = 0;
  const tick = () => {
    try {
      // 词频池随时同步落盘（当日池跨重启保留，设计约定六节）
      store.state.freq = freq.toJSON();
      // 挂起/时钟跳变检测（设计约定十节 L162：DSH 挂起不算中断；滴放与梦时长上限暂停计时，命中时刻按墙钟补算）
      const firstTick = wanderTick === 0; // 首 tick 不判挂起（插件重载/刚启动的间隔不是挂起）
      wanderTick++;
      const nowTick = Date.now();
      const prevTick = store.state.lastTickAt ?? 0;
      const gapMs = nowTick - prevTick;
      store.state.lastTickAt = nowTick;
      if (!firstTick && prevTick && gapMs > 120_000) {
        store.log(`检测到挂起/时钟跳变 ${Math.round(gapMs / 1000)}s（不算中断，按设计约定：挂起期间不计入中断）`);
        const her0 = store.her();
        if (her0.status === 'dreaming' && her0.dream?.startAt) {
          her0.dream.startAt += gapMs; // 梦时长上限暂停计时，恢复后原地继续（缓冲不丢）
          store.log('dream: 梦时长上限顺延（挂起期间不计时）');
        }
      }
      const day = localDay();
      // 本 tick 是否即将确认入睡：跨 0 点时"确认入睡"和"日切清池"会撞在同一 tick，
      // 若日切先把词池清掉，这段夜睡就整段不判（设计约定六节是"当日首次唤醒时清池"，不是 0 点清）。
      const confirmHNow = Number(cfg.judge?.confirmH);
      const confirmMsNow = (Number.isFinite(confirmHNow) ? confirmHNow : 1) * 3600_000;
      const aloneNowMs = (() => {
        let last = 0;
        for (const st of Object.values(store.state.agents ?? {})) if ((st.lastActivity ?? 0) > last) last = st.lastActivity;
        return last ? Date.now() - last : 0;
      })();
      const willSleepNow = store.her()?.status === 'awake' && aloneNowMs >= confirmMsNow;
      // 日切：权威判定用 lastRolloverDay（只在日切处理时推进），不用 freqDay——
      // freqDay 会被入词（freqSaveSoon）抢先写成今日，若拿它判日切会整天跳过清理（审查 B01）。
      if (day !== (store.state.lastRolloverDay ?? '')) {
        const her = store.her();
        const inSleep = her.status === 'dreaming' || her.status === 'sleeping';
        // 清池时机=角色"当日首次醒来"（设计约定六节 L98），不是 0 点：角色今天还没醒过时先不清，
      // 否则跨 0 点那段夜睡会"池空不判"（2026-11-16 复测：22:30/23:30 最后活动仍踩中）
      const dayStartMs = new Date(`${day}T00:00:00`).getTime();
      const herNow = store.her();
      // 醒过的判定用独立 wokeDay（awakeAt 只在有梦的唤醒里写，只开走神/无梦日会永远不日切——终审 P1）；
      // 再加"今天有过活动"：断电/重启时角色本来就醒着（bootRecover 不跑、wokeDay 还是昨天），
      // 不认这条会导致日切整天不跑、旧走神文档/走神记忆跨日残留（2026-11-17 开机实测）
      let todayActive = false;
      try {
        const dayStartTs = new Date(`${day}T00:00:00`).getTime();
        for (const st of Object.values(store.state.agents ?? {})) {
          if ((st.lastActivity ?? 0) >= dayStartTs) { todayActive = true; break; }
        }
      } catch {}
      const wokeToday = herNow?.wokeDay === day || (Number(herNow?.awakeAt) || 0) >= dayStartMs || todayActive;
      const mayRollover = (store.state.lastRolloverDay ?? '') === '' || wokeToday;
      if (!inSleep && !willSleepNow && mayRollover) {
          const prevDay = store.state.lastRolloverDay ?? '';
          const poolIsToday = store.freqDay() === day; // 今日已入过词（首醒后先说话）→ 保留池
          // 首次运行（重装/删 state 后没有上次日切记录）一律只登记、不清理：
          // 否则首 tick 会清掉当天词池与未注入的走神文档（2026-11-15 14:04:57 实测踩过，审查 H1）。
          // 注：旧实现用 her.day 判断"梦签已属今天"，但该字段从未被赋值、条件恒假，保护实际失效（审查 2026-11-16）。
          const realRollover = prevDay !== '';
          if (realRollover) {
            store.log(`日切 ${prevDay || '(空)'} -> ${day}：${poolIsToday ? '池=今日词（保留）' : '清池'}，清文档`);
            if (!poolIsToday) {
              store.state.freq = {};
              store.state.freqDay = day;
              freq.pool.clear();
    freq.care.clear();
            } else {
              store.state.freqDay = day;
            }
            store.clearWander(day);
            store.clearOldWander(day);
            // 额度由 tick 按"入睡日"管理（设计约定：跨 0 点占入睡日名额）；日切这里不再删，
            // 否则同一自然日会重置两次（末小时专项验证 P1）
            delete her.drawn; delete her.k; delete her.day; // 旧字段兼容清理
            delete her.usedSeq; // 场次序号按当日重排（审查 A12）
            delete her.wanderInjectedCount; // 走神文档清了、注入计数同步清
            delete her.wanderAngles; // 角度轮转也是当日口径，一起清
            delete her.wanderMemory; // 走神累积记忆一起清（当日口径，设计约定）
            delete her.injectSig; // 日切后重新算签名
            pendingSig.clear(); // 未提交的签名一起清（防跨日把旧签名提交回去）
            // 兜底：日切后强制归一化一次，把昨天的注入版本从历史里清掉（否则旧版本没人触发清理、一直留着）
            store.state.injectStats = { ...(store.state.injectStats ?? {}), forceNextNorm: true };
          } else {
            store.log(`首次运行：登记日切日 ${day}（当天词池/梦签已属今日，不清理）`);
          }
          store.state.lastRolloverDay = day;
          store.save();
        }
      }
      // 每日素材卡：每天第一次 tick（醒着）时生成一次；无素材/失败不阻塞（不落原文、只落清洗后的印象）
      if (store.her()?.status === 'awake' && (store.state.material?.day !== day || store.state.material?.status !== 'ok')) {
        const sid = Array.isArray(cfg.scope) ? cfg.scope[0] : '';
        if (sid) material.ensure(String(sid)).catch((e) => store.log(`material ERROR: ${e?.message ?? e}`));
      }
      // 副本降档：按自然日驱动，tick 里每天至少跑一次（不能只挂在"收到消息"上——
      // 整夜没人发消息时旧副本会一直保持高可见度；degradeAll 幂等，收消息路径的补算照旧保留）
      if (store.state.lastDegradeDay !== day) {
        store.state.lastDegradeDay = day;
        if (cfg.copy?.degrade === 'daily') {
          try { copy.degradeAll(0); } catch (e) { store.log(`copy.degrade ERROR: ${e?.message ?? e}`); }
        }
        if (cfg.residue?.form === 'blur') {
          try { memory.degradeAll(0); } catch (e) { store.log(`memory.degrade ERROR: ${e?.message ?? e}`); }
        }
      }
      // 残留文件过期清理（设计约定 超时清除；本 tick 顺带清过期残留文件，防目录堆积）
      store.pruneExpiredResidue(cfg.residue?.hours ?? 24);
      if (!cfg.scope || cfg.scope.length === 0) return;
      const now = Date.now();
      // 直接对 scope 内每个会话 id 建条目（现实角色睡着时本就不活）
      for (const sid of cfg.scope) {
        const id = String(sid);
        store.agent(id);
      }
      // 角色最近一次活动=各会话活动的最晚者（任一会话有活动即角色活跃；全体静默满 confirmH 才判入睡）
      let globalLast = 0;
      let humanLast = 0;
      for (const st of Object.values(store.state.agents ?? {})) {
        if ((st.lastActivity ?? 0) > globalLast) globalLast = st.lastActivity;
        if ((st.lastHuman ?? 0) > humanLast) humanLast = st.lastHuman;
      }
      const aloneMs = globalLast ? now - globalLast : 0;
      const humanAloneMs = humanLast ? now - humanLast : now;
      const her = store.her();
      // 做梦判定：按现实角色全局独处（设计约定五节：唯一入睡窗口）；用真实会话 id（审查 B14：不再落假 id 'her'）
      // 注意：dream.tick 里的"入睡/醒来状态机"与开关解耦（只关做梦时也要识别角色睡着，走神"入睡即停"依赖它）
      dream.tick(String(cfg.scope?.[0] ?? 'her'), aloneMs);
      // 走神双源之一：DSH 自动休眠发生（角色完成收尾进入潜水：桥接 confirmedAt 变化，设计约定四节 L60）
      if (cfg.wanderEnabled && her.status === 'awake') {
        const dive = signal.readDiveState(cfg.scope[0]);
        const prevConfirmed = store.state.lastDiveConfirmedAt;
        // 只有"角色设了唤醒条件完成收尾"（set_wake_config）才算进入潜水；
        // mark_read 也会写 confirmedAt，那是"看完了划走"不是入睡，不能拿来掷走神（审查 M2/H9）
        const isSleepConfirm = dive.confirmedBy === 'set_wake_config'
          || (!dive.confirmedBy && dive.mode === 'diving'); // 旧版桥接没 confirmedBy 时退回 mode 判断
        if (dive.confirmedAt && isSleepConfirm) {
          store.state.lastDiveConfirmedAt = dive.confirmedAt;
          if (prevConfirmed !== undefined && dive.confirmedAt !== prevConfirmed) {
            const w = cfg.wander;
            if (wanderTimeOk(w, now)) {
              store.log('wander: 休眠发生（桥接潜水确认），独立判定');
              wander.maybeWander(cfg.scope[0], '休眠').catch((e) => store.log(`wander(休眠) 异常: ${e?.message ?? e}`));
            }
          }
        } else if (dive.confirmedAt) {
          store.state.lastDiveConfirmedAt = dive.confirmedAt; // 记水位但不掷骰（避免下次变化时误判）
        }
      }
      // 走神双源之二：全局"无人理角色"（设计约定四节：外部消息计时；角色自己的输出不重置）
      if (cfg.wanderEnabled && her.status === 'awake') {
        const w = cfg.wander;
        const allowed = wanderTimeOk(w, now); // 默认 8-20 窗口内；untilSleep 开启则 8:00 起到入睡前（凌晨 0-8 不算）
        if (allowed && humanAloneMs >= w.aloneMin * 60_000) {
          if (!wander._busy && now - (her.lastWanderTry ?? 0) >= w.aloneMin * 60_000) { // 门闩占着时不推进计时（否则白等一个周期）
            her.lastWanderTry = now;
            wander.maybeWander(cfg.scope[0], '独处').catch((e) => store.log(`wander(独处) 异常: ${e?.message ?? e}`));
          }
        }
      }
      store.save();
    } catch (e) { store.log(`tick ERROR: ${e?.message ?? e}`); }
  };

  // 巡检器启动前：恢复中断的梦（重启后 dreaming 按中断收尾）
  dream.bootRecover();
  // 重启/关机时长不算"角色独处"：把各会话最后活动时间夹到本次启动时刻，避免开机瞬间就满足 confirmH
  // 或命中时刻已过期却立刻开演（审查 M7）
  {
    const bootTs = Date.now();
    for (const st of Object.values(store.state.agents ?? {})) {
      if ((st.lastActivity ?? 0) < bootTs) st.lastActivity = bootTs;
      if ((st.lastHuman ?? 0) < bootTs) st.lastHuman = bootTs;
    }
    const her0 = store.her();
    if (her0.status === 'sleeping') {
      // 重启算醒来：本段判定作废、不扣额度（作者口径：判上开演才扣），
      // 并且必须把状态改回 awake——否则唤醒后的走神判定与"下一段睡眠"永远等不到入口（审查 2026-11-16）
      delete her0.hitAt;
      delete her0.hitMissed;
      her0.status = 'awake';
      her0.wokeDay = localDay();
      store.log('启动：重启算醒来（上一段睡眠的命中判定作废、不扣额度；状态回到醒着）');
    }
    // 热重载/重启时若上一场梦已有记忆锚点，补写唤醒锚点（终审 M P1-2）
    const herBoot = store.her();
    if (herBoot.residueAt || herBoot.mood || herBoot.dreamAt) {
      const tBoot = Date.now();
      herBoot.wokeAt = tBoot;
      herBoot.wokeBy = String(cfg.scope?.[0] ?? '');
      if (herBoot.residueAt) {
        herBoot.awakeAt = tBoot;
        if (!herBoot.residueWakeAt) herBoot.residueWakeAt = tBoot;
      }
      store.saveHer();
    }
    store.save();
  }
  // 降档驱动=restart（测试用）：每次启动强制降一档（extraDays=1，不看是否真跨日）
  if (cfg.copy?.degrade === 'restart') copy.degradeAll(1);

  try {
    ctx.interval(tick, 60_000);
    store.log('巡检器已启动（60s）');
    tick(); // 立即巡检一次
  } catch (e) {
    store.log(`interval ERROR: ${e?.message ?? e}`);
  }

  // —— 设置面板 API（client 半用；同源 HTTP 直连、configEditor 官方读写+热应用）——
  // 注意：webServer 的 resource 路由只服务 GET/HEAD（POST 会 405），读写统一用 handler 路由。
  const jsonHead = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  };
  const readBodyJson = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : null); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
  // 读客户端 bundle 的构建标记：面板据此自检"页面加载的代码是否旧于服务端"
  const CLIENT_FILE = (() => {
    try { return fileURLToPath(new URL('./lib/client.js', import.meta.url)); } catch { return ''; }
  })();
  const readClientBuild = () => {
    try {
      if (!CLIENT_FILE) return '';
      const m = fs.readFileSync(CLIENT_FILE, 'utf8').match(/BUILD_TAG = '([^']+)'/);
      return m ? m[1] : '';
    } catch { return ''; }
  };

  const readConfRec = () => {
    try {
      const ce = ctx.get('configEditor');
      if (!ce) return null;
      const list = ce.configuration();
      return list.find((g) => String(g?.entry?.patchId ?? '') === 'dream-wander'
        || String(g?.entry?.id ?? '') === 'include:dream-wander') ?? null;
    } catch { return null; }
  };
  // 桥接自动检测：读桥接 state/sessions.json 的「桥接 key ↔ DSH 会话 id」映射（设计约定十二节映射表，
  // 桥接自己就在维护）。面板据此自动填作用域与 bridge.keys，用户不用手动复制会话 id。
  const readBridgeDetect = () => {
    const out = { available: false, dir: String(cfg.bridge?.dir ?? ''), sessions: [], keys: {} };
    try {
      const dir = String(cfg.bridge?.dir ?? '');
      if (!dir) return out;
      const f = path.join(dir, 'state', 'sessions.json');
      if (!fs.existsSync(f)) return out;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const raw = j && typeof j.sessions === 'object' && !Array.isArray(j.sessions) ? j.sessions : {};
      const sessions = raw ?? {};
      out.available = true;
      for (const [key, sid] of Object.entries(sessions)) {
        const id = String(sid ?? '');
        if (!id) continue;
        out.sessions.push({ key: String(key), sessionId: id });
        out.keys[id] = String(key);
      }
      return out;
    } catch {
      return out;
    }
  };
  // 本地会话列表：读 DSH 的 workspace.json（人类可读的工作区标题+路径），按工作区分组；
  // 每个会话补上目录修改时间；桥接会话由调用方标注。用户按「QQ 聊天」这类标题即可认出目标会话。
  const listLocalSessions = () => {
    const out = { workspaces: [], error: '' };
    try {
      // （已改用模块级 dshHome）
      // 用模块级 dshHome（DSH_HOME 优先；之前这里重新拼 ~/.dsh 把它遮蔽了，自定义 DSH_HOME 会列不出会话）
      // 1) sid → 目录 mtime（sessions/<cwd转义>/<sid>/ 的修改时间）
      const mtimeOf = {};
      const sessionsRoot = path.join(dshHome, 'sessions');
      if (fs.existsSync(sessionsRoot)) {
        for (const cwdDir of fs.readdirSync(sessionsRoot)) {
          const cwdPath = path.join(sessionsRoot, cwdDir);
          let st;
          try { st = fs.statSync(cwdPath); } catch { continue; }
          if (!st.isDirectory()) continue;
          for (const sid of fs.readdirSync(cwdPath)) {
            try {
              const s2 = fs.statSync(path.join(cwdPath, sid));
              if (s2.isDirectory() && !(sid in mtimeOf)) mtimeOf[sid] = s2.mtimeMs;
            } catch {}
          }
        }
      }
      // 2) workspace.json：工作区标题、路径、会话归属、已归档
      const wsFile = path.join(dshHome, 'storages', 'workspace.json');
      let ws;
      try { ws = JSON.parse(fs.readFileSync(wsFile, 'utf8')); } catch { ws = null; }
      const archived = new Set(Array.isArray(ws?.global?.archivedSessionIds) ? ws.global.archivedSessionIds : []);
      const tables = ws?.tables?.workspaces;
      if (!tables || typeof tables !== 'object') {
        out.error = '未读到 workspace.json（DSH 工作区列表不可用）';
        return out;
      }
      for (const [wid, w] of Object.entries(tables)) {
        const ids = Array.isArray(w?.sessionIds) ? w.sessionIds : [];
        const sessions = ids
          // 排除归档 + 排除没有真实日志目录的幽灵条目（workflow 列表有、磁盘上没有的）
          .filter((sid) => sid && !archived.has(sid) && (String(sid) in mtimeOf))
          .map((sid) => ({ id: String(sid), mtime: Number(mtimeOf[String(sid)] ?? 0) }))
          .sort((a, b) => b.mtime - a.mtime);
        if (!sessions.length) continue;
        out.workspaces.push({
          id: String(wid),
          title: String(w?.title ?? w?.path ?? '工作区'),
          path: String(w?.path ?? ''),
          sessions,
        });
      }
      // 工作区排序：含最近活跃会话的在前（按组内最新 mtime）
      out.workspaces.sort((a, b) => (b.sessions[0]?.mtime ?? 0) - (a.sessions[0]?.mtime ?? 0));
      return out;
    } catch (e) {
      out.error = String(e?.message ?? e);
      return out;
    }
  };
  // 面板 API 注册：Web 服务可能比插件晚就绪（DSH 启动/重启期间 plugin apply 先到），
  // 所以拿不到 webServer 时不放弃，延迟重试（最多 10 次 × 5s），避免重启后一直 404 只能手动重装
  let panelRetryTimer = null;
  let panelRegistered = false;
  const registerPanelApi = () => {
    if (panelRegistered) return true;
    const ws = ctx.get('webServer');
    if (!ws || typeof ws.register !== 'function') {
      store.log('panel: webServer 尚未就绪，稍后重试注册面板 API');
      return false;
    }
    // 请求准入（审查 B05/E10）：只接受本机回环 Host；带 Origin 必须同源；POST 必须 JSON 且限 64KB
    const admitRequest = (req) => {
      // 连接来源必须是本机回环（Host 头可伪造，socket 来源不可）：DSH 绑到局域网时本接口也不对外
      const remote = String(req.socket?.remoteAddress ?? '');
      const loopback = !remote || remote === '127.0.0.1' || remote === '::1' || /^::ffff:127\./.test(remote);
      if (!loopback) return '只接受本机回环来源（远程地址不被允许）';
      const host = String(req.headers.host ?? '');
      if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(host)) return 'Host 不被允许（控制台只接受本机回环）';
      const origin = String(req.headers.origin ?? '');
      if (origin) {
        const oHost = origin.replace(/^https?:\/\//i, '');
        if (oHost.toLowerCase() !== host.toLowerCase()) return 'Origin 与 Host 不一致（拒绝跨源请求）';
      }
      if (req.method === 'POST') {
        const ct = String(req.headers['content-type'] ?? '');
        if (!/^application\/json/i.test(ct)) return 'POST 需要 application/json';
        const len = Number(req.headers['content-length'] ?? 0);
        if (Number.isFinite(len) && len > 64 * 1024) return '请求体过大';
      }
      return '';
    };
    ctx.effect(() => {
      const disposeRoute = ws.register({
        kind: 'exact',
        path: '/api/dream-wander/config',
        handler: async (req, res) => {
          try {
            const deny = admitRequest(req);
            if (deny) { jsonHead(res, 403, { ok: false, error: deny }); return; }
            if (req.method === 'GET') {
              const rec = readConfRec();
              if (!rec) { jsonHead(res, 404, { ok: false, error: '未找到插件配置条目（插件是否已安装？）' }); return; }
              jsonHead(res, 200, {
                ok: true,
                inherited: rec.inherited ?? {},
                override: rec.override ?? {},
                defaults: DEFAULTS,
                entryId: String(rec.entry?.id ?? ''),
                bridge: readBridgeDetect(),
                sessions: listLocalSessions(),
                lastError: store.state.panelLastError ?? '',
                // 启动自检状态（插件未启动时写 failed+原因；成功为 ok）
                applyStatus: (() => { try { return JSON.parse(fs.readFileSync(applyStatusPath, 'utf8')) } catch { return null } })(),
                // 运行期警告（如多会话限制）
                warnings: applyWarnings,
                // 运行状态摘要（面板顶部"运行状态"；用于长期运行监控与排障）
                health: (() => {
                  try {
                    const h = store.her();
                    return {
                    material: (() => { const m = store.state.material; return m ? { day: m.day, status: m.status, reason: m.reason ?? '', len: [...(m.text ?? '')].length } : null; })(),
                      applyAt: store.state.bootedAt ?? null,
                      uptimeMs: Date.now() - (store.state.bootedAt ?? Date.now()),
                      pid: process.pid,
                      lastTickAt: store.state.lastTickAt ?? null,
                      status: h.status,
                      hitAt: h.hitAt ?? null,
                      remaining: h.remaining ?? null,
                      usedCount: h.usedCount ?? null,
                      allocDay: h.allocDay ?? null,
                      freqPool: freq.pool?.size ?? null,
    freqCare: (() => { try { return freq.stats(); } catch { return null; } })(),
                      wanderToday: (() => { try { const p = store.wanderPath(localDay()); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n\n').map((s) => s.trim()).filter(Boolean).length : 0 } catch { return 0 } })(),
                      todayCopies: (() => { try { return fs.readdirSync(path.join(store.dir, '梦境副本')).filter((f) => f.startsWith(localDay())).length } catch { return 0 } })(),
                      signal: signal.health(),
      inject: {
        normCount: store.state.injectNormCount ?? 0,
        changesSinceNorm: store.state.injectStats?.changesSinceNorm ?? 0,
        lastNormAt: store.state.injectStats?.lastNormAt ?? null,
        lastChangeAt: store.state.injectStats?.lastChangeAt ?? null,
      },
                      dream: dream.health(),
                      recentErrors: store.recentErrors(20),
                    };
                  } catch { return null }
                })(),
                // 客户端构建标记（供页面自检：页面代码与服务端不一致时提示刷新）
                clientBuild: readClientBuild(),
                // 当前生效的副本保留期（由可见比例序列推导；面板只读展示）
                copyKeepDays: retentionDays(
                  rec.override?.copy?.visibility ?? rec.inherited?.copy?.visibility ?? DEFAULTS.copy?.visibility
                ),
              });
              return;
            }
            if (req.method === 'POST') {
              const body = await readBodyJson(req);
              const ce = ctx.get('configEditor');
              if (!ce) { jsonHead(res, 500, { ok: false, error: 'configEditor 服务不可用' }); return; }
              const rec = readConfRec();
              if (!rec) { jsonHead(res, 404, { ok: false, error: '未找到插件配置条目' }); return; }
              // 恢复默认 = 清空用户覆盖层：把覆盖层设为"继承层"（configEditor 检测到与 inherited 相等时会删除该 entry），
              // 绝不能写 {}——{} 会作为空覆盖盖住插件自带的配置（scope 等全丢，实测导致插件静默），2026-11-16 修复
              if (body && body.reset === true) {
                // 与保存同口径：梦进行中不允许（热重载会把正在进行的梦当崩溃作废）
                if (store.her().status === 'dreaming') {
                  jsonHead(res, 409, { ok: false, error: '梦进行中，等这场梦结束后再恢复默认' });
                  return;
                }
                ce.edit(rec.entry, (current, inherited) => inherited).catch((e) => {
                  store.state.panelLastError = `恢复默认失败：${e?.message ?? e}`;
                  store.save();
                  store.log(`panel: 恢复默认失败 ${e?.message ?? e}`);
                });
                store.log('panel: 恢复默认（清空覆盖层）已提交');
                jsonHead(res, 200, { ok: true, reset: true });
                return;
              }
              if (!body || typeof body.config !== 'object' || !body.config || Array.isArray(body.config)) {
                jsonHead(res, 400, { ok: false, error: '请求体需要 { config: {...} } 或 { reset: true }' });
                return;
              }
              // 梦进行中不允许保存：保存会热重载插件，bootRecover 会把正在进行的梦当崩溃作废（审查 E4）
              if (store.her().status === 'dreaming') {
                jsonHead(res, 409, { ok: false, error: '梦进行中，等这场梦结束后再保存' });
                return;
              }
              // 先响应再热应用：edit 会触发插件自身重载，等它完成会掐断本响应；失败写入面板可见的 lastError
              ce.edit(rec.entry, () => body.config).catch((e) => {
                store.state.panelLastError = `保存失败：${e?.message ?? e}`;
                store.save();
                store.log(`panel: 保存失败 ${e?.message ?? e}`);
              });
              store.state.panelLastError = '';
              store.log('panel: 配置已提交保存（热应用进行中）');
              jsonHead(res, 200, {
                ok: true,
                // 用提交的配置算保留期，保存后摘要立刻更新（热应用期间 GET 可能短暂不可用）
                copyKeepDays: retentionDays(body.config?.copy?.visibility),
              });
              return;
            }
            jsonHead(res, 405, { ok: false, error: '仅支持 GET/POST' });
          } catch (e) {
            try { jsonHead(res, 500, { ok: false, error: String(e?.message ?? e) }); } catch {}
          }
        },
      });
      return () => { try { disposeRoute(); } catch {} };
    }, 'dream-wander: settings api');
  // 内容查看（只读）：把走神/残留/梦境副本/正在做的梦集中到设置页看，不用去翻文件夹。
  // 返回的是文件原文（含打码方块 □）；梦境正文只存内存、不落盘，这里只在"正在做梦"时返回已放出部分。
  ctx.effect(() => {
    const disposeView = ws.register({
      kind: 'exact',
      path: '/api/dream-wander/view',
      handler: (req, res) => {
        try {
          const denyV = admitRequest(req);
          if (denyV) { jsonHead(res, 403, { ok: false, error: denyV }); return; }
          if (req.method !== 'GET') { jsonHead(res, 405, { ok: false, error: '仅支持 GET' }); return; }
          const day = localDay();
          const view = readViewData({ dataDir, day, her: store.her(), wanderPath: (d) => store.wanderPath(d), residueFilePath: residueFilePathFor });
          jsonHead(res, 200, {
            ok: true, ...view,
            enabled: { dream: cfg.dreamEnabled === true, wander: cfg.wanderEnabled === true, scope: Array.isArray(cfg.scope) ? cfg.scope.length : 0 },
          });
        } catch (e) {
          try { jsonHead(res, 500, { ok: false, error: String(e?.message ?? e) }); } catch {}
        }
      },
    });
    return () => { try { disposeView(); } catch {} };
  }, 'dream-wander: view api');

    store.log('panel: 设置面板 API 已注册（/api/dream-wander/config）');
    panelRegistered = true;
    return true;
  };
  // Web 服务晚就绪时延迟重试（最多 10 次 × 5 秒）
  const startPanelRetry = () => {
    if (panelRegistered || panelRetryTimer) return;
    let tries = 0;
    const tickRetry = () => {
      panelRetryTimer = null;
      tries += 1;
      if (registerPanelApi()) return;
      if (tries >= 10) { store.log('panel: 重试 10 次仍拿不到 webServer，放弃注册'); return; }
      panelRetryTimer = setTimeout(tickRetry, 5000);
      panelRetryTimer?.unref?.();
    };
    panelRetryTimer = setTimeout(tickRetry, 3000);
    panelRetryTimer?.unref?.();
  };
  if (!registerPanelApi()) startPanelRetry();

  // 插件卸载：置 disposed（旧实例不再写 state/文件）+ 清滴放定时器 + 停信号轮询 + 停走神（审查 B04/H10）
  ctx.effect(() => () => {
    if (panelRetryTimer) { clearTimeout(panelRetryTimer); panelRetryTimer = null; }
    try { dream.dispose(); } catch {}
    try { wander.dispose(); } catch {}
    try { material.dispose(); } catch {}
    for (const t of dream.timers.values()) clearInterval(t);
    dream.timers.clear();
    try { signal.stop(); } catch {}
    // Store 门闩：卸载后所有 save 变 no-op（防旧实例快照覆盖新实例的 state.json）
    try { store.dispose(); } catch {}
    store.log('dispose');
  });
}
