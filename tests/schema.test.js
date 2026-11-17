import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../lib/schema.js';

test('配置 schema 默认值：出厂静默、作用域空', () => {
  const cfg = Config({});
  assert.equal(cfg.dreamEnabled, false);
  assert.equal(cfg.wanderEnabled, false);
  assert.deepEqual(cfg.scope, []);
  assert.equal(cfg.wander.untilSleep, true); // 作者定：默认放宽至入睡前
  assert.equal(cfg.wander.dupThreshold, 0.95); // 作者定：默认 0.95
});

test('配置 schema 默认值：判定/演出/残留关键项', () => {
  const cfg = Config({});
  assert.equal(cfg.judge.confirmH, 1); // 作者定：默认 1 小时
  assert.equal(cfg.judge.windowH, 6);
  assert.equal(cfg.judge.dreamsPerDay, 1);
  assert.equal(cfg.judge.hitP, 0.5);
  assert.deepEqual(cfg.play.halfChars, [100, 200]);
  assert.equal(cfg.play.maxDurationMin, 90); // 作者定：默认 90
  assert.equal(cfg.residue.form, 'blur'); // 作者定：默认打码梦文本
  assert.deepEqual(cfg.residue.visibility, [50, 30, 10, 0, 0]);
  assert.deepEqual(cfg.copy.visibility, [80, 40, 20, 0, 0]);
});

test('配置 schema 拒绝越界值', () => {
  assert.throws(() => Config({ judge: { hitP: 2 } }), /range|max|expected/i);
  assert.throws(() => Config({ wander: { p: -1 } }), /range|min|expected/i);
});
