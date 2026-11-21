// 面板渲染冒烟测试（正式版）：加载真实 lib/client.js，以宿主 GET /api/dream-wander/config
// 的 payload 形态驱动一次真实的数据加载 + 渲染，防"语法合法但运行期抛错"的面板 P0
// （例：在工厂作用域引用组件内 config 导致整页 ReferenceError；条件隐藏写成空控件行；
// 字符串直接拼接 React 元素导致渲染出 [object Object]）。
//
// 实现方式：VM 里执行真实 bundle → 拿 __ModuleLoader__ 的 factory → 用最小 React 桩调用
// 设置页组件 → 跑 useEffect（真实走 apiGet/loadView 的 fetch 链）→ 等 setState 后重渲染。
// 不依赖真实 DSH 进程/网络（fetch 由测试桩提供），可在 CI 跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DEFAULTS } from '../lib/config.js';

const CLIENT_SRC = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const BUILD_TAG = (CLIENT_SRC.match(/BUILD_TAG = '([^']+)'/) || [])[1] || 'test-build';

// ---------------------------------------------------------------------------
// 最小 React 桩：hooks 顺序稳定即可（本 bundle 只用 useState/useEffect；
// useMemo/useCallback/useRef 一并提供，防以后加 hook 时测试直接炸）。
// ---------------------------------------------------------------------------
function makeReact() {
  let states = [];
  let idx = 0;
  let dirty = false;
  const effects = [];
  const ranEmptyDeps = new Set();

  return {
    createElement: (type, props, ...children) => {
      const p = Object.assign({}, props || {});
      if (children.length > 0) p.children = children.length === 1 ? children[0] : children;
      return { __el: true, type, props: p, children };
    },
    useState: (init) => {
      const i = idx++;
      if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
      const set = (v) => {
        const next = typeof v === 'function' ? v(states[i]) : v;
        if (next !== states[i]) dirty = true;
        states[i] = next;
      };
      return [states[i], set];
    },
    useEffect: (fn, deps) => {
      const i = idx++;
      if (Array.isArray(deps) && deps.length === 0) {
        if (!ranEmptyDeps.has(i)) { ranEmptyDeps.add(i); effects.push(fn); }
      } else if (!Array.isArray(deps)) {
        effects.push(fn); // 无依赖数组：每次渲染后都跑（本 bundle 未用，保底）
      }
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
    // —— 测试驱动用 ——
    beginRender() { idx = 0; dirty = false; },
    isDirty() { return dirty; },
    takeEffects() { return effects.splice(0); },
  };
}

// ---------------------------------------------------------------------------
// 在 VM 里加载真实 bundle，返回 factory（此时还没执行插件 apply）。
// ---------------------------------------------------------------------------
function loadBundle() {
  let loader = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (o) => { loader = o; } } },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, id: '', textContent: '' }),
      head: { appendChild: () => {} },
      body: { appendChild: () => {} },
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SRC, sandbox, { filename: 'lib/client.js' });
  assert.ok(loader && typeof loader.factory === 'function', 'client bundle 没有通过 window.__ModuleLoader__.load 注册 factory');
  return { sandbox, loader };
}

// ---------------------------------------------------------------------------
// 宿主 GET /api/dream-wander/config 的 payload 形态（字段名/层级与真实响应一致；
// defaults 取实现层的 DEFAULTS，避免与 lib/config.js 漂移）。
// ---------------------------------------------------------------------------
function mkConfigPayload(sensitivity) {
  const defaults = JSON.parse(JSON.stringify(DEFAULTS));
  const now = Date.now();
  return {
    ok: true,
    inherited: { dreamEnabled: false, wanderEnabled: false, scope: [] },
    override: {
      dreamEnabled: true,
      wanderEnabled: true,
      scope: ['session-test'],
      wander: { overCareSensitivity: sensitivity },
    },
    defaults,
    entryId: 'include:dream-wander',
    bridge: { available: false, dir: '', sessions: [], keys: {} },
    sessions: {
      workspaces: [
        {
          id: 'ws-test', title: '测试工作区', path: 'E:/test',
          sessions: [{ id: 'session-test', mtime: now - 60_000 }],
        },
      ],
      error: '',
    },
    lastError: '',
    applyStatus: { status: 'ok', pid: 1, ts: now, hostname: 'test-host', bootedAt: now - 60_000 },
    warnings: [],
    health: {
      material: { day: '2026-11-21', status: 'raw', reason: '', len: 0 },
      applyAt: now - 60_000,
      uptimeMs: 60_000,
      pid: 1,
      lastTickAt: now,
      status: 'awake',
      hitAt: null,
      remaining: 1,
      usedCount: 0,
      allocDay: '2026-11-21',
      freqPool: 10,
      freqCare: { pool: 10, care: 8, pickable: 5, poolTotal: 20, careTotal: 16 },
      wanderToday: 2,
      todayCopies: 0,
      signal: {
        polling: false, intervalMs: null, lastSeq: 0, failCount: 0,
        lastPollAt: null, lastPollOk: null, lastPollError: '',
        lastSignalAt: null, lastRollbackAt: null, lastRollbackCount: 0,
      },
      inject: { normCount: 7, changesSinceNorm: 0, lastNormAt: null, lastChangeAt: null },
      dream: {
        status: 'awake', hitAt: null, remaining: 1, usedCount: 0, allocDay: '2026-11-21',
        dreamAt: null, dreamHalfN: null, dreamReleasedChars: null, dreamStartAt: null, lastFinish: null,
      },
      recentErrors: [],
    },
    clientBuild: BUILD_TAG,
    copyKeepDays: 3,
  };
}

function mkViewPayload() {
  return {
    ok: true,
    dataDir: 'C:/test/dream-wander-data',
    wander: ['第一段走神。', '第二段走神。'],
    residue: null,
    copies: [],
    frame: null,
    dreaming: null,
    enabled: { dream: true, wander: true, scope: 1 },
  };
}

// ---------------------------------------------------------------------------
// 把元素树展开成：可读文本 + 所有字段行的 path/是否有控件（Row 的 props.path 是行标记）。
// 函数组件就地展开（Row 的 label/hint 就是这样才进文本）。
// ---------------------------------------------------------------------------
function collect(root) {
  const out = { text: [], rows: [] };
  const walk = (node) => {
    if (node === null || node === undefined || node === false || node === true) return;
    if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    const props = node.props || {};
    if (typeof props.path === 'string') {
      const control = node.children && node.children[0];
      out.rows.push({ path: props.path, hasControl: control !== null && control !== undefined });
    }
    if (typeof node.type === 'function') { walk(node.type(props)); return; }
    (node.children || []).forEach(walk);
  };
  walk(root);
  return { text: out.text.join('\n'), rows: out.rows };
}

// ---------------------------------------------------------------------------
// 挂载：mock 宿主 ctx —— effect(fn,name) 立即执行 fn；slots.inject(name,factory) 调 factory；
// slots.register(opts,render) 返回 render（与真实 client.js 的 apply 用法一致）。
// ---------------------------------------------------------------------------
function mount(payloads) {
  const React = makeReact();
  const { sandbox, loader } = loadBundle();
  sandbox.fetch = (url) => Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(String(url).indexOf('/view') >= 0 ? payloads.view : payloads.config)),
  });
  const mod = loader.factory((name) => {
    if (name === 'react') return React;
    throw new Error('client bundle 意外的 require: ' + name);
  });

  let Section = null;
  const hostCtx = {
    effect: (fn) => { fn(); return () => {}; },
    slots: {
      inject: (name, factory) => {
        if (name !== 'settings.section') return () => {};
        const render = factory(); // client.js: inject 的回调返回 slots.register(...) 的返回值
        const el = typeof render === 'function' ? render() : render;
        Section = el && el.type;
        return () => {};
      },
      register: (opts, render) => render,
    },
  };
  mod.apply(hostCtx);
  assert.equal(typeof Section, 'function', 'settings.section 没有注册出组件');
  return { React, Section };
}

// ---------------------------------------------------------------------------
// 渲染：跑组件 → 展开文本 → 执行 effect（fetch 链）→ 若有 setState 则重渲染，最多 8 轮。
// ---------------------------------------------------------------------------
async function renderPanel(payloads) {
  const { React, Section } = mount(payloads);
  for (let round = 0; round < 8; round += 1) {
    React.beginRender();
    const tree = Section({});
    const out = collect(tree);
    for (const fn of React.takeEffects()) fn();
    // fetch/then 都在微任务里；等一个宏任务即可全部结算
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!React.isDirty()) return out;
  }
  throw new Error('面板渲染未收敛（effect/setState 桩没驱动起来？）');
}

const payloadFor = (sensitivity) => ({ config: mkConfigPayload(sensitivity), view: mkViewPayload() });

// ===========================================================================
// 断言
// ===========================================================================

test('client 渲染冒烟：真实 payload 加载后渲染不抛错，且含标题「走神与做梦」', async () => {
  const { text, rows } = await renderPanel(payloadFor('mid'));
  assert.ok(text.includes('走神与做梦'), '渲染文本缺少标题「走神与做梦」');
  assert.ok(!text.includes('读取中…'), '渲染卡在「读取中…」（effect/setState 没跑通）');
  assert.ok(rows.length > 40, `字段行太少（${rows.length}），疑似渲染中断`);
});

test('client 渲染冒烟：mid 灵敏度下「过度在意占比阈值/领先倍数」两行整行隐藏', async () => {
  const { text, rows } = await renderPanel(payloadFor('mid'));
  assert.ok(text.includes('过度在意灵敏度'), 'mid 下应保留「过度在意灵敏度」控件行');
  assert.ok(!text.includes('过度在意占比阈值'), 'mid 下不应渲染「过度在意占比阈值」整行（含 label/hint）');
  assert.ok(!text.includes('过度在意领先倍数'), 'mid 下不应渲染「过度在意领先倍数」整行（含 label/hint）');
  assert.ok(!rows.some((r) => r.path === 'wander.overCareShare'), 'mid 下 overCareShare 行元素仍存在（不是整行隐藏）');
  assert.ok(!rows.some((r) => r.path === 'wander.overCareLead'), 'mid 下 overCareLead 行元素仍存在（不是整行隐藏）');
});

test('client 渲染冒烟：custom 灵敏度下两行出现且带控件', async () => {
  const { text, rows } = await renderPanel(payloadFor('custom'));
  assert.ok(text.includes('过度在意占比阈值'), 'custom 下缺少「过度在意占比阈值」行');
  assert.ok(text.includes('过度在意领先倍数'), 'custom 下缺少「过度在意领先倍数」行');
  for (const p of ['wander.overCareShare', 'wander.overCareLead']) {
    const row = rows.find((r) => r.path === p);
    assert.ok(row, `custom 下缺少字段行 ${p}`);
    assert.ok(row.hasControl, `custom 下 ${p} 行没有控件`);
  }
});

test('client 渲染冒烟：渲染文本不含 [object Object]（字符串误拼 React 元素）', async () => {
  const { text } = await renderPanel(payloadFor('mid'));
  const bad = text.split('\n').filter((line) => line.includes('[object Object]'));
  assert.deepEqual(bad, [], '渲染出现 [object Object]：' + JSON.stringify(bad));
});

test('client 渲染冒烟：其余字段行正常（无空控件行、素材卡三控件在、无废弃字段泄漏）', async () => {
  const { text, rows } = await renderPanel(payloadFor('mid'));
  assert.deepEqual(rows.filter((r) => !r.hasControl).map((r) => r.path), [], '存在有标题但没有控件的空行');
  const paths = rows.map((r) => r.path);
  for (const p of ['wander.material.enabled', 'wander.material.days', 'wander.material.form']) {
    assert.ok(paths.includes(p), `素材卡展开缺少 ${p}`);
  }
  for (const dead of ['judge.kMin', 'judge.intervalMin', 'play.releaseMinutes', 'interrupt.count', 'actJump.chainP', 'copy.keepDays', 'mood.scale']) {
    assert.ok(!paths.includes(dead), `废弃字段 ${dead} 出现在面板里`);
  }
  assert.ok(text.includes('最近巡检：'), '运行状态缺少「最近巡检」心跳行');
  assert.equal((text.match(/词池 /g) || []).length, 1, '「词池」行应只有一条（双词池行已合并）');
});
