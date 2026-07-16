#!/usr/bin/env node
// flow-dispatch.mjs — C-3① 安檢門四合一：把三道同 matcher（PreToolUse on Write|Edit|Bash|PowerShell）的 exit-2 閘門
//   commit-gate / auto-gate / spec-gate 合併成「一次 node 冷啟」跑完，省掉每個工具呼叫 spawn 3 支獨立 node 的冷啟稅
//   （Windows 防毒掃 node 病理下尤重）。讀 stdin 一次、依序判定；任一道 block → stderr + exit 2；全放行 → exit 0。
// 設計鐵則：**逐道 fail-open**——某道 import/判定丟例外一律當「該道放行」，絕不因一道壞了就誤擋（也不因它壞了就靜默關掉其他道）。
//   各道邏輯仍留在原檔（flow-{commit,auto,spec}-gate.mjs 各自 export check(input) 並保留獨立 main 可單跑/單測）；
//   本檔只是編排。接線完整性（本檔真的引用三道）由 flow-session-start 的 dispatchWiringProblems 對賬，防「合併後漏掉一道＝靜默失效」。
import { commitGateCheck } from './flow-commit-gate.mjs';
import { autoGateCheck } from './flow-auto-gate.mjs';
import { specGateCheck } from './flow-spec-gate.mjs';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => { main().catch(() => process.exit(0)); });

async function main() {
  let input = {};
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { process.exit(0); }
  // 逐道跑，第一個 block 即擋（各道自 try-catch fail-open，一道壞了不影響其他道）。
  for (const check of [commitGateCheck, autoGateCheck, specGateCheck]) {
    let r = null;
    try { r = await check(input); } catch { r = null; }   // 該道 fail-open
    if (r && r.block) { process.stderr.write(String(r.message || '') + '\n'); process.exit(2); }
  }
  process.exit(0);
}
