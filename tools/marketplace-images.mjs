#!/usr/bin/env node
// Composes marketplace listing images from real screenshots.
// Usage: node tools/marketplace-images.mjs [shotsDir] [outDir]
// Screenshots (1398x675) are NOT kept in the repo; pass their directory as argv[2].
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.argv[2]) {
  console.error('usage: node tools/marketplace-images.mjs <shots-dir> [out-dir]  (screenshots stay outside the repo)');
  process.exit(1);
}
const shotsDir = resolve(process.argv[2]);
const outDir = resolve(process.argv[3] ?? join(here, '..', 'docs', 'marketplace', 'assets'));
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Extension content area inside each screenshot. Override per shoot with
// <shots-dir>/crop.json: {"src":{"w":..,"h":..},"crop":{"x":..,"y":..,"w":..,"h":..}}
let CROP = { x: 664, y: 112, w: 734, h: 563 };
let SRC = { w: 1398, h: 675 };
const cropFile = join(shotsDir, 'crop.json');
if (existsSync(cropFile)) ({ src: SRC, crop: CROP } = JSON.parse(readFileSync(cropFile, 'utf8')));
// Detail images: fit the crop into the right-hand area, never upscale.
const DS = Math.min(1, 600 / CROP.h, 740 / CROP.w);

const details = [
  ['detail-1-overview.png', 's1-overview.jpg', '目标和日历，放在同一个边栏', '日历在上、目标在下，不用离开多维表格'],
  ['detail-2-schedule.png', 's2-form.jpg', '点「安排…」，填个时间就排好', '也可以把目标直接拖进日历，或拖动时间块改期'],
  ['detail-3-priority.png', 's3-priority.jpg', '按轻重缓急，先做最重要的', '重要度和紧急度算出分数，自动分出 P0–P3'],
  ['detail-4-complete.png', 's4-complete.jpg', '做完了，点一下就记下', '时间块可以标记完成，也可以取消安排'],
  ['detail-5-sidebar.png', 's5-collapsed.jpg', '边栏窄也够用', '收起目标，日历占满整个高度'],
];

const FONT = `-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',sans-serif`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
// Keep each clause (split after full/ideographic commas) on one line when it fits.
const clauses = (s) => esc(s).split(/(?<=[，、])/).map((c) => `<span style="display:inline-block;white-space:nowrap">${c}</span>`).join('');

// Cropped screenshot at scale s (1 = native), via CSS background-position.
function shot(file, s, left, top) {
  const url = pathToFileURL(join(shotsDir, file)).href;
  return `<div style="position:absolute;left:${left}px;top:${top}px;box-sizing:content-box;
    width:${Math.round(CROP.w * s)}px;height:${Math.round(CROP.h * s)}px;border:1px solid #dfe3ea;background:#fff;
    box-shadow:0 12px 36px rgba(31,45,90,.14),0 2px 6px rgba(31,45,90,.08);overflow:hidden">
    <div style="width:100%;height:100%;background:url('${url}') no-repeat;
      background-size:${SRC.w * s}px ${SRC.h * s}px;
      background-position:${-CROP.x * s}px ${-CROP.y * s}px"></div></div>`;
}

const page = (w, h, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden}
body{position:relative;background:#f3f6fd;font-family:${FONT};color:#1f2329}
.t{position:absolute;font-weight:700;letter-spacing:-.01em;word-break:keep-all;overflow-wrap:anywhere}
.s{position:absolute;color:#646a73;line-height:1.55}
.col{position:absolute;display:flex;flex-direction:column;justify-content:center}
</style></head><body>${body}</body></html>`;

function detail(shotFile, title, sub) {
  const cw = Math.round(CROP.w * DS), ch = Math.round(CROP.h * DS);
  const W = 1160, H = 640, sx = W - 24 - cw - 2, sy = Math.round((H - ch - 2) / 2);
  const colX = 48, colW = sx - colX - 28;
  return page(W, H, `
    <div class="col" style="left:${colX}px;width:${colW}px;top:${sy}px;height:${ch + 2}px">
      <div class="t" style="position:static;font-size:40px;line-height:1.28">${clauses(title)}</div>
      <div class="s" style="position:static;margin-top:20px;font-size:18px">${clauses(sub)}</div>
    </div>
    ${shot(shotFile, DS, sx, sy)}`);
}

function cover() {
  const W = 700, H = 436, s = Math.min(0.62 * 563 / CROP.h, 0.62 * 734 / CROP.w);
  const w = Math.round(CROP.w * s), h = Math.round(CROP.h * s);
  const sx = W - 20 - w - 2, sy = Math.round((H - h - 2) / 2);
  const colX = 28, colW = sx - colX - 16;
  return page(W, H, `
    <div class="t" style="left:${colX}px;width:${colW}px;top:96px;font-size:30px;line-height:1.25">Osborn PA<br>工作台</div>
    <div class="s" style="left:${colX}px;width:${colW}px;top:190px;font-size:15px">${clauses("把目标拖进日历，数据都在你的多维表格里")}</div>
    ${shot('s1-overview.jpg', s, sx, sy)}`);
}

mkdirSync(outDir, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'mkt-img-'));
const jobs = [
  ...details.map(([out, src, t, s]) => ({ out, w: 1160, h: 640, src, html: detail(src, t, s) })),
  { out: 'cover-700x436.png', w: 700, h: 436, src: 's1-overview.jpg', html: cover() },
];
for (const j of jobs) {
  if (!existsSync(join(shotsDir, j.src))) throw new Error(`missing screenshot: ${join(shotsDir, j.src)}`);
  const htmlPath = join(tmp, j.out.replace(/\.png$/, '.html'));
  writeFileSync(htmlPath, j.html);
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--window-size=${j.w},${j.h}`, `--screenshot=${join(outDir, j.out)}`, pathToFileURL(htmlPath).href],
    { stdio: 'ignore' });
  console.log('wrote', join(outDir, j.out));
}
