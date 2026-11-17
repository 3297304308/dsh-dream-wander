#!/usr/bin/env node
// 发布前自检：包名/patch insert 名/客户端模块 id 三者一致 + files 清单里的运行时文件存在。
// 用法（默认用本插件目录，退出码 0=通过 1=失败）：
//   node tests/preflight-bundles.mjs [插件目录]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, "..");
const errors = [];
const warn = (m) => console.warn("warn: " + m);

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
} catch (e) {
  console.error("FAIL: 读不到 package.json —", e.message);
  process.exit(1);
}

const requireFile = (rel) => {
  if (!fs.existsSync(path.join(root, rel))) errors.push("缺少文件: " + rel);
};
for (const f of ["index.js", "cordis.patch.yml", "README.md", "LICENSE", "CHANGELOG.md", "icon.svg"]) requireFile(f);
for (const f of ["index.js", ...(fs.existsSync(path.join(root, "lib")) ? fs.readdirSync(path.join(root, "lib")).filter((x) => x.endsWith(".js")).map((x) => "lib/" + x) : [])]) requireFile(f);
for (const f of fs.existsSync(path.join(root, "locale")) ? fs.readdirSync(path.join(root, "locale")).filter((x) => x.endsWith(".json")).map((x) => "locale/" + x) : []) requireFile(f);

// 1) 包名 == patch insert name
const patchText = fs.readFileSync(path.join(root, "cordis.patch.yml"), "utf8");
const nameMatch = patchText.match(/name:\s*['"]([^'"]+)['"]/);
if (!nameMatch) errors.push("cordis.patch.yml 里没有 name");
else if (nameMatch[1] !== pkg.name) errors.push(`patch name (${nameMatch[1]}) != package name (${pkg.name})`);

// 2) 客户端模块 id == 包名
const clientFile = path.join(root, "lib", "client.js");
if (fs.existsSync(clientFile)) {
  const clientText = fs.readFileSync(clientFile, "utf8");
  const idMatch = clientText.match(/__ModuleLoader__\.load\(\{?[\s\S]*?id:\s*['"]([^'"]+)['"]/);
  if (!idMatch) warn("lib/client.js 没解析到 __ModuleLoader__ id（结构变了？人工核对）");
  else if (idMatch[1] !== pkg.name) errors.push(`client id (${idMatch[1]}) != package name (${pkg.name})`);
}

// 3) dsh 段
if (pkg.dsh?.bundle?.patch !== "./cordis.patch.yml") errors.push("dsh.bundle.patch 不是 ./cordis.patch.yml");
if (pkg.dsh?.client?.platform !== "web") errors.push("dsh.client.platform 不是 web");
if (!pkg.dsh?.manifestVersion) warn("dsh.manifestVersion 缺失");
if (!pkg.engines?.dsh) warn("engines.dsh 缺失（DSH 兼容门禁失效）");

// 4) npm files 白名单不得含运行时数据目录
const files = Array.isArray(pkg.files) ? pkg.files : [];
if (files.some((f) => String(f).replace(/^\//, "").startsWith("data"))) errors.push("files 里不能有 data（运行数据/私密内容）");
for (const need of ["index.js", "lib", "cordis.patch.yml", "README.md"]) {
  if (!files.includes(need)) warn("files 缺少 " + need);
}

if (errors.length) {
  console.error("FAIL\n" + errors.map((e) => " - " + e).join("\n"));
  process.exit(1);
}
console.log("OK: " + pkg.name + "@" + pkg.version + " 清单一致，文件齐全");
