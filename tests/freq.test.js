import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Freq, tokenize, FREQ_VERSION } from '../lib/freq.js';

const mkCfg = (over = {}) => ({ freq: { stopwords: [], names: [], pronouns: ['我', '你', '他', '她', '它'], ...over } });

test('FREQ_VERSION = 2', () => assert.equal(FREQ_VERSION, 2));

test('tokenize：中英混排、英文小写', () => {
  const w = tokenize('面试 Room 电脑');
  assert.ok(w.includes('面试') && w.includes('room') && w.includes('电脑'));
});

test('计数层：单字、停用词、时间词、二字虚词都不进池', () => {
  const f = new Freq(mkCfg());
  f.add('我 手 凉 下午 整个 一下 感觉 面试 杯子');
  assert.ok(!f.pool.has('我'), '单字不收');
  assert.ok(!f.pool.has('手'), '单字不收');
  assert.ok(!f.pool.has('下午'), '时间词不收');
  assert.ok(!f.pool.has('整个'), '二字虚词不收');
  assert.ok(f.pool.has('面试'), '实词收');
  assert.ok(f.pool.has('杯子'), '实词收');
});

test('双池：普通计入两池；care=false 只进素材池', () => {
  const f = new Freq(mkCfg());
  f.add('面试');
  assert.equal(f.pool.get('面试'), 1);
  assert.equal(f.care.get('面试'), 1);
  f.add('杯子', { care: false });
  assert.equal(f.pool.get('杯子'), 1);
  assert.equal(f.care.get('杯子') ?? 0, 0);
});

test('提示词词表只作用推理路径', () => {
  const f = new Freq(mkCfg());
  f.setPromptWords(['好像 联想 角度 发呆']);
  f.add('好像 联想 角度 发呆 面试', { reasoning: true });
  assert.ok(!f.pool.has('好像') && !f.pool.has('联想'), '推理路径剔除提示词回显');
  assert.ok(f.pool.has('面试'));
  f.add('发呆 面试');
  assert.ok(f.pool.has('发呆'), '普通路径不过滤');
});

test('过度在意：三条件（次数/占比/领先）', () => {
  const f = new Freq(mkCfg());
  // 场景：面试 12 次，其余词把它稀释到 4% 以上，top2=5
  for (let i = 0; i < 12; i++) f.add('面试');
  for (let i = 0; i < 5; i++) f.add('房间');
  const filler = '桌子 椅子 窗户 地板 门框 墙角 台灯 插座 书架 衣柜 窗帘 床单 毛巾 水杯 筷子 勺子 盘子 锅盖 冰箱 电扇 空调 遥控 手机 充电 拖鞋 袜子 外套 围巾 帽子 钥匙 枕头 被套 窗台 桌角 椅背 门口 楼道 阳台 厨房 卫生间'.split(' ');
  for (let i = 0; i < 10; i++) for (const w of filler) f.add(w); // 40 个常用词各 10 次稀释：总 ≈400，top=面试 12（≈3% ≤ 4%）
  assert.equal(f.overCare(10, 0, 0), true, '仅次数条件：触发');
  assert.equal(f.overCare(10, 0.04, 0), false, '占比条件：不通过');
  // 低稀释场景：面试 12 / 总 20，top2=5 → 领先 2.4×，占比 60%
  const g = new Freq(mkCfg());
  for (let i = 0; i < 12; i++) g.add('面试');
  for (let i = 0; i < 5; i++) g.add('房间');
  for (let i = 0; i < 3; i++) g.add('杯子');
  assert.equal(g.overCare(10, 0.04, 1.5), true, '三条件满足');
  // 第二名追平 → 领先不通过
  const h = new Freq(mkCfg());
  for (let i = 0; i < 12; i++) h.add('面试');
  for (let i = 0; i < 12; i++) h.add('房间');
  assert.equal(h.overCare(10, 0.04, 1.5), false, '领先条件不通过');
});

test('人称/称呼不进高频档（但仍计频）', () => {
  const f = new Freq(mkCfg({ names: ['主人'] }));
  for (let i = 0; i < 20; i++) f.add('主人');
  f.add('面试');
  assert.ok(!f.topHigh().includes('主人'), '称呼不进高频档');
  assert.equal(f.pool.get('主人'), 20, '称呼仍计频');
});

test('fromJSON：旧格式迁移后单字/停用词清 0；{pool,care} 格式读写一致', () => {
  const f = Freq.fromJSON({ 我: 100, 手: 50, 下午: 30, 面试: 5 }, mkCfg());
  assert.equal(f.pool.get('面试'), 5);
  assert.ok(!f.pool.has('我') && !f.pool.has('手') && !f.pool.has('下午'));
  assert.equal(f.care.get('面试'), 5, '旧格式在意池按全量初始化');
  const g = new Freq(mkCfg());
  g.add('面试');
  g.add('杯子', { care: false });
  const h = Freq.fromJSON(JSON.parse(JSON.stringify(g.toJSON())), mkCfg());
  assert.equal(h.pool.get('面试'), 1);
  assert.equal(h.care.get('杯子') ?? 0, 0);
});

test('drawWords：不抽单字/英文/含标点碎片', () => {
  const f = new Freq(mkCfg());
  for (let i = 0; i < 6; i++) f.add('面试 房间 杯子 下午 我 手 abc ！');
  const words = f.drawWords();
  for (const w of words) {
    assert.ok([...w].length >= 2, '无单字: ' + w);
    assert.ok(!/^[a-z]+$/i.test(w), '无英文: ' + w);
    assert.ok(!/[^\p{L}\p{N}]/u.test(w), '无标点碎片: ' + w);
  }
});

test('stats：双池计数', () => {
  const f = new Freq(mkCfg());
  f.add('面试');
  f.add('杯子', { care: false });
  const st = f.stats();
  assert.equal(st.pool, 2);
  assert.equal(st.care, 1);
});

test('valid/keep：英文/数字/混排碎片不进池', () => {
  const f = new Freq(mkCfg());
  f.add('room 3dm 13h 2026 面试');
  assert.ok(!f.pool.has('room') && !f.pool.has('3dm') && !f.pool.has('13h') && !f.pool.has('2026'));
  assert.ok(f.pool.has('面试'));
  assert.equal(Freq.valid('3dm'), false);
  assert.equal(Freq.valid('13h'), false);
  assert.equal(Freq.valid('3D打印'), true);
});

test('取词屏蔽表：只作用候选层（计数不变）', () => {
  const f = new Freq(mkCfg());
  // 池子：屏蔽词各 12 次 + 足够多的非屏蔽实词（避免池子太小触发 L109"同档无词则任取"回退）
  for (let i = 0; i < 12; i++) f.add('出去 吃了 旁边');
  for (const w of ['面试', '房间', '杯子', '窗台', '裂纹', '床沿']) f.add(w);
  assert.ok(f.pool.get('出去') >= 12, '计数照记');
  assert.ok(!f.topHigh().includes('出去') && !f.topHigh().includes('吃了'), '高频档不含屏蔽词');
  const words = f.drawWords();
  assert.ok(!words.includes('出去') && !words.includes('吃了') && !words.includes('旁边'), '取词不含屏蔽词');
});

test('撤销≥2：只出现 1 次的具体词可被抽到', () => {
  const f = new Freq(mkCfg());
  f.add('面试');
  const words = f.drawWords();
  assert.ok(words.includes('面试'), '1 次词可抽');
});

test('过度在意分母不变（屏蔽词仍计入分母）', () => {
  const f = new Freq(mkCfg());
  for (let i = 0; i < 12; i++) f.add('面试');
  for (let i = 0; i < 12; i++) f.add('觉得');
  const st = f.stats();
  assert.equal(st.careTotal, 24, '分母含屏蔽词');
  assert.equal(f.overCare(10, 0, 0), true);
});

test('过度在意灵敏度：三档映射（低/中/高）', () => {
  const f = new Freq(mkCfg());
  const base = (w) => { f.care.clear(); for (let i = 0; i < 12; i++) f.care.set(w, (f.care.get(w) ?? 0) + 1); };
  // 构造：top1=20 次、第二=10 次、总 200 → 占比 10%、领先 2.0
  f.care.clear();
  f.care.set('面试', 20); f.care.set('房间', 10);
  for (let i = 0; i < 170; i++) f.care.set('异' + i, 1);
  // 低敏感(share .06/lead 2.0)：占比 10%>6% ✓，领先 20≥2.0×10 ✓ → 触发
  assert.equal(f.overCare(10, 0.06, 2.0), true);
  // 高敏感(share .02/lead 1.2)：也触发
  assert.equal(f.overCare(10, 0.02, 1.2), true);
  // 第二追平至 15：领先 20 < 2.0×15 → 低敏感不触发
  f.care.set('房间', 15);
  assert.equal(f.overCare(10, 0.06, 2.0), false);
});

test('动态提示词词表：过滤只作用推理路径，且规模受上限', () => {
  const f = new Freq(mkCfg());
  f.setPromptWords(['好像 联想 角度 发呆 面试']);
  f.add('好像 联想 角度 发呆 面试', { reasoning: true });
  assert.ok(!f.pool.has('好像') && !f.pool.has('联想'), '推理路径剔除提示词');
  assert.ok(!f.pool.has('面试'), '词表里的实词在推理路径也被剔除（提示词回显）');
  f.add('好像 面试');
  assert.ok(f.pool.has('好像') && f.pool.has('面试'), '普通路径不过滤');
  // 规模上限：超 5000 词不会无限增长
  const big = Array.from({ length: 6000 }, (_, i) => '词' + i).join(' ');
  f.setPromptWords([big]);
  assert.ok(f.promptWords.size <= 5000, '词表上限 5000');
});

test('提示词回显过滤可关闭（promptExclude=false 时计入）', () => {
  const on = new Freq(mkCfg({ promptExclude: true }));
  on.setPromptWords(['好像 联想']);
  on.add('好像 联想', { reasoning: true });
  assert.equal(on.pool.size, 0, '开：提示词词被剔除');
  const off = new Freq(mkCfg({ promptExclude: false }));
  off.setPromptWords(['好像 联想']);
  off.add('好像 联想', { reasoning: true });
  assert.equal(off.pool.size, 2, '关：提示词词正常计入');
});
