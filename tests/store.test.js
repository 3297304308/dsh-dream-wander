import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, localDay } from '../lib/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dw-store-'));

test('Store：构造建目录、空状态默认值', () => {
  const dir = tmp();
  const s = new Store(dir);
  assert.ok(fs.existsSync(path.join(dir, '走神')));
  assert.ok(fs.existsSync(path.join(dir, '残留')));
  assert.ok(fs.existsSync(path.join(dir, '梦境副本')));
  assert.deepEqual(s.state.agents, {});
  assert.deepEqual(Object.keys(s.freq()), []);
});

test('Store：save 原子写、无 .tmp 残留、剔除瞬态字段', () => {
  const dir = tmp();
  const s = new Store(dir);
  s.her().status = 'awake';
  s.her().frame = '画面文本';
  s.her().dream = { buffer: 'x' };
  s.her()._finishing = false;
  s.save();
  assert.ok(fs.existsSync(path.join(dir, 'state.json')));
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(onDisk.her.frame, undefined);
  assert.equal(onDisk.her.dream, undefined);
  assert.equal('_finishing' in onDisk.her, false);
});

test('Store：state.json 损坏改名留证、重置空状态', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), '{ 坏 JSON', 'utf8');
  const s = new Store(dir);
  assert.deepEqual(s.state.agents, {});
  const corrupt = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
  assert.equal(corrupt.length, 1);
});

test('Store：save 后 reload 状态往返', () => {
  const dir = tmp();
  const s = new Store(dir);
  s.her().status = 'sleeping';
  s.her().remaining = 1;
  s.save();
  const s2 = new Store(dir);
  assert.equal(s2.her().status, 'sleeping');
  assert.equal(s2.her().remaining, 1);
});

test('localDay 格式 yyyy-mm-dd', () => {
  assert.match(localDay(0), /^\d{4}-\d{2}-\d{2}$/);
});

test('latestResidue：旧绝对路径失效时按当前数据目录兜底（P1-3 回归）', () => {
  const dir = tmp();
  const s = new Store(dir);
  fs.mkdirSync(path.join(dir, '残留'), { recursive: true });
  fs.writeFileSync(path.join(dir, '残留', '2026-11-16-1.md'), '词：陷\n', 'utf8');
  s.her().residueAt = Date.now();
  s.her().residuePath = 'C:\\旧目录\\残留\\2026-11-16-1.md'; // 旧绝对路径（不存在）
  assert.equal(s.latestResidue(), '词：陷\n');
});

test('agent() 新建条目带 lastHuman（防首次 tick 立刻满足独处）', () => {
  const dir = tmp();
  const s = new Store(dir);
  const a = s.agent('x');
  assert.ok(a.lastHuman > 0);
  assert.ok(a.lastActivity > 0);
});
