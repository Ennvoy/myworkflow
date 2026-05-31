#!/usr/bin/env node
// clean-verify-artifacts.mjs — Flow「commit 前清驗證垃圾」的確定性閘門（檔案型）。
// 只清「驗證/測試過程產生、不該進 repo 的產物 + 一次性 debug 殘留檔」，白名單式、可預覽、可還原（git 未追蹤的本來就不該存在）。
// 設計鐵則：
//   1) 白名單刪除——只刪「已知產物 dir / 已知殘留檔 glob」，不盲掃。
//   2) 絕不碰交付物——source 測試檔（*.test.* / *.spec.* / *_test.*）、specs/、.flow/ 的 ledger|journal|manifest 一律保。
//   3) 預設 dry-run（只印清單），加 --apply 才真刪——避免誤觸。flow-build / flow-ship 文件呼叫時帶 --apply。
//   4) 不越界——所有目標 resolve 後 SHALL 仍在 root 內；.git / node_modules / legacy / archive / vendor 不進去（憲法：legacy/archive 只回報不刪）。
//   5) 語意型垃圾（混在 source 的 mock/console.log/print）本 script 不處理——那靠 flow-build Step 5 的 review 紀律（雙軌的另一軌）。
// 用法：
//   node clean-verify-artifacts.mjs [--root <path>] [--apply] [--gitignore]
//     省略 --root → cwd；省略 --apply → 只預覽不刪；--gitignore → 把產物 pattern 補進 <root>/.gitignore（冪等 managed block）。
import { readdirSync, statSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(val('--root', process.cwd()));
const APPLY = flag('--apply');
const DO_GITIGNORE = flag('--gitignore');

// 不進去的目錄（剪枝）：版本控制 / 套件 / 保留區（legacy/archive 只回報不刪）。
const PRUNE = new Set(['.git', 'node_modules', 'legacy', 'archive', 'vendor', '.venv', 'venv']);

// 整個刪掉的「產物目錄」basename。
const ARTIFACT_DIRS = new Set([
  'test-results', 'playwright-report', '.playwright',   // Playwright
  'coverage', '.nyc_output', 'htmlcov',                 // 覆蓋率
  '.pytest_cache', '__pycache__',                       // pytest / Python
]);

// 刪掉的「殘留檔」——以 basename 比對。保守白名單，dry-run 會先印給人看。
const FILE_RE = [
  /\.log$/i,                                            // 各種驗證/啟動 log（.flow/*.log 也在此）
  /^\.last-run\.json$/i,                                // Playwright last-run
  /\.trace\.zip$/i,                                     // Playwright trace 殘留
  /\.pyc$/i,                                            // Python bytecode
  /^debug[-.].*\.(png|jpe?g|gif|json|txt|html)$/i,      // 一次性 debug 截圖/dump
  /^(tmp|temp|scratch)[-.].*/i,                         // 一次性暫存
  /\.tmp$/i,
];

// 絕不刪：source 測試檔 + 刻意留存的 reference data（交付物）。即使 basename 命中上面的刪除 glob 也擋下。
// baseline/golden/snapshot/fixture 常是「故意 commit 的基準檔」（如 e2e api.baseline.log），漏刪無害、誤刪有害 → 一律保。
const KEEP_RE = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i, /_test\.[a-z]+$/i, /(^|\/)conftest\.py$/i,
  /baseline/i, /golden/i, /snapshot/i, /\.fixture\./i,
];

const inRoot = p => { const r = path.resolve(p); return r === ROOT || r.startsWith(ROOT + path.sep); };
const keep = base => KEEP_RE.some(re => re.test(base));

const dirs = [];   // 待刪目錄 {path, bytes}
const files = [];  // 待刪檔案 {path, bytes}

function dirBytes(p) {
  let total = 0;
  try {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const c = path.join(p, e.name);
      try { total += e.isDirectory() ? dirBytes(c) : statSync(c).size; } catch {}
    }
  } catch {}
  return total;
}

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (!inRoot(full)) continue;
    if (e.isDirectory()) {
      if (PRUNE.has(e.name)) continue;
      if (ARTIFACT_DIRS.has(e.name)) { dirs.push({ path: full, bytes: dirBytes(full) }); continue; } // 不再下探
      walk(full);
    } else if (e.isFile()) {
      if (keep(e.name)) continue;
      if (FILE_RE.some(re => re.test(e.name))) {
        let bytes = 0; try { bytes = statSync(full).size; } catch {}
        files.push({ path: full, bytes });
      }
    }
  }
}

const GITIGNORE_BLOCK = [
  '# >>> flow-verify-artifacts (managed by clean-verify-artifacts.mjs) >>>',
  'test-results/', 'playwright-report/', '.playwright/',
  'coverage/', '.nyc_output/', 'htmlcov/',
  '.pytest_cache/', '__pycache__/',
  '*.log', '.last-run.json', '*.trace.zip', '*.tmp',
  '# <<< flow-verify-artifacts <<<',
].join('\n');

function ensureGitignore() {
  const gi = path.join(ROOT, '.gitignore');
  let cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const re = /# >>> flow-verify-artifacts[\s\S]*?# <<< flow-verify-artifacts <<<\n?/;
  const next = re.test(cur)
    ? cur.replace(re, GITIGNORE_BLOCK + '\n')
    : (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + GITIGNORE_BLOCK + '\n';
  if (next !== cur) { writeFileSync(gi, next, 'utf8'); return true; }
  return false;
}

// ── 跑 ──
if (!existsSync(ROOT)) { console.error(`root 不存在：${ROOT}`); process.exit(1); }
walk(ROOT);

const rel = p => path.relative(ROOT, p) || '.';
const fmt = b => b > 1 << 20 ? (b / (1 << 20)).toFixed(1) + 'MB' : b > 1023 ? (b / 1024).toFixed(0) + 'KB' : b + 'B';
const totalBytes = [...dirs, ...files].reduce((s, x) => s + x.bytes, 0);
const totalCount = dirs.length + files.length;

console.log(`flow clean-verify-artifacts — root: ${ROOT}`);
console.log(`模式：${APPLY ? 'APPLY（真刪）' : 'dry-run（只預覽，加 --apply 才刪）'}`);
if (!totalCount) {
  console.log('✓ 沒有驗證垃圾可清。');
} else {
  for (const d of dirs) console.log(`  [dir]  ${rel(d.path)}/  (${fmt(d.bytes)})`);
  for (const f of files) console.log(`  [file] ${rel(f.path)}  (${fmt(f.bytes)})`);
  console.log(`合計 ${totalCount} 項、約 ${fmt(totalBytes)}。`);
}

if (APPLY) {
  let done = 0;
  for (const x of [...dirs, ...files]) {
    try { rmSync(x.path, { recursive: true, force: true }); done++; }
    catch (e) { console.error(`  ✗ 刪不掉 ${rel(x.path)}：${e.message}`); }
  }
  if (totalCount) console.log(`✓ 已清 ${done}/${totalCount} 項。`);
}

if (DO_GITIGNORE) {
  const changed = ensureGitignore();
  console.log(changed ? '✓ .gitignore 已補上 flow-verify-artifacts 區塊。' : '· .gitignore 已含 flow-verify-artifacts 區塊（未動）。');
}

// 給呼叫端（flow-build）判斷：dry-run 但有東西 → exit 3 提醒「還沒清」；其餘 0。
process.exit(!APPLY && totalCount ? 3 : 0);
