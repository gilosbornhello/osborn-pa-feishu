#!/usr/bin/env node
// Assemble the static bundle published to 妙搭 HTML hosting: the workbench
// prototype (local or ?data=base), the read-only host probe, and the Base
// write self-test.
// Output: dist-hosted/ (git-ignored). No build step; files are copied as-is.
//
// 妙搭 quirks this works around (seen 2026-11-03):
// - `x.html` is served at an extensionless URL without a trailing slash, so
//   pages live at the site root and reference root-level assets.
// - scripts are 302-redirected to signed CDN URLs, so a module's relative
//   imports would hit unsigned URLs (403); the workbench ships as one bundle.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { bundle } from "./bundle-esm.mjs";

const out = new URL("../dist-hosted/", import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(new URL("workbench.js", out), bundle(new URL("../packages/workbench/src/app.js", import.meta.url)));
cpSync(new URL("../packages/workbench/src/workbench.css", import.meta.url), new URL("workbench.css", out));
const workbench = readFileSync(new URL("../packages/workbench/index.html", import.meta.url), "utf8")
  .replace('"./src/workbench.css"', '"./workbench.css"')
  .replace('"./src/app.js"', '"./workbench.js"');
if (workbench.includes("./src/")) throw new Error("workbench.html still references ./src/");
writeFileSync(new URL("workbench.html", out), workbench);
cpSync(new URL("../packages/workbench/probe.html", import.meta.url), new URL("probe.html", out));
writeFileSync(new URL("selftest.js", out), bundle(new URL("../packages/workbench/src/selftest.js", import.meta.url)));
cpSync(new URL("../packages/workbench/selftest.html", import.meta.url), new URL("selftest.html", out));
writeFileSync(new URL("index.html", out), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Osborn PA Preview</title>
<style>:root{--bg:#fff;--fg:#1f2329}@media (prefers-color-scheme: dark){:root{--bg:#1b1b1f;--fg:#e8e8ea}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,sans-serif}a{color:inherit}</style>
</head><body>
<h1 style="font-size:18px">Osborn PA 托管验证（合成数据）</h1>
<ul>
<li><a href="./workbench">工作台原型</a>（数据只在本浏览器，本页不连接飞书数据）</li>
<li><a href="./probe">宿主环境探针</a>（只读）</li>
<li>工作台接当前多维表格：插件地址用 <code>./workbench?data=base</code>；写入自检：<code>./selftest</code>（仅在测试 Base 的插件中使用）</li>
</ul>
</body></html>
`);
console.log(new URL(out).pathname);
