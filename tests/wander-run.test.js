import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wander } from '../lib/wander.js';
import { DEFAULTS } from '../lib/config.js';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const mkCfg = (wander = {}, extra = {}) => {
  const cfg = structuredClone(DEFAULTS);
  cfg.wander = { ...cfg.wander, ...wander };
  cfg.retry = extra.retry ?? 2;
  if (extra.cycle) cfg.cycle = { ...cfg.cycle, ...extra.cycle };
  return cfg;
};

const mkStore = (dir, residue = null) => ({
  dir,
  state: { agents: {}, her: {} },
  logs: [],
  textCalls: [],
  _residue: residue,
  log(m) { this.logs.push(String(m)); },
  wanderPath(day) { return path.join(dir, '走神', `${day}.md`); },
  appendWander(day, text) {
    const p = this.wanderPath(day);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${text}\n\n`, 'utf8');
    this.state.wanderToday = (this.state.wanderToday ?? 0) + 1;
    this.textCalls.push(text);
  },
  latestResidue() { return this._residue; },
  agent(id) { this.state.agents[id] = this.state.agents[id] ?? { lastActivity: Date.now() }; return this.state.agents[id]; },
  save() {},
  saveHer() {},
  her() { this.state.her = this.state.her ?? {}; return this.state.her; },
});

// 假 ctx：按序列返回生成文本；reasoning 可选；null=error finish
const mkCtx = (texts, { reasoning = '随便想想' } = {}) => {
  let i = 0;
  const ctx = {
    lastOpts: null,
    agents: { get: () => null, withInitiator: (_a, fn) => fn() },
    llm: {
      stream: async function* (opts) {
        ctx.lastOpts = opts;
        const t = texts[Math.min(i, texts.length - 1)];
        i++;
        if (t === null) { yield { type: 'finish', reason: { kind: 'error' } }; return; }
        if (reasoning) yield { type: 'reasoning-delta', text: reasoning };
        yield { type: 'text-delta', text: t };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };
  return ctx;
};

const mkFreq = () => { const calls = []; const add = (t) => calls.push(t); return { calls, add }; };

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dw-wander-'));

test('概率 p=0：不触发、不写文档', async () => {
  const dir = mkTmp();
  const store = mkStore(dir);
  const w = new Wander(mkCtx(['不该出现']), store, mkCfg({ p: 0 }));
  const ok = await w.maybeWander('a', '独处');
  assert.equal(ok, false);
  assert.deepEqual(store.textCalls, []);
  assert.ok(store.logs.some((l) => l.includes('未触发')));
});

test('概率 p=1：触发并写文档（text 截断到 max）', async () => {
  const dir = mkTmp();
  const store = mkStore(dir);
  const w = new Wander(mkCtx(['好像有点困，想趴一会儿，窗外好像有风。']), store, mkCfg({ p: 1, max: 10 }));
  const ok = await w.maybeWander('a', '独处');
  assert.equal(ok, true);
  assert.equal(store.textCalls.length, 1);
  assert.equal([...store.textCalls[0]].length, 10); // 截断
  const f = fs.readFileSync(store.wanderPath(today()), 'utf8');
  assert.ok(f.endsWith('\n\n'));
});

test('复读：生成相同 → 重试拿到不同内容 → 写新的', async () => {
  const dir = mkTmp();
  const store = mkStore(dir);
  const same = '好像整个人都软下去了，就那种被轻轻搂着的感觉，迷迷糊糊的。';
  const other = '窗台落了一层灰，太阳晒着，忽然有点想出去走走。';
  fs.mkdirSync(path.join(dir, '走神'), { recursive: true });
  fs.writeFileSync(store.wanderPath(today()), same + '\n\n', 'utf8');
  const w = new Wander(mkCtx([same, other]), store, mkCfg({ p: 1 }));
  const ok = await w.maybeWander('a', '独处');
  assert.equal(ok, true);
  assert.ok(store.textCalls.includes(other));
  assert.ok(!store.textCalls.includes(same));
  assert.ok(store.logs.some((l) => l.includes('重复')));
});

test('复读重试耗尽：放弃、不写文档、不加词频', async () => {
  const dir = mkTmp();
  const store = mkStore(dir);
  const same = '好像整个人都软下去了，就那种被轻轻搂着的感觉，迷迷糊糊的。';
  fs.mkdirSync(path.join(dir, '走神'), { recursive: true });
  fs.writeFileSync(store.wanderPath(today()), same + '\n\n', 'utf8');
  const w = new Wander(mkCtx([same, same, same]), store, mkCfg({ p: 1 }, { retry: 1 }));
  const freq = mkFreq();
  w._addFreq = freq.add;
  const ok = await w.maybeWander('a', '独处');
  assert.equal(ok, false);
  assert.equal(store.textCalls.length, 0); // 预写的文档不经过 appendWander
  assert.deepEqual(freq.calls, []);
  assert.ok(store.logs.some((l) => l.includes('仍与今天已写的重复')));
});

test('系统腔产物：重试后放弃', async () => {
  const dir = mkTmp();
  const store = mkStore(dir);
  const w = new Wander(mkCtx(['模型说这像提示词 token', '模型又说参数 JSON']), store, mkCfg({ p: 1 }, { retry: 1 }));
  const ok = await w.maybeWander('a', '独处');
  assert.equal(ok, false);
  assert.deepEqual(store.textCalls, []);
  assert.ok(store.logs.some((l) => l.includes('系统腔')));
});

test('词频回流：有 reasoning → reasoning+产物；无 reasoning → 产物双计', async () => {
  const dir = mkTmp();
  const store = mkStore(dir);
  const w = new Wander(mkCtx(['有点走神。'], { reasoning: '想到了午饭' }), store, mkCfg({ p: 1 }));
  const freq = mkFreq();
  w._addFreq = freq.add;
  await w.maybeWander('a', '独处');
  assert.deepEqual(freq.calls, ['想到了午饭', '有点走神。']);

  const dir2 = mkTmp();
  const store2 = mkStore(dir2);
  const w2 = new Wander(mkCtx(['又走神了。'], { reasoning: '' }), store2, mkCfg({ p: 1 }));
  const freq2 = mkFreq();
  w2._addFreq = freq2.add;
  await w2.maybeWander('b', '独处');
  assert.deepEqual(freq2.calls, ['又走神了。', '又走神了。']);
});

test('残留带入：prompt 含残影、方块转省略号', async () => {
  const dir = mkTmp();
  const store = mkStore(dir, '梦（natural）\n词：风\n记得最深的一句：也许只是停□□一小会');
  const ctx = mkCtx(['风吹过。']);
  const w = new Wander(ctx, store, mkCfg({ p: 1 }, { cycle: { residueP: 1 } }));
  await w.maybeWander('a', '独处');
  const prompt = ctx.lastOpts.messages[0].content[0].text;
  assert.ok(prompt.includes('残影'));
  assert.ok(prompt.includes('…'));
  assert.ok(!prompt.includes('□'));
});

test('dupThreshold=1：改一两个字不拦；0.5：拦', async () => {
  const a = '好像整个人都软下去了，就那种被轻轻搂着的感觉，迷迷糊糊的。';
  const b = '好像整个人都软下去了，就那种被轻轻抱着的感觉，迷迷糊糊的。';

  const dir = mkTmp();
  const store = mkStore(dir);
  fs.mkdirSync(path.join(dir, '走神'), { recursive: true });
  fs.writeFileSync(store.wanderPath(today()), a + '\n\n', 'utf8');
  const w = new Wander(mkCtx([b]), store, mkCfg({ p: 1, dupThreshold: 1 }));
  const ok = await w.maybeWander('a', '独处');
  assert.equal(ok, true); // 阈值 1 只拦完全一样 → 改字放行

  const dir2 = mkTmp();
  const store2 = mkStore(dir2);
  fs.mkdirSync(path.join(dir2, '走神'), { recursive: true });
  fs.writeFileSync(store2.wanderPath(today()), a + '\n\n', 'utf8');
  const w2 = new Wander(mkCtx([b, b, b]), store2, mkCfg({ p: 1, dupThreshold: 0.5 }, { retry: 1 }));
  const ok2 = await w2.maybeWander('a', '独处');
  assert.equal(ok2, false); // 阈值 0.5 更严格 → 拦掉并放弃
  assert.equal(store2.textCalls.length, 0);
});

test('dispose 后不再生成/写文档', async () => {
  const dir = mkTmp();
  const store = mkStore(dir);
  const w = new Wander(mkCtx(['不该写。']), store, mkCfg({ p: 1 }));
  w.dispose();
  const ok = await w.maybeWander('a', '独处');
  assert.equal(ok, false);
  assert.deepEqual(store.textCalls, []);
});

test('并发双触发：第二个被门闩跳过、只写一段（P1-1 回归）', async () => {
  const dir = mkTmp();
  const store = mkStore(dir);
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = {
    agents: { get: () => null, withInitiator: (_a, fn) => fn() },
    llm: {
      stream: async function* () {
        await gate; // 卡住第一个生成，模拟"还在生成"状态
        yield { type: 'text-delta', text: '窗外的风有点凉。' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };
  const w = new Wander(ctx, store, mkCfg({ p: 1 }));
  const first = w.maybeWander('a', '独处');
  await new Promise((r) => setTimeout(r, 20)); // 让第一个进入生成
  const secondOk = await w.maybeWander('a', '休眠');
  assert.equal(secondOk, false);
  assert.ok(store.logs.some((l) => l.includes('上一轮生成中')));
  release();
  assert.equal(await first, true);
  assert.equal(store.textCalls.length, 1); // 只写一段
});
