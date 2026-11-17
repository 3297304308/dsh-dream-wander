// 单进程测试入口：node tests/index.mjs（不用 test-runner 的子进程 spawn，沙箱/受限环境可用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();
for (const f of files) await import(pathToFileURL(path.join(dir, f)).href);
