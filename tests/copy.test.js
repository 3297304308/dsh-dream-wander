import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVisibility, retentionDays } from '../lib/copy.js';

test('normalizeVisibility：默认/补格/截断/吸附/单调', () => {
  assert.deepEqual(normalizeVisibility(undefined), [80, 40, 20, 0, 0]);
  assert.deepEqual(normalizeVisibility([]), [80, 40, 20, 0, 0]);
  assert.deepEqual(normalizeVisibility([80, 40]), [80, 40, 0, 0, 0]);
  assert.deepEqual(normalizeVisibility([1, 2, 3, 4, 5, 6]), [0, 0, 0, 0, 0]);
  assert.deepEqual(normalizeVisibility([85, 43, 21, 0, 0]), [90, 40, 20, 0, 0]);
  assert.deepEqual(normalizeVisibility([10, 40, 20, 0, 0]), [10, 10, 10, 0, 0]); // 单调不增
});

test('retentionDays：第一个 0 的格号；没有 0 则 5', () => {
  assert.equal(retentionDays([80, 40, 20, 0, 0]), 3);
  assert.equal(retentionDays([0, 0, 0, 0, 0]), 0);
  assert.equal(retentionDays([100, 100, 100, 100, 100]), 5);
});
