// 内容查看数据读取（纯函数，供 index.js 的 GET /api/dream-wander/view 与测试共用）。
// 只读文件；单文件 256KB 上限；副本只认 日期-场次.md 命名。
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE = 256 * 1024;

export const readText = (p) => {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_FILE) return '';
    return fs.readFileSync(p, 'utf8');
  } catch { return ''; }
};

export function readViewData({ dataDir, day, her, wanderPath, residueFilePath }) {
  const wander = readText(wanderPath(day)).split('\n\n').map((x) => x.trim()).filter(Boolean);
  let residue = null;
  try {
    const fp = residueFilePath?.(her) || '';
    if (fp) {
      const txt = readText(fp);
      if (txt) residue = { name: path.basename(fp), text: txt };
    }
  } catch {}
  const copies = [];
  try {
    const dir = path.join(dataDir, '梦境副本');
    const names = fs.readdirSync(dir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}-\d+\.md$/.test(n))
      .sort((x, y) => y.localeCompare(x, undefined, { numeric: true }))
      .slice(0, 3);
    for (const n of names) copies.push({ name: n, text: readText(path.join(dir, n)) });
  } catch {}
  let frame = null;
  try {
    const f = her?.frame;
    if (f?.text) frame = { text: String(f.text), at: Number(f.at) || 0 };
  } catch {}
  let dreaming = null;
  try {
    if (her?.status === 'dreaming' && her.dream) {
      const d = her.dream;
      const drip = [...String(d.buffer ?? '')].slice(0, d.dripIdx ?? 0).join('');
      dreaming = { halfN: d.halfN ?? 0, releasedText: String(d.released ?? '') + drip };
    }
  } catch {}
  return { dataDir, wander, residue, copies, frame, dreaming };
}
