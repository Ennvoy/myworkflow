#!/usr/bin/env node
// Flow 自駕硬閘門（PreToolUse on Write|Edit|Bash|PowerShell）。**僅 mode==='auto'（manifest 先、state.json 後）時啟用**，manual 一律放行。
// 把自駕 T1 必停集合的「可機檢子集」從散文升成 exit-2 閘門（與 commit-gate/done-gate 同風格、模型不能滑過）：
//   ① 裝新相依（npm/pnpm/yarn/bun add|install <pkg>、pip install <pkg>、cargo add、go get、gem install）
//   ①' C-5：編輯相依 manifest（package.json/lockfile/requirements.txt/… 的 Write|Edit）——堵「改檔加套件→bare install 還原」繞過 ①
//   ② 破壞性 DB（DROP/TRUNCATE、無 WHERE 的 DELETE/UPDATE）
//   ③ doom-loop 硬天花板：同一 runner 失敗連 ≥ hardThreshold（軟 STALL 被忽略太久）→ 硬擋下一次同 runner 重跑
// 語義型 T1（需求骨架誤判 / 安全紅旗）＋純字串抓不到的間接執行（npm run setup / node migrate.mjs / psql -f）本質是語義/間接，
// 做不成確定性閘門，留散文 T1（autonomous-mode.md 誠實標注涵蓋邊界）。
// 一律 fail-open：任何錯 / 非 Flow / 非 auto → exit 0 放行，絕不誤擋。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// C-3①：本 gate 的邏輯抽成 autoGateCheck(input) → { block, message }，供 flow-dispatch 合併呼叫（一次 node 冷啟跑完三道門）；
// 保留獨立 main() 讓本檔仍可單獨當 hook 跑（測試/相容）。**只有直接執行本檔時才掛 stdin/跑 main**——被 dispatch import 時
// 不可自動跑（否則 import 就註冊一組 stdin 監聽、跑自己的 main、搶先 exit，把 dispatcher 短路）。fail-open 由呼叫端 try-catch。
let raw = '';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('data', c => (raw += c));
  process.stdin.on('end', () => { main().catch(() => process.exit(0)); });
}

// C-45：單一相依管理表——detect（isNewDependency）與 extract（extractDepNames）同源，杜絕兩份平行 regex
// 漏同步一邊即 allowlist 靜默失效的漂移。每條 re 的 group 1 = 套件參數串。npm 家族帶特殊邏輯（add 一定加相依、
// install/i 帶名才算、bare install＝還原 lockfile 放行），故單獨處理但仍在同一 depMatch 出口。
// 刻意「不」在 extract 截斷 && 後串接命令：chained `npm i <allowed> && npm i <evil>` 若截斷成 [<allowed>]
// 會讓整條命令被 allowlist 放行（evil 跟著跑）；保留整串 → 含 &&/命令 token → allowlist 必 miss → 硬擋（fail-safe）。
// detect 語意逐一保留原行為：pip 須 install 後緊接非 dash（排除 `pip install -r req.txt` 還原）；
// cargo add / go get / gem install / poetry·composer add|require 任何非空參數即算（\S 觸發，fail-safe 從嚴）。
const DEP_ARG_RES = [
  /\bpip3?\s+install\s+(?=[^\s\-])(.+)$/i,
  /\bcargo\s+add\s+(\S.*)$/i,
  /\bgo\s+get\s+(\S.*)$/i,
  /\bgem\s+install\s+(\S.*)$/i,
  /\b(?:poetry|composer)\s+(?:add|require)\s+(\S.*)$/i,
];
const NPM_DEP_RE = /\b(npm|pnpm|yarn|bun)\s+(add|install|i)\b(.*)$/i;
const argTokens = a => String(a || '').trim().split(/\s+/).filter(t => t && !t.startsWith('-'));

// 回 { pkgs } / { pkgs, forceAdd } / null。null＝非裝新相依（含 bare install / pip restore）。
function depMatch(s) {
  const str = String(s);
  for (const re of DEP_ARG_RES) { const m = str.match(re); if (m) return { pkgs: argTokens(m[1]) }; }
  const m = str.match(NPM_DEP_RE);
  if (m) {
    const pkgs = argTokens(m[3]);
    if (/^add$/i.test(m[2])) return { pkgs, forceAdd: true };   // add 一定是加相依（即使抓不到 token）
    return pkgs.length ? { pkgs } : null;                       // install/i 帶套件名＝新相依；bare＝還原 lockfile（放行）
  }
  return null;
}
function isNewDependency(s) { return !!depMatch(s); }

// W4-2：dependency 預核准——.flow/policy.json（進 git、使用者拍板維護）：{ "deps": { "allow": ["lodash", "@types/*"] } }。
// 命令裡「全部」套件名都命中 allowlist → 放行＋自動落 decision 審計；任一不在清單 → 照原樣硬擋彈窗。
// 讀不到 policy＝無白名單（維持硬擋）——放鬆只能來自實存的使用者政策檔。
function extractDepNames(s) { const d = depMatch(s); return d ? d.pkgs : []; }
function depAllowed(pkgs, allow) {
  if (!Array.isArray(allow) || !allow.length || !pkgs.length) return false;
  const names = pkgs.map(p => String(p).toLowerCase().replace(/(.)@[^@]+$/, '$1'));   // 去版本後綴（scoped 開頭的 @ 不受影響）
  return names.every(p => allow.some(a => {
    const A = String(a).toLowerCase();
    return A.endsWith('*') ? p.startsWith(A.slice(0, -1)) : p === A;
  }));
}

// 破壞性 DB（命令列內嵌 SQL；best-effort）。
function isDestructiveDB(s) {
  if (/\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX)|TRUNCATE\b)/i.test(s)) return true;
  if (/\bDELETE\s+FROM\b/i.test(s) && !/\bWHERE\b/i.test(s)) return true;
  if (/\bUPDATE\s+\S+\s+SET\b/i.test(s) && !/\bWHERE\b/i.test(s)) return true;
  return false;
}

const PASS = { block: false };
const BLOCK = msg => ({ block: true, message: msg });

// C-5：相依 manifest 檔（編輯它加套件 → 之後 bare install 還原＝繞過命令列 install 偵測）。
const isDepManifest = p => /(^|[\/\\])(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|pyproject\.toml|Pipfile|Cargo\.toml|go\.mod|Gemfile|composer\.json)$/i.test(String(p || ''));

// C-5b：dep manifest 的**內容級** allowlist——與命令列路徑對稱。原本 isEdit 一律硬擋，等於使用者在 policy.json
// 預核准過的套件，改走 Write/Edit 仍逐次停（scaffold 這種必須手寫 package.json 的場景直接卡死），與 W4-2 預核准意圖矛盾。
// **涵蓋邊界（誠實標注）**：只解析 package.json——格式已知、能精確抽出相依 key。lockfile 與其他生態 manifest
// （requirements.txt/Cargo.toml/go.mod…）格式雜、片段解析不可靠，維持原樣硬擋（fail-safe，寧可多停一次）。
// 回 { pkgs }＝本次宣告的相依集合（空集＝這次編輯沒宣告任何相依）；回 null＝無法可靠判定 → 呼叫端維持硬擋。
const VERSION_VAL_RE = /^(?:\^|~|>=?|<=?|=|\*|\d|workspace:|npm:|file:|link:|catalog:|git\+|https?:)/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
function declaredDeps(ti, target) {
  if (!/(^|[\/\\])package\.json$/i.test(String(target || ''))) return null;
  const content = ti.content ?? ti.new_string ?? ti.newString;
  if (typeof content !== 'string') return null;
  try {
    const j = JSON.parse(content);                     // Write：完整 JSON → 精確取四個相依欄位的 key
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      const out = [];
      for (const f of DEP_FIELDS) if (j[f] && typeof j[f] === 'object') out.push(...Object.keys(j[f]));
      return { pkgs: out };
    }
  } catch { /* 非完整 JSON（Edit 片段）→ 退回片段掃描 */ }
  const found = [];                                    // Edit 片段：抓 "pkg": "<版本樣式>" 條目
  for (const m of content.matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)) if (VERSION_VAL_RE.test(m[2])) found.push(m[1]);
  return found.length ? { pkgs: found } : null;        // 一條都抓不到＝看不出在改什麼 → 維持硬擋
}

// 讀 .flow/policy.json 的 deps.allow（讀不到＝無白名單，維持硬擋）。命令列與 manifest 兩條路徑共用。
function policyAllow(cwd) {
  try { const p = JSON.parse(stripBom(readFileSync(join(cwd, '.flow', 'policy.json'), 'utf8'))); return (p && p.deps && p.deps.allow) || null; }
  catch { return null; }
}
// 放行時留審計線（policy 放行不是無痕跳過）。審計失敗不擋放行。
async function recordDepAllowed(cwd, pkgs, via) {
  try {
    const S0 = await import('../skills/flow-toolkit/statelib.mjs');
    const slug = pkgs.join('-').replace(/[^\w.\-]+/g, '-').slice(0, 60) || 'pkg';
    await S0.recordDecision(cwd, `dep-auto-${slug}`, { choice: `allowlist 放行${via}：${pkgs.join(' ')}`, why: '.flow/policy.json deps.allow 命中（W4-2 預核准）', by: 'auto-gate' });
  } catch { /* 審計非關鍵 */ }
}

// C-3①：純判定（不碰 stdin/exit）——回 { block, message }。dispatch 與 main 共用。
export async function autoGateCheck(input) {
  const tool = input.tool_name ?? input.toolName ?? '';
  const isCmd = tool === 'Bash' || tool === 'PowerShell';
  const isEdit = tool === 'Write' || tool === 'Edit';
  if (!isCmd && !isEdit) return PASS;
  const ti = input.tool_input ?? input.toolInput ?? {};
  const command = String(ti.command ?? '');
  const cwd = input.cwd ?? process.cwd();
  if (!existsSync(join(cwd, '.flow'))) return PASS;

  // C-2：mode 讀取與 reconstruct 同優先序（git-tracked manifest 先、state.json 後）——換機 clone 後 state.json
  // 不存在也讀得到 auto，三道自駕硬擋不再靜默下線（原本只讀 state.json、缺檔即 fail-open exit 0＝護欄全滅）。
  let manifestMode = '';
  try { manifestMode = String(JSON.parse(stripBom(readFileSync(join(cwd, '.flow', 'manifest.json'), 'utf8'))).mode || ''); } catch { /* 無 manifest → 退 state.json */ }
  let state = {};
  try { state = JSON.parse(stripBom(readFileSync(join(cwd, '.flow', 'state.json'), 'utf8'))); } catch { state = {}; }
  const mode = manifestMode || String(state.mode || '');
  if (mode !== 'auto') return PASS;   // 只在自駕模式啟用，manual 不干擾

  // C-5：自駕下編輯相依 manifest＝變更相依（T1）。攔在 PreToolUse，堵「改 package.json 加套件 → bare install 還原」。
  // 純字串偵測抓不到的間接執行（npm run setup / node migrate.mjs）仍留 T1 散文（autonomous-mode.md 誠實標注）。
  if (isEdit) {
    const target = String(ti.file_path ?? ti.filePath ?? '');
    if (!isDepManifest(target)) return PASS;                    // 非相依 manifest 的 Write/Edit → 放行
    // C-5b：能精確解析出本次宣告的相依，且全部命中 policy allowlist（或根本沒宣告相依）→ 放行，與命令列路徑對稱。
    const declared = declaredDeps(ti, target);
    if (declared && !declared.pkgs.length) return PASS;         // 純 metadata 的 package.json（無任何相依欄位）
    if (declared && depAllowed(declared.pkgs, policyAllow(cwd))) {
      await recordDepAllowed(cwd, declared.pkgs, `編輯 ${target.split(/[\/\\]/).pop()}`);
      return PASS;
    }
    return BLOCK(
      `Flow 自駕閘門：偵測到編輯相依 manifest（${target.split(/[\/\\]/).pop()}）——改相依是 T1 必停集合（會影響安裝/供應鏈）。\n` +
      (declared && declared.pkgs.length ? `  本次宣告的相依：${declared.pkgs.join(' ')}（未全部命中 .flow/policy.json 的 deps.allow）\n` : '') +
      '  → 先 AskUserQuestion 同步彈窗問使用者（要動什麼相依、為何），拍板後再改；\n' +
      '  常用可信套件可請使用者拍板加進 .flow/policy.json：{ "deps": { "allow": ["<pkg>", "@scope/*"] } }（支援尾 * 前綴），下次免停。\n' +
      '  或真的卡住：flow-state pending add <id> --why "<需要改的相依與原因>"，收尾一批請使用者拍板。');
  }

  if (isNewDependency(command)) {
    const pkgs = extractDepNames(command);
    if (depAllowed(pkgs, policyAllow(cwd))) await recordDepAllowed(cwd, pkgs, '安裝');
    else return BLOCK(
      'Flow 自駕閘門：裝新相依是 T1 必停集合，自駕下不可靜默裝' + (pkgs.length ? `（${pkgs.join(' ')} 不在 .flow/policy.json 的 deps.allow）` : '') + '。\n' +
      '  → 先 AskUserQuestion 同步彈窗問使用者（白話講要裝什麼套件、為何需要、有無更輕方案），拍板後再裝。\n' +
      '  常用可信套件可請使用者拍板加進 .flow/policy.json：{ "deps": { "allow": ["<pkg>", "@scope/*"] } }（支援尾 * 前綴），下次免停。');
  }
  if (isDestructiveDB(command)) return BLOCK(
    'Flow 自駕閘門：偵測到破壞性 DB 操作（DROP/TRUNCATE / 無 WHERE 的 DELETE/UPDATE），是 T1 必停集合。\n' +
    '  → 先 AskUserQuestion 同步彈窗確認（會毀哪些資料、可否回復、是否真要），拍板後再執行。');

  // doom-loop 硬天花板：軟 STALL 連續被忽略到 hardThreshold → 硬擋下一次同 runner 重跑
  let S;
  try { S = await import('../skills/flow-toolkit/statelib.mjs'); } catch { return PASS; }
  if (S.isRunnerCommand(command)) {
    const bucket = S.runnerBucket(command);
    const soft = Number(state.stallThreshold) > 0 ? Number(state.stallThreshold) : 3;
    const hard = soft + 3;
    const n = S.stallCount(await S.readJournal(cwd), bucket);
    if (n >= hard) return BLOCK(
      `Flow 自駕閘門：同一個失敗（${bucket}）已連續 ${n} 輪、軟 STALL 升級被忽略。硬擋本次重跑。\n` +
      '  → 不准再跑同一條死路。立刻：標 BLOCKED 跳下一個 task，或 AskUserQuestion 同步升級給使用者拍板。');
  }
  return PASS;
}

async function main() {
  let input = {};
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { process.exit(0); }
  let r; try { r = await autoGateCheck(input); } catch { process.exit(0); }   // fail-open
  if (r && r.block) { process.stderr.write(r.message + '\n'); process.exit(2); }
  process.exit(0);
}
