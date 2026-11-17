import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readViewData } from '../lib/view.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dw-view-'));
const mkHer = (over = {}) => ({ residuePath: '', ...over });
const fakeResidue = (her) => (her?.residuePath ? path.join(os.tmpdir(), 'nope', path.basename(her.residuePath)) : '');

test('readViewData：走神分段、残留、副本数字序', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '走神'), { recursive: true });
  fs.mkdirSync(path.join(dir, '残留'), { recursive: true });
  fs.mkdirSync(path.join(dir, '梦境副本'), { recursive: true });
  fs.writeFileSync(path.join(dir, '走神', '2026-11-17.md'), '第一段。\n\n第二段。\n\n', 'utf8');
  fs.writeFileSync(path.join(dir, '残留', '2026-11-16-1.md'), '词：陷\n', 'utf8');
  for (const n of ['2026-11-16-1.md', '2026-11-16-2.md', '2026-11-16-10.md', '乱名.md']) fs.writeFileSync(path.join(dir, '梦境副本', n), n, 'utf8');
  const her = mkHer({ residuePath: path.join(os.tmpdir(), 'dw-old-dir', '残留', '2026-11-16-1.md') });
  const v = readViewData({
    dataDir: dir, day: '2026-11-17', her,
    wanderPath: (d) => path.join(dir, '走神', d + '.md'),
    residueFilePath: () => path.join(dir, '残留', '2026-11-16-1.md'),
  });
  assert.deepEqual(v.wander, ['第一段。', '第二段。']);
  assert.equal(v.residue.name, '2026-11-16-1.md');
  assert.equal(v.residue.text, '词：陷\n');
  assert.deepEqual(v.copies.map((c) => c.name), ['2026-11-16-10.md', '2026-11-16-2.md', '2026-11-16-1.md']); // 数字序倒序、只认日期-场次、最多 3
});

test('readViewData：内存画面与正在做梦', () => {
  const dir = tmp();
  const her = mkHer({ frame: { text: '最后画面', at: 123 }, status: 'dreaming', dream: { buffer: 'ABCDE', dripIdx: 3, released: 'XX', halfN: 2 } });
  const v = readViewData({ dataDir: dir, day: '2026-11-17', her, wanderPath: () => path.join(dir, 'none.md'), residueFilePath: () => '' });
  assert.equal(v.frame.text, '最后画面');
  assert.equal(v.frame.at, 123);
  assert.equal(v.dreaming.halfN, 2);
  assert.equal(v.dreaming.releasedText, 'XXABC');
});

test('readViewData：空目录安全返回空', () => {
  const dir = tmp();
  const v = readViewData({ dataDir: dir, day: '2026-11-17', her: mkHer(), wanderPath: () => path.join(dir, 'none.md'), residueFilePath: () => '' });
  assert.deepEqual(v.wander, []);
  assert.equal(v.residue, null);
  assert.deepEqual(v.copies, []);
  assert.equal(v.frame, null);
  assert.equal(v.dreaming, null);
});
