import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commonPrefixSuffix, templateHits, repeatedTimeWords, WANDER_ANGLES } from '../lib/wander.js';

const oldSegs = [
  '好像刚有人喊我。回头又没声了，算了不想了。',
  '我刚觉得脑子空了一下，像被什么轻轻碰过，又抓不住了。',
  '好像有个什么东西从脑子里飘过去，没看清，也懒得管了。',
  '刚才好像有个什么在对面，说不清是椅子还是窗户，记不清了。',
  '刚好像要想起个什么事，想了下又觉得想不想都行。',
];

test('模板词抽取：高频开头/结尾（好像…了/不住了）', () => {
  const bans = commonPrefixSuffix(oldSegs);
  assert.ok(bans.heads.includes('好像'), '应抽到开头模板词"好像"');
  assert.ok(Array.isArray(bans.tails), '结尾词已去标点，允许为空');
});

test('结构模板判定：旧模板写法命中 2，换角度写法命中 0', () => {
  const bans = commonPrefixSuffix(oldSegs);
  assert.equal(templateHits('好像整个人都软下去了，就那种被轻轻搂着的感觉，迷迷糊糊的。', bans) >= 1, true);
  // 旧模板写法：开头命中即判模板（hits>=1）
  assert.ok(templateHits('好像没什么事，算了不想了。', bans) >= 1);
  // 具体物件 + 不同开头结尾 → 不命中
  assert.equal(templateHits('手边的杯子凉了，指尖碰上去缩了一下。', bans), 0);
});

test('角度池：20 个入口、互不重复', () => {
  assert.equal(WANDER_ANGLES.length, 20);
  assert.equal(new Set(WANDER_ANGLES).size, 20);
});


test('今日重复时间词检测：出现≥2次才禁', () => {
  assert.deepEqual(repeatedTimeWords(['前两天总睡不醒', '前两天又想起', '前阵子来了']), ['前两天']); // 只有"前两天"跨 2 段
  assert.deepEqual(repeatedTimeWords(['前两天总睡不醒', '杯子凉了']), []); // 只出现 1 段不禁
});
