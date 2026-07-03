#!/usr/bin/env node
// clean-verify-artifacts.mjs — Flow「commit 前清驗證垃圾」的確定性節點（檔案型）。
// 兩用：① CLI 直接跑（dry-run / --apply / --gitignore）；② 被 flow-commit-gate import
//   （白名單＝單一事實來源，兩處共用同一套規則，避免兩份規則漂移）。
// 只清「驗證/測試過程產生、不該進 repo 的產物 + 一次性 debug 殘留」，白名單式、可預覽、可還原。
// 設計鐵則：
//   1) 白名單刪除——只刪「已知產物 dir / 已知殘留檔 glob」，不盲掃。
//   2) 絕不碰交付物——source 測試檔（*.test.* / *.spec.* / *_test.*）、specs/、.flow 的 ledger|journal|manifest、
//      baseline/golden/snapshot/fixture（常是故意 commit 的基準檔）一律保（KEEP_RE 最高優先）。
//   3) 兩 tier 風險分層：
//        Tier A（絕對垃圾，tracked 與否都清）：產物目錄、*.log、*.trace.zip、__pycache__、*.pyc、
//          .last-run.json、debug-*、tmp-/temp-/scratch-、*.tmp。
//        Tier B（危險類別，僅 git untracked 才清）：散落的一次性截圖（screenshot-/snap-/capture-/page-*.png 等）、
//          Playwright 錄影 *.webm。你 commit 過的（設計稿、demo 影片）一律不碰；查不到 git 時 Tier B
//          整批保守略過（寧漏勿誤刪）。
//   4) 預設 dry-run（只印清單），加 --apply 才真刪。dry-run 有東西 → exit 3（給 commit-gate/呼叫端判斷「還沒清」）。
//   5) 不越界——所有目標 resolve 後 SHALL 仍在 root 內；.git / node_modules / legacy / archive / vendor 不進去。
//   6) 語意型垃圾（混在 source 的 mock/console.log/print）本 script 不處理——靠 flow-build Step 5 review（雙軌的另一軌）。
// 用法：
//   node clean-verify-artifacts.mjs [--root <path>] [--apply] [--gitignore]
//     省略 --root → cwd；省略 --apply → 只預覽不刪；--gitignore → 把產物 pattern 補進 <root>/.gitignore（冪等 managed block）。
import { readdirSync, statSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 不進去的目錄（剪枝）：版本控制 / 套件 / 保留區（legacy/archive 只回報不刪）。
export const PRUNE = new Set(['.git', 'node_modules', 'legacy', 'archive', 'vendor', '.venv', 'venv']);

// 整個刪掉的「產物目錄」basename。
export const ARTIFACT_DIRS = new Set([
  'test-results', 'playwright-report', '.playwright',     // @playwright/test
  '.playwright-mcp', 'playwright-mcp-output',             // @playwright/mcp：MCP 操作存 console-*.log / page-*.yml（a11y snapshot）/ 截圖
  'coverage', '.nyc_output', 'htmlcov',                   // 覆蓋率
  '.pytest_cache', '__pycache__',                         // pytest / Python
]);

// Tier A — 絕對垃圾檔（tracked 與否都清；commit-gate 也認這組）。以 basename 比對。
export const HARD_FILE_RE = [
  /\.log$/i,                                              // 各種驗證/啟動 log（含 .flow/*.log、MCP console-*.log）
  /^\.last-run\.json$/i,                                  // Playwright last-run
  /\.trace\.zip$/i,                                       // Playwright trace 殘留
  /\.pyc$/i,                                              // Python bytecode
  /^debug[-.].*\.(png|jpe?g|gif|json|txt|html)$/i,        // 一次性 debug 截圖/dump
  /^(tmp|temp|scratch)[-.].*/i,                           // 一次性暫存（任意副檔名，含臨時 .yml / scratch 腳本）
  /\.tmp$/i,
];

// Tier B — 危險類別（僅 git untracked 才清，避免誤殺剛加還沒 commit 的資產）。以 basename 比對。
export const SOFT_FILE_RE = [
  /^(screenshot|snap|capture|page)([-_.].*)?\.(png|jpe?g|gif|webp)$/i,  // 散落在產物目錄外的一次性截圖
  /\.webm$/i,                                                            // Playwright 錄影（retain-on-failure）
];

// 絕不刪：source 測試檔 + 刻意留存的 reference data（交付物）。命中即擋，優先於上面所有刪除規則。
export const KEEP_RE = [
  /\.(test|spec)\.[cm]?[jt]sx?$/i, /_test\.[a-z]+$/i, /(^|[/\\])conftest\.py$/i,
  /baseline/i, /golden/i, /snapshot/i, /\.fixture\./i,
];

// 歧義命名前綴（tmp-/temp-/scratch-/debug-）＋已知原始碼/設定/資產副檔名＝多半是正常檔非垃圾——排除，
// 堵誤判並誤刪 src/temp-storage.ts、scratch-pad.tsx、debug-config.json 這類正常原始碼/設定（commit 被 gate 擋、且 --apply 會 rm 掉真檔）。
// 刻意不含 .yml/.yaml：那正是「臨時 .yml」（Playwright 等）常見副檔名，維持可清；漏清一個 temp-*.json 遠比誤刪原始碼安全（fail-safe）。
const AMBIGUOUS_PREFIX_RE = /^(tmp|temp|scratch|debug)[-.]/i;
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|hpp|cpp|cc|cs|swift|kt|scala|css|scss|less|vue|svelte|json|jsonc|toml|md|mdx|html?|sql|sh|graphql|gql|proto)$/i;

// ── 判斷函數（純、可被 commit-gate import；白名單單一事實來源）──
export const keep = base => KEEP_RE.some(re => re.test(base));
export const isArtifactDir = base => ARTIFACT_DIRS.has(base);
export const isHardArtifact = base => {
  if (keep(base) || !HARD_FILE_RE.some(re => re.test(base))) return false;
  if (AMBIGUOUS_PREFIX_RE.test(base) && SOURCE_EXT_RE.test(base)) return false;  // 歧義前綴 + source 副檔名 → 正常檔非垃圾
  return true;
};
export const isSoftArtifact = base => !keep(base) && SOFT_FILE_RE.some(re => re.test(base));
// relative 路徑是否落在產物目錄下（任一路徑段命中 ARTIFACT_DIRS，例：.playwright-mcp/page-x.yml）。
export const underArtifactDir = relpath => relpath.split(/[/\\]/).some(seg => ARTIFACT_DIRS.has(seg));
// commit-gate 用：一個「即將進 commit 的 staged 檔」是否為確定性垃圾。
//   只認 Tier A + 產物目錄；不認 Tier B（圖/影片）——避免誤擋使用者故意 commit 的資產。
export function isCommitBlockableArtifact(relpath) {
  const base = relpath.split(/[/\\]/).pop() || relpath;
  if (keep(base)) return false;
  return underArtifactDir(relpath) || isHardArtifact(base);
}

// git untracked 集合（含被 .gitignore 忽略的——那些更該清）；fail-safe：非 git / git 不可用 → null（呼叫端對 Tier B 保守略過）。
export function gitUntracked(root) {
  try {
    const buf = execFileSync(
      'git',
      ['-C', root, 'ls-files', '--others', '-z', '--', '.', ':(exclude)node_modules', ':(exclude).git'],
      { maxBuffer: 1 << 26 },
    );
    const set = new Set();
    for (const rel of buf.toString('utf8').split('\0')) if (rel) set.add(path.resolve(root, rel));
    return set;
  } catch {
    return null;
  }
}

// ── 掃描（純函數：untracked 由呼叫端注入，測試可餵自訂集合，不依賴真 git）──
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
const fsize = p => { try { return statSync(p).size; } catch { return 0; } };

export function scan(root, untracked) {
  const ROOT = path.resolve(root);
  const inRoot = p => { const r = path.resolve(p); return r === ROOT || r.startsWith(ROOT + path.sep); };
  const dirs = [];   // 待刪目錄 {path, bytes}
  const files = [];  // 待刪檔案 {path, bytes, tier}
  (function walk(dir) {
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
        if (isHardArtifact(e.name)) files.push({ path: full, bytes: fsize(full), tier: 'A' });
        else if (untracked && untracked.has(path.resolve(full)) && isSoftArtifact(e.name))
          files.push({ path: full, bytes: fsize(full), tier: 'B' });
      }
    }
  })(ROOT);
  return { dirs, files };
}

// ── .gitignore 冪等 managed block ──
const GITIGNORE_BLOCK = [
  '# >>> flow-verify-artifacts (managed by clean-verify-artifacts.mjs) >>>',
  'test-results/', 'playwright-report/', '.playwright/',
  '.playwright-mcp/', 'playwright-mcp-output/',
  'coverage/', '.nyc_output/', 'htmlcov/',
  '.pytest_cache/', '__pycache__/',
  '*.log', '.last-run.json', '*.trace.zip', '*.tmp',
  '# <<< flow-verify-artifacts <<<',
].join('\n');

function ensureGitignore(root) {
  const gi = path.join(root, '.gitignore');
  const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const re = /# >>> flow-verify-artifacts[\s\S]*?# <<< flow-verify-artifacts <<<\n?/;
  const next = re.test(cur)
    ? cur.replace(re, GITIGNORE_BLOCK + '\n')
    : (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + GITIGNORE_BLOCK + '\n';
  if (next !== cur) { writeFileSync(gi, next, 'utf8'); return true; }
  return false;
}

// ── CLI（只在直接執行時跑；被 import 時不執行，讓 commit-gate 安全載入判斷函數）──
const isMain = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const flag = n => argv.includes(n);
  const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const ROOT = path.resolve(val('--root', process.cwd()));
  const APPLY = flag('--apply');
  const DO_GITIGNORE = flag('--gitignore');

  if (!existsSync(ROOT)) { console.error(`root 不存在：${ROOT}`); process.exit(1); }

  const untracked = gitUntracked(ROOT);
  const { dirs, files } = scan(ROOT, untracked);

  const rel = p => path.relative(ROOT, p) || '.';
  const fmt = b => b > 1 << 20 ? (b / (1 << 20)).toFixed(1) + 'MB' : b > 1023 ? (b / 1024).toFixed(0) + 'KB' : b + 'B';
  const totalBytes = [...dirs, ...files].reduce((s, x) => s + x.bytes, 0);
  const totalCount = dirs.length + files.length;

  console.log(`flow clean-verify-artifacts — root: ${ROOT}`);
  console.log(`模式：${APPLY ? 'APPLY（真刪）' : 'dry-run（只預覽，加 --apply 才刪）'}`);
  if (untracked === null) console.log('· 非 git repo 或 git 不可用：Tier B（圖/影片等危險類別）保守略過，只清 Tier A。');
  if (!totalCount) {
    console.log('✓ 沒有驗證垃圾可清。');
  } else {
    for (const d of dirs) console.log(`  [dir]  ${rel(d.path)}/  (${fmt(d.bytes)})`);
    for (const f of files) console.log(`  [${f.tier}]    ${rel(f.path)}  (${fmt(f.bytes)})`);
    console.log(`合計 ${totalCount} 項、約 ${fmt(totalBytes)}。（dir/A=絕對垃圾；B=untracked 才清的危險類別）`);
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
    const changed = ensureGitignore(ROOT);
    console.log(changed ? '✓ .gitignore 已補上 flow-verify-artifacts 區塊。' : '· .gitignore 已含 flow-verify-artifacts 區塊（未動）。');
  }

  // 給呼叫端（flow-commit-gate / flow-build）判斷：dry-run 但有東西 → exit 3「還沒清」；其餘 0。
  process.exit(!APPLY && totalCount ? 3 : 0);
}
