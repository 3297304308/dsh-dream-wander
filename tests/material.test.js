import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCard, cleanRawText, Material } from '../lib/material.js';

test('sanitizeCard：剔除日期/数字/引号/时间词，保留模糊印象', () => {
  const raw = [
    '事：11月16日下午面试，等了很久。',
    '画面：桌上的杯子晾着，水凉了。',
    '念头：这两天一直悬着件事。',
    '事：昨天对方说了句"再等等"。',
    '感觉：手有点凉。',
  ].join('\n');
  const card = sanitizeCard(raw);
  assert.ok(!card.includes('11月16日'), '日期行应被剔除');
  assert.ok(!card.includes('昨天'), '昨天行应被剔除');
  assert.ok(!card.includes('再等等'), '引号原话行应被剔除');
  assert.ok(card.includes('桌上的杯子晾着'), '正常印象应保留');
  assert.ok(card.includes('这两天一直悬着件事'), '模糊时间说法应保留');
});

test('sanitizeCard：空/全废返回空串', () => {
  assert.equal(sanitizeCard(''), '');
  assert.equal(sanitizeCard('11月16日\n昨天\n句子带"引号"'), '');
});

test('Material.get：今日卡优先，过期卡不返回', () => {
  const cfg = { wander: { material: { enabled: true, days: 3 } }, dreamEnabled: true, wanderEnabled: true };
  const store = { state: { material: { day: '2026-11-18', status: 'ok', text: '今天的印象' } }, save() {} };
  const m = new Material({}, store, cfg);
  // 今天（日期依赖 localDay，用 store.state 里的 day 与实际 localDay 比较；直接给 status=ok 且 day 用 localDay 才返回）
  const today = new Date();
  const day = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  store.state.material = { day, status: 'ok', text: '今天的印象' };
  assert.equal(m.get(), '今天的印象');
  // 只有过期旧卡（days=1，10 天前）→ 返回空
  store.state.material = { day: '2000-01-01', status: 'ok', text: '旧', days: [{ day: '2000-01-01', t: Date.now() - 10 * 86400000, text: '旧' }] };
  assert.equal(m.get(), '');
  // 旧卡在窗口内 → 返回最近的
  store.state.material = { day: '2000-01-01', status: 'ok', text: '旧', days: [{ day: '2000-01-01', t: Date.now() - 86400000, text: '一天前的' }] };
  assert.equal(m.get(), '一天前的');
});

test('cleanRawText：时间词模糊化、数字打码、去引号/URL', () => {
  const t = cleanRawText('今天下午面试，11月16日，说"再等等"，看 https://x.com/a 怎么样');
  assert.ok(!/今天|下午|11|16/.test(t), '精确时间词/数字已处理');
  assert.ok(!/前些天|那阵子|有一回|早些时候/.test(t), '不应被替换成生硬的词');
  assert.ok(!/11|16/.test(t), '数字应打码');
  assert.ok(!t.includes('"'), '引号应去掉');
  assert.ok(!t.includes('http'), 'URL 应去掉');
  assert.ok(t.includes('再等等'), '内容保留');
});

test('Material.get：raw 模式取内存消息片段（无消息返回空）', () => {
  const cfg = { wander: { material: { enabled: true, days: 3, form: 'raw' } }, dreamEnabled: true, wanderEnabled: true };
  const store = { state: { material: null }, save() {} };
  const m = new Material({}, store, cfg);
  assert.equal(m.get(), '');
  m.push('对方', '今天有点累，想早点睡');
  m.push('我', '那就别熬了');
  const raw = m.get();
  assert.ok(raw.includes('对方：'), '应含对方发言');
  assert.ok(raw.includes('我：'), '应含自己发言');
  assert.ok(!raw.includes('今天'), 'raw 模式时间词也应模糊化');
});

// —— ensure 集成路径（fake ctx.llm.stream；覆盖审核发现的 P0/P1 漏网路径）——
function fakeCtx(reply) {
  return {
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', text: reply };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    agents: { currentInitiator: () => null, withInitiator: async (_a, fn) => fn() },
  };
}
function mkStore(initial) {
  return { state: { material: initial ?? null, freq: {}, her: {} }, save() {}, log() {} };
}
const cfgOn = { dreamEnabled: true, wanderEnabled: true, wander: { material: { enabled: true, days: 3, form: 'digest' } }, llm: {}, retry: 2 };

test('ensure：digest 正常生成一张卡（清洗后入 state）', async () => {
  const store = mkStore(null);
  const m = new Material(fakeCtx('事：这两天心里悬着件事。\n画面：桌上的杯子晾着，水凉了。'), store, cfgOn);
  m.push('对方', '面试的事这两天一直没消息');
  await m.ensure('sid');
  assert.equal(store.state.material.status, 'ok');
  assert.ok(store.state.material.text.includes('杯子') || store.state.material.text.includes('悬着'));
  assert.ok(!store.state.material.text.includes('这两天心里悬着件事。；'), '不应出现 。； 拼接');
  assert.equal(m.get(), store.state.material.text);
});

test('ensure：raw 模式不崩（防 TDZ），且不调用 LLM', async () => {
  let calls = 0;
  const ctx = { llm: { stream: async function* () { calls++; yield { type: 'text-delta', text: 'x' }; } }, agents: { currentInitiator: () => null, withInitiator: async (_a, fn) => fn() } };
  const cfg = { dreamEnabled: true, wanderEnabled: true, wander: { material: { enabled: true, days: 3, form: 'raw' } } };
  const store = mkStore(null);
  const m = new Material(ctx, store, cfg);
  m.push('对方', '今晚一起吃饭吧');
  await m.ensure('sid'); // 不应 throw ReferenceError
  assert.equal(calls, 0, 'raw 模式不调用摘要');
  assert.equal(store.state.material.status, 'raw');
  assert.ok(m.get().includes('对方：'), 'raw get 能取到消息');
});

test('ensure：空缓冲只写 skipped，之后有消息可重试生成', async () => {
  const store = mkStore({ day: '2026-11-18', status: 'skipped', reason: 'no-material', days: [] });
  const today = new Date();
  const day = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  store.state.material.day = day; // 当天已 skipped
  const m = new Material(fakeCtx('事：有点累。'), store, cfgOn);
  await m.ensure('sid'); // 空缓冲：不覆盖、不调用
  assert.equal(store.state.material.status, 'skipped');
  m.push('对方', '今天有点累');
  await m.ensure('sid'); // 有消息 → 当天重试成功（skipped 非终态）
  assert.equal(store.state.material.status, 'ok', 'skipped 后应允许当天重试');
});

test('ensure：关闭素材卡后不收集、不注入', async () => {
  const cfg = { dreamEnabled: true, wanderEnabled: true, wander: { material: { enabled: false, days: 3, form: 'digest' } } };
  const store = mkStore({ day: '2026-11-18', status: 'ok', text: '旧卡' });
  const m = new Material(fakeCtx('x'), store, cfg);
  m.push('对方', '私密消息');
  assert.equal(m.get(), '', '关闭后不再注入');
  await m.ensure('sid');
  assert.equal(store.state.material.text, '旧卡', '关闭后不生成');
});
