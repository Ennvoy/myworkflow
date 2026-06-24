#!/usr/bin/env node
// Flow 自駕硬閘門（PreToolUse on Bash|PowerShell）。**僅 state.json mode==='auto' 時啟用**，manual 一律放行。
// 把自駕 T1 必停集合的「可機檢子集」從散文升成 exit-2 閘門（與 commit-gate/done-gate 同風格、模型不能滑過）：
//   ① 裝新相依（npm/pnpm/yarn/bun add|install <pkg>、pip install <pkg>、cargo add、go get、gem install）
//   ② 破壞性 DB（DROP/TRUNCATE、無 WHERE 的 DELETE/UPDATE）
//   ③ doom-loop 硬天花板：同一 runner 失敗連 ≥ hardThreshold（軟 STALL 被忽略太久）→ 硬擋下一次同 runner 重跑
// 語義型 T1（需求骨架誤判 / 安全紅旗）本質是語義判斷，做不成確定性閘門，留散文（autonomous-mode.md 已誠實標注）。
// 一律 fail-open：任何錯 / 非 Flow / 非 auto → exit 0 放行，絕不誤擋。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => { main().catch(() => process.exit(0)); });

// 裝新相依（排除 bare install/ci 還原 lockfile）。
function isNewDependency(s) {
  if (/\bpip3?\s+install\s+[^\s\-]/i.test(s)) return true;
  if (/\bcargo\s+add\s+\S/i.test(s)) return true;
  if (/\bgo\s+get\s+\S/i.test(s)) return true;
  if (/\bgem\s+install\s+\S/i.test(s)) return true;
  if (/\b(poetry|composer)\s+(add|require)\s+\S/i.test(s)) return true;
  const m = s.match(/\b(npm|pnpm|yarn|bun)\s+(add|install|i)\b(.*)$/i);
  if (m) {
    const args = (m[3] || '').trim().split(/\s+/).filter(Boolean).filter(t => !t.startsWith('-'));
    if (/^add$/i.test(m[2])) return true;          // add 一定是加相依
    return args.length > 0;                        // install/i 帶套件名＝新相依；bare＝還原 lockfile（放行）
  }
  return false;
}

// 破壞性 DB（命令列內嵌 SQL；best-effort）。
function isDestructiveDB(s) {
  if (/\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX)|TRUNCATE\b)/i.test(s)) return true;
  if (/\bDELETE\s+FROM\b/i.test(s) && !/\bWHERE\b/i.test(s)) return true;
  if (/\bUPDATE\s+\S+\s+SET\b/i.test(s) && !/\bWHERE\b/i.test(s)) return true;
  return false;
}

function block(msg) { process.stderr.write(msg + '\n'); process.exit(2); }

async function main() {
  let input = {};
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { process.exit(0); }
  const tool = input.tool_name ?? input.toolName ?? '';
  if (tool !== 'Bash' && tool !== 'PowerShell') process.exit(0);
  const command = String((input.tool_input ?? input.toolInput ?? {}).command ?? '');
  const cwd = input.cwd ?? process.cwd();
  if (!existsSync(join(cwd, '.flow'))) process.exit(0);

  let state = {};
  try { state = JSON.parse(stripBom(readFileSync(join(cwd, '.flow', 'state.json'), 'utf8'))); } catch { process.exit(0); }
  if (String(state.mode || '') !== 'auto') process.exit(0);   // 只在自駕模式啟用，manual 不干擾

  if (isNewDependency(command)) block(
    'Flow 自駕閘門：裝新相依是 T1 必停集合，自駕下不可靜默裝。\n' +
    '  → 先 AskUserQuestion 同步彈窗問使用者（白話講要裝什麼套件、為何需要、有無更輕方案），拍板後再裝。');
  if (isDestructiveDB(command)) block(
    'Flow 自駕閘門：偵測到破壞性 DB 操作（DROP/TRUNCATE / 無 WHERE 的 DELETE/UPDATE），是 T1 必停集合。\n' +
    '  → 先 AskUserQuestion 同步彈窗確認（會毀哪些資料、可否回復、是否真要），拍板後再執行。');

  // doom-loop 硬天花板：軟 STALL 連續被忽略到 hardThreshold → 硬擋下一次同 runner 重跑
  let S;
  try { S = await import('../skills/flow-toolkit/statelib.mjs'); } catch { process.exit(0); }
  if (S.isRunnerCommand(command)) {
    const bucket = S.runnerBucket(command);
    const soft = Number(state.stallThreshold) > 0 ? Number(state.stallThreshold) : 3;
    const hard = soft + 3;
    const n = S.stallCount(await S.readJournal(cwd), bucket);
    if (n >= hard) block(
      `Flow 自駕閘門：同一個失敗（${bucket}）已連續 ${n} 輪、軟 STALL 升級被忽略。硬擋本次重跑。\n` +
      '  → 不准再跑同一條死路。立刻：標 BLOCKED 跳下一個 task，或 AskUserQuestion 同步升級給使用者拍板。');
  }
  process.exit(0);
}
