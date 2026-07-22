#!/usr/bin/env node
// ui-compare-capture.mjs — 視覺比對閘門的確定性截圖節點。
// 病根：「mockup 頁 vs 實作頁像不像」原本全靠 Evaluator 開瀏覽器目測、沒留機讀證據，事後查無對錯。
// 修法：Evaluator 只負責「看」——「截」交給這支腳本：mockup 頁（起 ephemeral 靜態伺服器服務
// specs/ui-mockups/）與實作頁（打 --map 給的 base+route）各截一張，逐頁落 manifest，
// 下游 flow-state ui-compare --status pass 驗雙邊截圖真的都在、且截的是當前定版原型。
// 用法：node ui-compare-capture.mjs [--root <path>] [--map <map.json>] [--out <dir>] [--viewports 1440x900,390x844]
//   map.json 形狀：{ "base": "http://localhost:4173", "storageState": "<選填，Playwright storage state 檔路徑>",
//                    "pages": { "pages/login.html": "/login", … } }（Evaluator 依 design.md 撰寫）
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as S from './statelib.mjs';

// ── 純 helper（可測、不碰檔案系統/瀏覽器）──

// "<寬>x<高>[,<寬>x<高>…]" → [{width,height}]；格式錯直接丟例外（呼叫端在啟動前 exit 2，別餵壞設定進瀏覽器）。
export function parseViewports(s) {
  const toks = String(s || '').split(',').map(t => t.trim()).filter(Boolean);
  if (!toks.length) throw new Error('viewports 不得為空（格式：<寬>x<高>[,<寬>x<高>…]，如 1440x900,390x844）');
  return toks.map(t => {
    const m = /^(\d+)x(\d+)$/i.exec(t);
    if (!m) throw new Error(`不合法的 viewport 格式：「${t}」（須為 <寬>x<高>，如 1440x900）`);
    return { width: Number(m[1]), height: Number(m[2]) };
  });
}

// path traversal 防護：resolve 後必須仍在 base 目錄內，否則回 null（靜態伺服器用；file:// 沒有此問題但 http 服要防）。
export function safeJoin(base, rel) {
  const baseResolved = path.resolve(base);
  const target = path.resolve(baseResolved, '.' + path.sep + String(rel || ''));
  if (target !== baseResolved && !target.startsWith(baseResolved + path.sep)) return null;
  return target;
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8',
};
export function contentTypeFor(ext) { return CONTENT_TYPES[String(ext || '').toLowerCase()] || 'application/octet-stream'; }

// 相對路徑正規化（僅供 map.json key 比對用，寬容 ./ 前綴／反斜線／尾斜線外觀差異；非權威分母來源）。
const normRel = p => String(p || '').trim().replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+$/, '');

// ── IO / 副作用（原子寫，同 statelib 慣例：先寫 tmp 再 rename）──
function writeJSONAtomic(p, obj) {
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8'); renameSync(tmp, p); }
  catch (e) { try { unlinkSync(tmp); } catch { /* tmp 不存在/已清，忽略 */ } throw e; }
}

// 現行 HEAD sha（best-effort；非 git/無 commit/失敗回 ''）——比照 flow-state.mjs 的 gitHead，manifest 綁審計錨。
function gitHead(r) {
  try { return execSync('git rev-parse HEAD', { cwd: r, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

function startStaticServer(baseDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
      const target = safeJoin(baseDir, urlPath.replace(/^\/+/, ''));
      if (!target || !existsSync(target) || statSync(target).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': contentTypeFor(path.extname(target)) });
      res.end(readFileSync(target));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// networkidle 等太久（長輪詢/websocket 頁面永遠不會 idle）→ 15s 超時退回 load，settle 300ms 讓動畫穩定再截圖。
async function gotoSettled(page, url, warnings) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
  } catch {
    await page.goto(url, { waitUntil: 'load' });
    warnings.push(`${url}：networkidle 15s 逾時，已退回 load（頁面可能仍在背景輪詢，截圖僅供參考）`);
  }
  await page.waitForTimeout(300);
}

async function loadChromium(root) {
  const req = createRequire(path.join(root, 'package.json'));
  for (const pkg of ['@playwright/test', 'playwright', 'playwright-core']) {
    try { const mod = req(pkg); if (mod && mod.chromium) return mod.chromium; } catch { /* 試下一個 */ }
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const i = argv.indexOf(n); const v = i >= 0 ? argv[i + 1] : undefined; return (v !== undefined && !v.startsWith('--')) ? v : d; };
  const root = path.resolve(flag('--root', process.cwd()));
  const mapPath = path.resolve(root, flag('--map', path.join('.flow', 'trace', 'ui-compare', 'map.json')));
  const outDir = path.resolve(root, flag('--out', path.join('.flow', 'trace', 'ui-compare')));

  let viewports;
  try { viewports = parseViewports(flag('--viewports', '1440x900,390x844')); }
  catch (e) { console.error('✗ ' + e.message); process.exit(2); }

  // ── 前置對賬：定版分母須實存且未漂移（同 ui-fidelity 先修的思路——別把漂移中的原型餵進截圖）──
  const index = await S.readMockupIndex(root);
  if (!index) { console.error('✗ 查無 .flow/trace/mockup-index.json——互動原型尚未定版凍結。先跑 flow-state spec-ready --freeze。'); process.exit(2); }
  const curHashes = await S.mockupFileHashes(root);
  const hp = S.mockupHashProblem(index, curHashes);
  if (hp) { console.error('✗ ' + hp); process.exit(2); }
  const pages = S.mockupPageList(index);
  const aggHashNow = S.mockupAggHash(curHashes);

  if (!existsSync(mapPath)) {
    console.error(`✗ 查無頁面對應表（${path.relative(root, mapPath)}）——先依 design.md 撰寫每頁的實作路由。用法：`);
    console.error('  { "base": "http://localhost:4173", "storageState": "<選填，Playwright storage state 檔路徑>",');
    console.error('    "pages": { "pages/login.html": "/login", "pages/items.html": "/items" } }');
    process.exit(2);
  }
  let map;
  try { const raw = readFileSync(mapPath, 'utf8'); map = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); }
  catch (e) { console.error(`✗ map 檔解析失敗：${e.message}`); process.exit(2); }
  if (!map || !map.base) { console.error('✗ map 檔缺 "base"（實作端起始 URL，如 http://localhost:4173）'); process.exit(2); }

  const mapPagesNorm = {};
  for (const [k, v] of Object.entries(map.pages || {})) mapPagesNorm[normRel(k)] = v;
  const pageSet = new Set(pages.map(normRel));
  const strays = Object.keys(mapPagesNorm).filter(k => !pageSet.has(k));
  if (strays.length) console.log(`⚠ map 檔宣告了分母外的頁（可能打錯字，不擋）：${strays.join('、')}`);
  const unmapped = pages.filter(p => !(normRel(p) in mapPagesNorm));
  if (unmapped.length) console.log(`⚠ 分母頁缺 mapping（不擋，收尾靠 ui-compare n/a+decision 或補 map 兜住）：${unmapped.join('、')}`);
  const mappedPages = pages.filter(p => normRel(p) in mapPagesNorm);

  const pagesManifest = {};
  const failures = [];
  const warnings = [];

  if (mappedPages.length) {
    const chromium = await loadChromium(root);
    if (!chromium) { console.error('✗ 找不到可用的 Playwright（試過 @playwright/test / playwright / playwright-core）——web 類驗證本來就需要 Playwright，先在專案安裝其中一套。'); process.exit(2); }

    const mockupBase = path.join(root, 'specs', 'ui-mockups');
    const server = await startStaticServer(mockupBase);   // file:// 遇 ES module/fetch 會 CORS 死，起真 http 服才穩
    const port = server.address().port;
    const browser = await chromium.launch({ headless: true });

    for (const pageRel of mappedPages) {
      const route = mapPagesNorm[normRel(pageRel)];
      const slug = S.uiCompareSlug(pageRel);
      const subdir = path.join(outDir, slug);
      mkdirSync(subdir, { recursive: true });
      const shots = [];
      for (const vp of viewports) {
        const label = `${vp.width}x${vp.height}`;
        try {
          const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: 'reduce' });
          const page = await ctx.newPage();
          await gotoSettled(page, `http://127.0.0.1:${port}/${pageRel}`, warnings);
          const shotPath = path.join(subdir, `mockup-${label}.png`);
          await page.screenshot({ path: shotPath, fullPage: true });
          await ctx.close();
          shots.push(path.relative(root, shotPath).replace(/\\/g, '/'));
        } catch (e) { failures.push(`${pageRel} @ ${label}（mockup）截圖失敗：${e.message}`); }
        try {
          const ctxOpts = { viewport: { width: vp.width, height: vp.height }, reducedMotion: 'reduce' };
          if (map.storageState) ctxOpts.storageState = path.resolve(root, map.storageState);
          const ctx = await browser.newContext(ctxOpts);
          const page = await ctx.newPage();
          const implUrl = /^https?:\/\//i.test(route) ? route : (String(map.base).replace(/\/$/, '') + (String(route).startsWith('/') ? route : '/' + route));
          await gotoSettled(page, implUrl, warnings);
          const shotPath = path.join(subdir, `impl-${label}.png`);
          await page.screenshot({ path: shotPath, fullPage: true });
          await ctx.close();
          shots.push(path.relative(root, shotPath).replace(/\\/g, '/'));
        } catch (e) { failures.push(`${pageRel} @ ${label}（impl）截圖失敗：${e.message}`); }
      }
      pagesManifest[pageRel] = { slug, url: route, shots };
    }

    await browser.close();
    await new Promise(res => server.close(res));
  }

  if (warnings.length) { console.log('\n⚠ 提醒（不擋）：'); for (const w of warnings) console.log('  ' + w); }

  const manifest = {
    at: new Date().toISOString(),
    head: gitHead(root),
    mockupAggHash: aggHashNow,
    viewports: viewports.map(v => `${v.width}x${v.height}`),
    base: map.base,
    pages: pagesManifest,
    unmapped,
    failures,
  };
  writeJSONAtomic(path.join(outDir, 'capture.json'), manifest);

  if (failures.length) {
    console.error(`\n✗ 截圖失敗 ${failures.length} 項（部分截圖已保留於 ${path.relative(root, outDir)} 供除錯）：`);
    for (const f of failures) console.error('  - ' + f);
    process.exit(2);
  }
  console.log(`\n✓ 截圖完成：${Object.keys(pagesManifest).length} 頁 × ${viewports.length} 個 viewport。manifest 落 ${path.relative(root, path.join(outDir, 'capture.json'))}。`);
  console.log('  下一步：Evaluator 逐頁對照雙邊截圖，flow-state ui-compare <pageRel> --status <pass|fail|n/a> 落機讀記錄。');
}

// ── CLI（只在直接執行時跑；被 import 時不執行，讓測試安全載入純 helpers）──
const isMain = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();
if (isMain) {
  main().catch(e => { console.error('✗ ' + (e && e.stack ? e.stack : e)); process.exit(2); });
}
