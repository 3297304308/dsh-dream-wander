import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wanderTimeOk, inWanderWindow } from '../lib/clock.js';

const at = (h, m = 0) => new Date(2026, 10, 17, h, m).getTime();

test('普通窗口 8-20：含起点、不含终点', () => {
  const w = { window: [8, 20] };
  assert.equal(inWanderWindow(w, at(7, 59)), false);
  assert.equal(inWanderWindow(w, at(8, 0)), true);
  assert.equal(inWanderWindow(w, at(19, 59)), true);
  assert.equal(inWanderWindow(w, at(20, 0)), false);
});

test('untilSleep + 普通窗口：8 点后放行（凌晨 0-8 不算）', () => {
  const w = { window: [8, 20], untilSleep: true };
  assert.equal(wanderTimeOk(w, at(7, 59)), false);
  assert.equal(wanderTimeOk(w, at(8, 0)), true);
  assert.equal(wanderTimeOk(w, at(22, 0)), true);
  assert.equal(wanderTimeOk(w, at(23, 59)), true);
});

test('跨零点窗口 22-06：原窗口判定', () => {
  const w = { window: [22, 6] };
  assert.equal(inWanderWindow(w, at(21, 59)), false);
  assert.equal(inWanderWindow(w, at(22, 0)), true);
  assert.equal(inWanderWindow(w, at(5, 59)), true);
  assert.equal(inWanderWindow(w, at(6, 0)), false);
  assert.equal(inWanderWindow(w, at(12, 0)), false);
});

test('跨零点 + untilSleep：按"起点到次日终点前"，白天不放行（P1-2 回归）', () => {
  const w = { window: [22, 6], untilSleep: true };
  assert.equal(wanderTimeOk(w, at(12, 0)), false); // 旧实现这里会 true（全天放行）
  assert.equal(wanderTimeOk(w, at(22, 0)), true);
  assert.equal(wanderTimeOk(w, at(23, 30)), true);
  assert.equal(wanderTimeOk(w, at(5, 59)), true);
  assert.equal(wanderTimeOk(w, at(6, 0)), false);
});

test('窗口起止相同：视为无效窗口（不触发）', () => {
  assert.equal(wanderTimeOk({ window: [8, 8], untilSleep: true }, at(12)), false);
  assert.equal(inWanderWindow({ window: [8, 8] }, at(12)), false);
});
