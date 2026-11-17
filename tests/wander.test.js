import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSimilarWander } from '../lib/wander.js';

test('走神复读判定：完全相同算重复', () => {
  const a = '好像整个人都软下去了，就那种被轻轻搂着的感觉，迷迷糊糊的。';
  assert.equal(isSimilarWander(a, a), true);
  assert.equal(isSimilarWander(a, a + '  '), true); // 空白差异也算
});

test('走神复读判定：改一两个字仍算重复（相似度放宽）', () => {
  const a = '好像整个人都软下去了，就那种被轻轻搂着的感觉，迷迷糊糊的。';
  const b = '好像整个人都软下去了，就那种被轻轻抱着的感觉，迷迷糊糊的。';
  assert.equal(isSimilarWander(a, b), true); // 0.85 口径（改一两个字算重复）
  assert.equal(isSimilarWander(a, b, 0.95), false); // 运行时默认 0.95：改一两个字不算重复
});

test('走神复读判定：完全不同不算重复', () => {
  assert.equal(isSimilarWander('窗外有只鸟叫了一声，阳光好像晃了一下。', '热乎乎的饭端上来，像谁在等你回家似的。'), false);
});

test('走神复读判定：阈值可调（1=只拦完全一样，0.5=更严格）', () => {
  const a = '好像整个人都软下去了，就那种被轻轻搂着的感觉，迷迷糊糊的。';
  const b = '好像整个人都软下去了，就那种被轻轻抱着的感觉，迷迷糊糊的。';
  assert.equal(isSimilarWander(a, b, 1), false); // 阈值 1 只拦完全一样
  assert.equal(isSimilarWander(a, b, 0.5), true);
});

test('走神复读判定：太短的句子不按相似度误杀', () => {
  assert.equal(isSimilarWander('有点困', '有点累'), false);
  assert.equal(isSimilarWander('有点困', '有点困'), true);
});
