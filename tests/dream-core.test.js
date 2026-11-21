// dream.js 关键路径单测：入睡判定/额度、初始场景与半幕生成、收尾结算（interrupt/natural/
// timeout/internal/genfail/judgefail）、残留取词（3 词档 + 画面词失败回退）、画面/心情时效。
//
// 全部用 fake store + fake ctx + stub llm.stream 驱动**公开方法**（tick / onMessage /
// finishBySignal / bootRecover / frameTextFor / moodTextFor / health），不真跑 LLM、
// 不写磁盘、不碰真实数据目录（store 的写方法全是内存数组）。
//
// 落库位置：插件目录/tests/dream-core.test.js；相对导入 ../lib/dream.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { Dream } from '../lib/dream.js';
import { localDay } from '../lib/store.js';

// ---------------------------------------------------------------- fixtures

function baseCfg(over = {}) {
  return {
    dreamEnabled: true,
    llm: { provider: 'test', model: 'test' },
    retry: 0,
    judge: { confirmH: 1, windowH: 6, dreamsPerDay: 1, hitP: 1, lambdaRatio: 12, lambdaHours: null },
    play: { halfChars: [40, 40], intervalMin: [100, 100], actsPerRelease: 0.5, maxDurationMin: 90 },
    actJump: { sceneP: 0, timeP: 0, linkage: 0.75, chainP: 0.65 },
    residue: { form: 'words', hours: 24, tiers: [50, 100, 200, 300], visibility: [50, 30, 10, 0, 0] },
    copy: { degrade: 'daily', visibility: [80, 40, 20, 0, 0], keepDays: 3 },
    frame: { interruptMin: 30, naturalMin: 120 },
    mood: { hours: 2, scale: [70, 80, 60] },
    ...over,
  };
}

// 词频替身：drawWords 可指定顺序，便于断言"素材/方向词"装配；其余接口满足结算取词
function makeFreq(words = ['杯子', '裂纹', '床沿', '水渍', '台灯']) {
  return {
    pool: new Map(words.map((w) => [w, 1])),
    care: new Map(),
    drawWords: () => words.slice(),
    topHigh: () => words.slice(0, 3),
    isPronoun: () => false,
    isStopword: () => false,
    add() {},
    stats: () => ({ pool: words.length, care: 0, pickable: words.length, poolTotal: words.length, careTotal: 0 }),
    toJSON: () => ({}),
  };
}

// stub llm.stream：responses 每项是该次调用的 text-delta 数组；缺省返回空（模拟调用失败）
function makeStream(responses) {
  const calls = [];
  async function* stream(opts) {
    calls.push(opts);
    const r = responses.length ? responses.shift() : [];
    for (const ch of r) yield { type: 'text-delta', text: ch };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  return { stream, calls };
}

function makeHarness(opts = {}) {
  const her = opts.her ?? { status: 'awake' };
  const state = { her, freq: {}, freqDay: '' };
  const logs = [];
  const residues = {};
  const copies = [];
  const dir = path.join(os.tmpdir(), 'dw-dream-unit-' + process.pid + '-' + Math.random().toString(36).slice(2));
  const store = {
    dir, // 不存在也没关系：#nextSeqFor 的 readdir 失败会被内部 catch 成 0
    state,
    her: () => state.her,
    log: (m) => logs.push(String(m)),
    save: () => {},
    saveHer: () => {},
    writeResidue: (day, seq, content) => { residues[`${day}-${seq}`] = content; },
    residuePath: (day, seq = '') => path.join(dir, '残留', `${day}${seq ? `-${seq}` : ''}.md`),
    pruneResidue: () => {},
    writeCopy: (day, seq, content) => { copies.push({ day, seq, text: content }); },
  };
  const { stream, calls } = makeStream(opts.responses ?? []);
  const ctx = {
    agents: { get: () => null, withInitiator: (a, f) => f() },
    llm: { stream },
  };
  const dream = new Dream(ctx, store, opts.cfg ?? baseCfg());
  dream._scopeSessionId = 'sid-test';
  dream._freq = opts.freq ?? makeFreq();
  dream._signal = { start() {}, stop() {} };
  dream._interrupt = { clearCount() {} };
  dream._copy = {
    writeNew: (day, seq, text) => { copies.push({ day, seq, text }); return `${day}-${seq}.md`; },
    degradeAll: () => {},
  };
  dream._memory = { writeNew: () => '', pathOf: (n) => path.join(dir, '残留', n), degradeAll: () => {} };
  return { dream, store, state, her, logs, residues, copies, llmCalls: calls };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 轮询等待（真实定时器；用于滴放/异步结算这类短窗口）
async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}

// 只推进微任务/宏任务队列（mock timers 场景下不能用 setTimeout，改用 setImmediate）
async function flush(n = 30) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

function dreamSt(released = '', extra = {}) {
  return {
    startAt: Date.now(),
    released,
    buffer: '',
    dripIdx: 0,
    halfN: 2,
    sceneChars: 0,
    firstBaseChars: 0,
    firstBudgetMs: 0,
    ...extra,
  };
}

// ---------------------------------------------------------------- 入睡 / 额度

test('tick：静默满 confirmH 确认入睡；新入睡日分配额度并按曲线抽命中时刻', async (t) => {
  const her = { status: 'awake' };
  const h = makeHarness({ her });
  t.after(() => h.dream.dispose());

  h.dream.tick('sid', 30 * 60_000); // 不足 1h
  assert.equal(her.status, 'awake', '不足 confirmH 不睡');

  h.dream.tick('sid', 2 * 3600_000);
  assert.equal(her.status, 'sleeping');
  assert.equal(her.allocDay, localDay(Date.now() - 2 * 3600_000), '额度日=入睡日（最后活动那天）');
  assert.equal(her.remaining, 1);
  assert.ok(Number.isFinite(her.hitAt), 'hitP=1 时必然抽到命中时刻');
});

test('tick：池空时本段不判定（无 hitAt、不占额度、下次有词再判）', async (t) => {
  const her = { status: 'awake' };
  const h = makeHarness({ her, freq: makeFreq([]) });
  t.after(() => h.dream.dispose());
  h.dream.tick('sid', 2 * 3600_000);
  assert.equal(her.status, 'sleeping');
  assert.equal(her.hitAt, undefined);
  assert.equal(her.remaining, 1);
  assert.ok(h.logs.some((l) => l.includes('池空')));
});

test('tick：额度=0 时命中时刻到也不开演', async (t) => {
  const her = { status: 'sleeping', hitAt: Date.now() - 1, remaining: 0, usedCount: 1, allocDay: localDay() };
  const h = makeHarness({ her });
  t.after(() => h.dream.dispose());
  h.dream.tick('sid', 0);
  await flush();
  assert.equal(her.status, 'sleeping');
  assert.equal(her.dream, undefined);
});

test('onMessage：睡眠中命中时刻未到就醒 → 回 awake、本段作废不扣额度', async (t) => {
  const her = { status: 'sleeping', hitAt: Date.now() + 3600_000, remaining: 1 };
  const h = makeHarness({ her });
  t.after(() => h.dream.dispose());
  h.dream.onMessage('sid');
  assert.equal(her.status, 'awake');
  assert.equal(her.hitAt, undefined);
  assert.equal(her.remaining, 1);
  assert.ok(h.logs.some((l) => l.includes('命中时刻未到就醒')));
});

test('bootRecover：重启时 dreaming 一律作废（状态回 awake、梦/画面/命中清空）', async (t) => {
  const her = {
    status: 'dreaming',
    dream: { released: '梦文本', buffer: '', dripIdx: 0 },
    hitAt: 123,
    frame: { text: '最后画面', at: Date.now(), kind: 'interrupt' },
    pendingShapes: ['变形'],
  };
  const h = makeHarness({ her });
  t.after(() => h.dream.dispose());
  h.dream.bootRecover();
  assert.equal(her.status, 'awake');
  assert.equal(her.dream, undefined);
  assert.equal(her.hitAt, undefined);
  assert.equal(her.frame, undefined);
  assert.equal(her.pendingShapes, undefined);
  assert.equal(her.wokeDay, localDay());
  assert.ok(h.logs.some((l) => l.includes('崩溃恢复')));
});

// ---------------------------------------------------------------- 生成路径

test('tick：命中开演 → 初始场景 ≤50 字、素材 5 词、开场用词从方向词中剔除、额度当场扣', async (t) => {
  const her = { status: 'sleeping', hitAt: Date.now() - 1, remaining: 1, usedCount: 0, allocDay: localDay() };
  const sceneBody = '夜里的房间很安静，窗帘缝里透进一点光。'.repeat(8); // >50 字，验证截断
  const h = makeHarness({ her, responses: [[sceneBody + '\n【用词】杯子、裂纹']] });
  t.after(() => h.dream.dispose());

  h.dream.tick('sid', 0);
  const ok = await waitFor(() => her.status === 'dreaming' && her.dream && her.dream.buffer.length > 0);
  assert.ok(ok, '初始场景应生成');
  assert.ok([...her.dream.buffer].length <= 50, '初始场景 ≤50 字');
  assert.deepEqual(her.dream.words, ['杯子', '裂纹', '床沿', '水渍', '台灯'], '入梦素材=drawWords 结果');
  assert.deepEqual(her.dream.dirWords, ['床沿', '水渍', '台灯'], '方向词=未用于开场的素材，最多 3 个');
  assert.equal(her.remaining, 0, '开演当场扣 1 场额度');
  assert.equal(her.usedCount, 1);
});

test('tick：场景生成失败 → genfail 结算（回 sleeping、无残留/心情/画面、不写副本、已扣额度不退）', async (t) => {
  const her = { status: 'sleeping', hitAt: Date.now() - 1, remaining: 1, usedCount: 0, allocDay: localDay() };
  const cfg = baseCfg({ retry: 0 });
  const h = makeHarness({ her, cfg, responses: [[]] });
  t.after(() => h.dream.dispose());

  h.dream.tick('sid', 0);
  const ok = await waitFor(() => her.status === 'sleeping' && !her.dream);
  assert.ok(ok, 'genfail 应回落 sleeping');
  assert.equal(her.residueAt, undefined);
  assert.equal(her.mood, undefined);
  assert.equal(her.frame, undefined);
  assert.equal(her.dreamAt, undefined, '0 字失败不记"做过梦"');
  assert.equal(her.remaining, 0, '开演即扣，失败不退还');
  assert.equal(h.copies.length, 0);
  assert.ok(h.logs.some((l) => l.includes('生成失败')));
});

test('tick：场景生成第一次空 → 重试成功（retry=1，mock 定时器跳过 3 秒等待）', async (t) => {
  if (typeof t.mock?.timers?.enable !== 'function') {
    t.skip('当前 Node 无 t.mock.timers（需 Node >= 20.4），跳过重试等待测试');
    return;
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const her = { status: 'sleeping', hitAt: Date.now() - 1, remaining: 1, usedCount: 0, allocDay: localDay() };
  const cfg = baseCfg({ retry: 1 });
  const h = makeHarness({ her, cfg, responses: [[], ['夜里的房间。']] });
  t.after(() => h.dream.dispose());

  h.dream.tick('sid', 0);
  await flush(); // 第一次生成空 → 进入 3 秒等待
  assert.ok(h.logs.some((l) => l.includes('重试 1/1')), '应记录一次重试');
  t.mock.timers.tick(3000);
  await flush(); // 重试生成成功
  assert.equal(her.status, 'dreaming');
  assert.ok(her.dream && [...her.dream.buffer].length > 0, '重试成功后场景已缓冲');
  assert.equal(h.llmCalls.length, 2, '场景调用 2 次（失败 + 重试）');
});

// ---------------------------------------------------------------- 结算路径

test('结算 interrupt：状态回 awake、画面/心情/残留/副本一次写全、3 词档第三词来自画面词调用', async (t) => {
  const deep = '最后杯子还在桌上。';
  const block = Array(30).fill('面试 房间 杯子 台灯 水渍 裂纹 。').join('');
  const released = block + deep;
  assert.ok([...released].length >= 300, '需要 3 词档');
  const her = {
    status: 'dreaming',
    remaining: 0,
    usedCount: 1,
    dream: dreamSt(released, { judgedByCharacter: true, moodKind: 'good', deepSentence: deep }),
  };
  // 画面词调用返回"水渍"（合法、且不在词频前二里）→ 第三词用它
  const h = makeHarness({ her, responses: [['水渍']] });
  t.after(() => h.dream.dispose());

  await h.dream.finishBySignal('sid');
  assert.equal(her.status, 'awake');
  assert.equal(her.dream, undefined);
  assert.ok(her.awakeAt > 0 && her.residueWakeAt > 0, '梦醒锚点已记');
  assert.equal(her.mood.kind, 'good');
  assert.equal(her.frame.kind, 'interrupt');
  assert.ok(her.residueAt > 0 && her.residuePath.endsWith('-1.md'));

  assert.equal(h.copies.length, 1, '副本只存已放出文本');
  assert.ok(h.copies[0].text.includes(deep));
  const res = Object.values(h.residues)[0];
  assert.ok(res.startsWith('梦（interrupt）'));
  const words = res.match(/^词：(.*)$/m)[1].split('、');
  assert.deepEqual(words, ['面试', '房间', '水渍'], '词频前二 + 画面词（去重后 3 词）');
  const masked = res.match(/^记得最深的一句：(.*)$/m)[1];
  assert.equal([...masked].length, [...deep].length, '保留句占位不塌缩');
  assert.ok((masked.match(/[^□]/g) ?? []).length >= 3, '保留句至少留 3 个字位');
  assert.equal(her.residueWakeAt > 0, true);
});

test('结算 interrupt：画面词调用失败/非法时回退画面词频，仍凑满 3 词', async (t) => {
  const deep = '最后杯子还在桌上。';
  const block = Array(30).fill('面试 房间 杯子 台灯 水渍 裂纹 。').join('');
  const her = {
    status: 'dreaming',
    remaining: 0,
    usedCount: 1,
    dream: dreamSt(block + deep, { judgedByCharacter: true, moodKind: 'bad', deepSentence: deep }),
  };
  const h = makeHarness({ her, responses: [[]] }); // 画面词调用空 → 走词频回退
  t.after(() => h.dream.dispose());

  await h.dream.finishBySignal('sid');
  const res = Object.values(h.residues)[0];
  const words = res.match(/^词：(.*)$/m)[1].split('、');
  assert.equal(words.length, 3, '回退后仍为 3 词');
  assert.equal(new Set(words).size, 3, '三词互不重复');
  for (const w of words) assert.ok([...w].length >= 2, '无单字碎片: ' + w);
  assert.equal(her.mood.kind, 'bad');
  assert.ok(h.logs.some((l) => l.includes('画面重要词')), '记录了画面词回退');
});

test('残留档位：<50=1词；50-100=1句；100-200=1词1句；200-300=2词1句（300+ 见上一测）', async (t) => {
  const cases = [
    { n: 4, lo: 0, hi: 50, words: 1, sentence: false }, // 29 字：1 词、无句
    { n: 9, lo: 50, hi: 100, words: 0, sentence: true }, // 59 字：只保留 1 句
    { n: 20, lo: 100, hi: 200, words: 1, sentence: true }, // 125 字：1 词 1 句
    { n: 40, lo: 200, hi: 300, words: 2, sentence: true }, // 245 字：2 词 1 句
  ];
  for (const c of cases) {
    const deep = '台灯还在。';
    const released = Array(c.n).fill('杯子 台灯 ').join('') + deep;
    const len = [...released].length;
    assert.ok(len >= c.lo && len < c.hi, `len=${len} 应落在 ${c.lo}-${c.hi} 档`);
    const her = {
      status: 'dreaming',
      remaining: 0,
      usedCount: 1,
      dream: dreamSt(released, { judgedByCharacter: true, moodKind: 'neutral', deepSentence: deep }),
    };
    const h = makeHarness({ her });
    t.after(() => h.dream.dispose());
    await h.dream.finishBySignal('sid');
    const res = Object.values(h.residues)[0];
    const wordsLine = res.match(/^词：(.*)$/m);
    const count = wordsLine ? wordsLine[1].split('、').length : 0;
    assert.equal(count, c.words, `档位词数（len=${len}）`);
    assert.equal(/^记得最深的一句：/m.test(res), c.sentence, `档位是否保留句子（len=${len}）`);
  }
});

test('结算 judgefail：判断调用最终失败 → awake、残留=无、心情/画面=没感觉、已放出文本仍归档副本', async (t) => {
  const released = Array(6).fill('杯子 裂纹 床沿 水渍 台灯 。').join('');
  const her = {
    status: 'dreaming',
    remaining: 0,
    usedCount: 1,
    dream: dreamSt(released, { judgedByCharacter: false }),
  };
  const h = makeHarness({ her, responses: [[]] }); // 判断调用空
  t.after(() => h.dream.dispose());

  await h.dream.finishBySignal('sid');
  assert.equal(her.status, 'awake', '按中断处理=角色醒来');
  assert.equal(her.dream, undefined);
  assert.equal(her.residueAt, undefined);
  assert.equal(her.mood, undefined);
  assert.equal(her.frame, undefined);
  assert.ok(her.dreamAt > 0, '有已放出文本 → 知道"做过梦"');
  assert.equal(h.copies.length, 1, '失败但已放出的文本归档副本');
  assert.ok(h.logs.some((l) => l.includes('判断调用最终失败') || l.includes('判断失败')));
});

test('结算 timeout：梦时长上限到点 → 按自然结束（sleeping、frame=natural、副本/残留）', async (t) => {
  const released = Array(4).fill('杯子 裂纹 床沿 水渍 台灯 。').join('');
  const deep = '水渍还在。';
  const her = {
    status: 'dreaming',
    remaining: 0,
    usedCount: 1,
    dream: dreamSt(released + deep, {
      startAt: Date.now() - 91 * 60_000,
      judgedByCharacter: true,
      moodKind: 'bad',
      deepSentence: deep,
    }),
  };
  const h = makeHarness({ her });
  t.after(() => h.dream.dispose());

  h.dream.tick('sid', 0);
  const ok = await waitFor(() => her.status === 'sleeping' && !her.dream);
  assert.ok(ok, 'timeout 应结算');
  assert.ok(h.logs.some((l) => l.includes('梦时长上限到点')));
  assert.equal(her.status, 'sleeping', '角色未醒，回沉睡');
  assert.equal(her.awakeAt, undefined);
  assert.equal(her.frame.kind, 'natural', '超时按自然画面留存');
  assert.equal(her.mood.kind, 'bad');
  assert.ok(her.residueAt > 0);
  assert.equal(h.copies.length, 1);
});

test('结算 natural：滴放完成后自然收尾 → sleeping、frame=natural、心情/残留/副本，唤醒锚点不写', async (t) => {
  const her = { status: 'sleeping', hitAt: Date.now() - 1, remaining: 1, usedCount: 0, allocDay: localDay() };
  const cfg = baseCfg();
  cfg.play = { halfChars: [40, 40], intervalMin: [0.001, 0.001], actsPerRelease: 0.5, maxDurationMin: 90 };
  const half = '杯子在床沿。水渍还在。【收尾】\n好\n【最深】水渍还在。';
  const h = makeHarness({ her, cfg, responses: [['夜里的房间。'], [half]] });
  t.after(() => h.dream.dispose());

  h.dream.tick('sid', 0);
  const ok = await waitFor(() => her.status === 'sleeping' && !her.dream, 8000);
  assert.ok(ok, '自然收尾应完成结算');
  assert.ok(h.logs.some((l) => l.includes('自然结束')));
  assert.equal(her.mood.kind, 'good', '收尾判断=好 → 心情好');
  assert.equal(her.frame.kind, 'natural');
  assert.ok(her.residueAt > 0);
  assert.equal(her.awakeAt, undefined, '自然结束角色仍在睡');
  assert.equal(her.residueWakeAt, undefined, '未真正醒来不记 24h 锚点');
  assert.equal(h.copies.length, 1);
});

test('结算 internal：收尾半幕是【惊醒】→ 内部中断（sleeping、frame=interrupt、心情坏）', async (t) => {
  const her = { status: 'sleeping', hitAt: Date.now() - 1, remaining: 1, usedCount: 0, allocDay: localDay() };
  const cfg = baseCfg();
  cfg.play = { halfChars: [40, 40], intervalMin: [0.001, 0.001], actsPerRelease: 0.5, maxDurationMin: 90 };
  const half = '忽然踩空，心里一惊。【惊醒】\n坏\n【最深】忽然踩空。';
  const h = makeHarness({ her, cfg, responses: [['夜里的房间。'], [half]] });
  t.after(() => h.dream.dispose());

  h.dream.tick('sid', 0);
  const ok = await waitFor(() => her.status === 'sleeping' && !her.dream, 8000);
  assert.ok(ok, '内部中断应完成结算');
  assert.ok(h.logs.some((l) => l.includes('内部中断结束')));
  assert.equal(her.status, 'sleeping', '内部中断角色未醒');
  assert.equal(her.frame.kind, 'interrupt', '中断画面按 30 分钟档');
  assert.equal(her.mood.kind, 'bad');
  assert.equal(her.awakeAt, undefined);
  assert.equal(h.copies.length, 1);
});

// ---------------------------------------------------------------- 注入时效辅助

test('frameTextFor：中断画面按留存三等分阶梯打码、自然画面到期消失', async (t) => {
  const h = makeHarness();
  t.after(() => h.dream.dispose());
  const now = Date.now();
  const text = '一二三四五六七八九十'; // 10 字
  const box = (s) => [...s].filter((c) => c === '□').length;

  assert.equal(h.dream.frameTextFor({ frame: { text, at: now, kind: 'interrupt' } }), text);
  assert.equal(box(h.dream.frameTextFor({ frame: { text, at: now - 15 * 60_000, kind: 'interrupt' } })), 5, '中段遮 50%');
  assert.equal(box(h.dream.frameTextFor({ frame: { text, at: now - 25 * 60_000, kind: 'interrupt' } })), 7, '末段只剩 25%');
  assert.equal(h.dream.frameTextFor({ frame: { text, at: now - 31 * 60_000, kind: 'interrupt' } }), null);
  assert.equal(h.dream.frameTextFor({ frame: { text, at: now - 119 * 60_000, kind: 'natural' } }), text);
  assert.equal(h.dream.frameTextFor({ frame: { text, at: now - 121 * 60_000, kind: 'natural' } }), null);
  assert.equal(h.dream.frameTextFor({ frame: { text: '', at: now, kind: 'natural' } }), null);
});

test('moodTextFor：2 小时窗口 + 无画面=没感觉 + 自然过期', async (t) => {
  const h = makeHarness();
  t.after(() => h.dream.dispose());
  const now = Date.now();
  const frame = { text: '杯子在床沿', at: now, kind: 'natural' };

  assert.equal(h.dream.moodTextFor({ mood: { kind: 'good' }, awakeAt: now }), null, '无画面凭据 → null');
  const st = { mood: { kind: 'good' }, awakeAt: now, frame };
  assert.match(h.dream.moodTextFor(st), /好梦/);
  st.awakeAt = now - 3 * 3600_000;
  assert.equal(h.dream.moodTextFor(st), null, '2 小时窗口外 → null');
  assert.equal(
    h.dream.moodTextFor({ mood: { kind: 'bad' }, awakeAt: now, frame: { ...frame, at: now - 121 * 60_000 } }),
    null,
    '画面已过期 → 没感觉',
  );
});

test('health：运行状态摘要字段齐全（面板 GET 依赖）', async (t) => {
  const her = {
    status: 'sleeping',
    hitAt: 111,
    remaining: 0,
    usedCount: 1,
    allocDay: '2026-11-21',
    dreamAt: 222,
  };
  const h = makeHarness({ her });
  t.after(() => h.dream.dispose());
  const health = h.dream.health();
  assert.equal(health.status, 'sleeping');
  assert.equal(health.hitAt, 111);
  assert.equal(health.remaining, 0);
  assert.equal(health.usedCount, 1);
  assert.equal(health.allocDay, '2026-11-21');
  assert.equal(health.dreamAt, 222);
  assert.equal(health.dreamHalfN, null);
  assert.ok('lastFinish' in health);
});
