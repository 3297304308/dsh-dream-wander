import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, mergeConfig, roundProbs, clampCounts } from '../lib/config.js';

test('mergeConfig：默认值 + 深合并 + 数组整体覆盖', () => {
  const cfg = mergeConfig({ judge: { hitP: 0.8 }, scope: ['a'] });
  assert.equal(cfg.judge.hitP, 0.8);
  assert.equal(cfg.judge.windowH, DEFAULTS.judge.windowH);
  assert.deepEqual(cfg.scope, ['a']);
  const empty = mergeConfig({ scope: [] });
  assert.deepEqual(empty.scope, []); // 空数组也要能覆盖
  assert.notDeepEqual(cfg, DEFAULTS); // 不污染默认值
});

test('roundProbs：钳制 0-1、不取整', () => {
  const cfg = roundProbs(mergeConfig({ wander: { p: 1.5 }, interrupt: { missP: -0.2, startleP: 0.05 } }));
  assert.equal(cfg.wander.p, 1);
  assert.equal(cfg.interrupt.missP, 0);
  assert.equal(cfg.interrupt.startleP, 0.05); // 小数值保留
});

test('clampCounts：次数/阈值/重试钳制', () => {
  const cfg = clampCounts(mergeConfig({ judge: { dreamsPerDay: -1 }, wander: { threshold: 0, factor: 0 }, retry: -1 }));
  assert.equal(cfg.judge.dreamsPerDay, 0);
  assert.equal(cfg.wander.threshold, 1);
  assert.equal(cfg.wander.factor, 1);
  assert.equal(cfg.retry, 0);
});

test('clampCounts：confirmH 分段档位吸附', () => {
  const pick = (v) => clampCounts(mergeConfig({ judge: { confirmH: v } })).judge.confirmH;
  assert.equal(pick(2.4), 2.5);
  assert.equal(pick(2.24), 2);
  assert.equal(pick(0.34), 0.3);
  assert.equal(pick(3.7), 4);
  assert.equal(pick(99), 5);
});

test('clampCounts：windowH 整数 1-24、lambdaRatio ≥1', () => {
  assert.equal(clampCounts(mergeConfig({ judge: { windowH: 99 } })).judge.windowH, 24);
  assert.equal(clampCounts(mergeConfig({ judge: { windowH: 0 } })).judge.windowH, 1);
  assert.equal(clampCounts(mergeConfig({ judge: { lambdaRatio: 3.7 } })).judge.lambdaRatio, 4);
});

test('clampCounts：可见序列归一化与单调、档位边界单调', () => {
  const cfg = clampCounts(mergeConfig({ copy: { visibility: [80, 40, 20, 5, 5] }, residue: { tiers: [50, 40, 200, 300] } }));
  assert.deepEqual(cfg.copy.visibility, [80, 40, 20, 10, 10]);
  assert.deepEqual(cfg.residue.tiers, [50, 50, 200, 300]);
});

test('roundProbs：复读阈值钳制 0-1', () => {
  const pick = (v) => roundProbs(mergeConfig({ wander: { dupThreshold: v } })).wander.dupThreshold;
  assert.equal(pick(1.5), 1);
  assert.equal(pick(-0.2), 0);
  assert.equal(pick(0.7), 0.7);
});

test('clampCounts：轮询间隔 2 项整数 1-10 且 min ≤ max', () => {
  const cfg = clampCounts(mergeConfig({ signal: { pollIntervalSec: [0, 99] } }));
  assert.deepEqual(cfg.signal.pollIntervalSec, [1, 10]);
  const cfg2 = clampCounts(mergeConfig({ signal: { pollIntervalSec: [5, 2] } }));
  assert.deepEqual(cfg2.signal.pollIntervalSec, [5, 5]);
});
