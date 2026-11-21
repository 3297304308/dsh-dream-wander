// interrupt.js 关键路径单测：信号分类 + 三档敏感度分流 + 抖动 + 累计计数 + 代发/变形素材。
// 纯内存 fixture（fake store/cfg），不联网、不碰桥接、不读真实数据。
//
// 落库位置：插件目录/tests/interrupt.test.js；相对导入 ../lib/interrupt.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interrupt } from '../lib/interrupt.js';

function makeIntr(over = {}) {
  const cfg = {
    interrupt: {
      sensitivity: 'mid',
      weakPool: ['（呼噜噜......）'],
      midPool: ['（唔...）'],
      fullName: '',
      missP: 0,
      startleP: 0,
      ...over,
    },
  };
  return new Interrupt({ log() {} }, cfg);
}

const st = () => ({});

test('classifyMessage：拍一拍只认 targetIsSelf；私聊/引用/称呼/@ 分流', () => {
  const intr = makeIntr({ fullName: '小助手' });
  assert.equal(intr.classifyMessage({ kind: 'poke', poke: { targetIsSelf: true } }, 'group:1'), 'poke');
  assert.equal(intr.classifyMessage({ kind: 'poke', poke: { targetIsSelf: false } }, 'group:1'), 'group');
  assert.equal(intr.classifyMessage({ plain: '随便' }, 'private:42'), 'private', '私聊 key 直接 private');
  assert.equal(intr.classifyMessage({ plain: '随便', quoteTargetIsSelf: true }, 'group:1'), 'name', '引用角色=点名');
  assert.equal(intr.classifyMessage({ plain: '@小助手 在吗' }, 'group:1'), 'at', '@+完整称呼=被@');
  assert.equal(intr.classifyMessage({ plain: '小助手在吗' }, 'group:1'), 'name', '含完整称呼无@=点名');
  assert.equal(intr.classifyMessage({ plain: '大家好' }, 'group:1'), 'group');
});

test('classify：桥接唤醒文本的 reason 解析 + 旧版兜底', () => {
  const intr = makeIntr({ fullName: '小助手' });
  assert.equal(intr.classify('原因：有人拍了一拍'), 'poke');
  assert.equal(intr.classify('原因：atMention@seq3'), 'at');
  assert.equal(intr.classify('原因：nameMention@seq7'), 'name');
  assert.equal(intr.classify('原因：private'), 'private');
  assert.equal(intr.classify('原因：keyword:你好'), 'group');
  assert.equal(intr.classify('有人拍了拍你'), 'poke', '旧版无 reason 的文本兜底');
  assert.equal(intr.classify('小助手在吗'), 'name', '无 reason 时按完整称呼兜底');
  assert.equal(intr.classify('随便一句话'), 'other');
  assert.equal(makeIntr().classify('小助手在吗'), 'other', '未配置完整称呼时不做点名文本判定');
});

test('强档：群聊普通消息忽略；拍/@/点名/私聊一次即断', () => {
  const intr = makeIntr({ sensitivity: 'strong' });
  assert.equal(intr.handleDreamSignal(st(), '', false, 'group', '').action, 'ignore');
  for (const type of ['poke', 'at', 'name', 'private']) {
    const s = st();
    const r = intr.handleDreamSignal(s, '', false, type, '');
    assert.equal(r.action, 'interrupt', '强档 ' + type + ' 立即中断');
    assert.equal(s.interruptCount, undefined, '立即中断不累计计数');
  }
});

test('中档：点名/私聊立即断；拍/@/群聊先累计、第 2 次断并清计数', () => {
  const intr = makeIntr({ sensitivity: 'mid' });
  assert.equal(intr.handleDreamSignal(st(), '', false, 'name', '').action, 'interrupt');
  assert.equal(intr.handleDreamSignal(st(), '', false, 'private', '').action, 'interrupt');

  const s = st();
  const r1 = intr.handleDreamSignal(s, '', false, 'poke', '');
  assert.equal(r1.action, 'continue');
  assert.equal(r1.counting, true);
  assert.equal(r1.groggy, '（唔...）', '第 1 次从 midPool 代发迷糊语');
  assert.ok(r1.shape && r1.shape.includes('碰'), '拍一拍进变形素材');
  assert.equal(s.interruptCount, 1);
  const r2 = intr.handleDreamSignal(s, '', false, 'poke', '');
  assert.equal(r2.action, 'interrupt');
  assert.equal(s.interruptCount, 0, '断梦后计数清零');

  // 群聊在中档同样累计、但不变形
  const g = st();
  const gr = intr.handleDreamSignal(g, '', false, 'group', '');
  assert.equal(gr.action, 'continue');
  assert.equal(gr.shape, null, '群聊不进变形素材');
  assert.equal(g.interruptCount, 1);
});

test('弱档：所有信号共用累计计数，第 1 次哼唧、第 2 次断', () => {
  const intr = makeIntr({ sensitivity: 'weak' });
  const s = st();
  const r1 = intr.handleDreamSignal(s, '', false, 'group', '');
  assert.equal(r1.action, 'continue');
  assert.equal(r1.groggy, '（呼噜噜......）', '弱档从 weakPool 代发');
  assert.equal(s.interruptCount, 1);
  const r2 = intr.handleDreamSignal(s, '', false, 'group', '');
  assert.equal(r2.action, 'interrupt');
  assert.equal(s.interruptCount, 0);
});

test('抖动：没听见=不计数不哼唧；惊跳=立即中断（仅对进入计数的信号）', () => {
  const miss = makeIntr({ missP: 1 });
  const s1 = st();
  assert.equal(miss.handleDreamSignal(s1, '', false, 'poke', '').action, 'ignore');
  assert.equal(s1.interruptCount, undefined, '没听见不计数');

  const startle = makeIntr({ missP: 0, startleP: 1 });
  const s2 = st();
  assert.equal(startle.handleDreamSignal(s2, '', false, 'poke', '').action, 'interrupt');
  assert.equal(s2.interruptCount, undefined, '惊跳先于计数');

  // 立即中断的信号不掷抖动：强档开局即断
  const strong = makeIntr({ sensitivity: 'strong', missP: 1 });
  assert.equal(strong.handleDreamSignal(st(), '', false, 'name', '').action, 'interrupt');
});

test('变形素材：剔除桥接模板行，只留可信原声；无原声时只给类型化描述', () => {
  const intr = makeIntr();
  const r = intr.handleDreamSignal(
    st(),
    '【唤醒】\n你有新消息\n原因：atMention@seq9\n------\n外面有人喊我',
    false,
    'poke',
    '【唤醒】\n你有新消息\n原因：atMention@seq9\n------\n外面有人喊我',
  );
  assert.equal(r.action, 'continue');
  assert.ok(r.shape.includes('外面有人喊我'), '保留真实原声');
  assert.ok(!/【|原因[:：]|你有新消息|-{3,}/.test(r.shape), '模板行不进入变形素材');
  assert.ok([...r.shape].length <= 40, '变形素材限长');

  const bare = intr.handleDreamSignal(st(), '', false, 'at', '');
  assert.equal(bare.action, 'continue');
  assert.ok(bare.shape.includes('叫我的名字'), '无原声时按类型给描述');
});

test('presetType 优先于文本分类；clearCount 清计数', () => {
  const intr = makeIntr();
  assert.equal(intr.handleDreamSignal(st(), '随便文本', false, 'private', '').action, 'interrupt');
  const s = st();
  s.interruptCount = 1;
  intr.clearCount(s);
  assert.equal('interruptCount' in s, false);
});
