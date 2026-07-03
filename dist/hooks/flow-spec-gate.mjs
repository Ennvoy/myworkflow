#!/usr/bin/env node
// Flow spec 階段閘門的「窗戶感應器」（PreToolUse on Write|Edit|Bash|PowerShell），守兩道後門：
// ① 凍結轉移：擋「繞過子命令、直接 raw-edit .flow/state.json 把 phase 寫成 spec-done」——正門＝
//    flow-state spec-ready --freeze（先驗收斂＋lens 對賬，通過才寫 phase）。只擋轉移那一刻，已凍結的再存放行。
// ② 審查 ledger：擋「裸寫/刪除 .flow/spec-review/」——正門＝flow-state spec-review / review-resolve
//    （docHash 由 CLI 收檔時自算，裸改＝偽造或蒸發「審過哪版文字」）。Bash/PS 分讀寫：唯讀/staging 放行。
// 自駕下模型不能靠竄改檔案跳過收斂檢查（與 done-gate + flow-verify-gate 同 belt-and-suspenders）；
// 非此一律 fail-open exit 0，絕不誤擋非 Flow 專案。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => { try { main(); } catch { process.exit(0); } });

// 內容是否把 phase 設成 spec-done（JSON "phase":"spec-done" 或散式 phase=spec-done）。
const setsSpecDone = s => /["']?phase["']?\s*[:=]\s*["']?spec-done\b/i.test(String(s || ''));
// 目標是否為 .flow/state.json（含 Bash/PS 命令字串內嵌路徑：可在重導/空白/引號後出現）。
// 先把反斜線正規化成正斜線，再要求 .flow 落在路徑邊界（開頭 / 斜線 / 空白 / 引號）。
const targetsState = s => /(^|[\s'"/])\.flow\/state\.json\b/.test(String(s || '').replace(/\\/g, '/'));
// 目標是否落在 .flow/spec-review/（含目錄本體，無尾斜線也算——rm -rf .flow/spec-review 要擋）：
// docHash 由 flow-state CLI 收檔時自算——裸寫/覆寫/刪除＝偽造或蒸發「審過哪版文字」，只准走 CLI 正門。
const targetsSpecReview = s => /(^|[\s'"/])\.flow\/spec-review(\/|\b)/.test(String(s || '').replace(/\\/g, '/'));
// Bash/PowerShell 命令是否對檔案有「寫入/建立/刪除」意圖（唯讀 cat/ls/jq/git add/diff/commit 不算——
// 裸寫防的是竄改檔案內容，讀與 staging 動不了內容；CLI 正門走 fs 內部寫、命令字串不含重導進該目錄）。
const hasWriteIntent = s => /(^|[^0-9])>>?|\btee\b|\bSet-Content\b|\bOut-File\b|\bAdd-Content\b|\bNew-Item\b|\b(cp|mv|rm|rmdir|touch)\b|\b(Copy-Item|Move-Item|Remove-Item)\b|\bdel\b|\bsed\s+-i/i.test(String(s || ''));

function main() {
  let input = {};
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { process.exit(0); }
  const tool = input.tool_name ?? input.toolName ?? '';
  if (tool !== 'Write' && tool !== 'Edit' && tool !== 'Bash' && tool !== 'PowerShell') process.exit(0);
  const ti = input.tool_input ?? input.toolInput ?? {};
  const cwd = input.cwd ?? process.cwd();
  if (!existsSync(join(cwd, '.flow'))) process.exit(0);          // 非 Flow 專案 → 不干擾

  // 取「這次工具呼叫要寫什麼、寫去哪」
  let target = '', content = '';
  if (tool === 'Write') { target = String(ti.file_path ?? ti.filePath ?? ''); content = String(ti.content ?? ''); }
  else if (tool === 'Edit') { target = String(ti.file_path ?? ti.filePath ?? ''); content = String(ti.new_string ?? ti.newString ?? ''); }
  else { content = String(ti.command ?? ''); target = content; }  // Bash/PowerShell：命令字串同時當目標與內容

  // 第一道：spec-review ledger 竄改/刪除。Write/Edit 工具本質是寫，命中路徑即擋；
  // Bash/PowerShell 只在有寫入/刪除意圖時擋（唯讀 cat/ls/git add/diff/commit 放行——它們動不了檔案內容，
  // 誤殺會撞 v0.20.0「ledger 進版控」政策與 git-tools 逐檔 staging）。CLI 正門走 fs 內部寫、不經重導，自然放行。
  if (targetsSpecReview(target)) {
    const isCmd = tool === 'Bash' || tool === 'PowerShell';
    if (isCmd && !hasWriteIntent(content)) process.exit(0);        // 純讀取/staging → 放行
    process.stderr.write([
      'Flow 審查 ledger 閘門：禁止裸寫/刪除 .flow/spec-review/（docHash 由 CLI 收檔時自算，裸改＝偽造或蒸發「審過哪版文字」）。',
      '  → 收一輪 lens findings：node ~/.claude/skills/flow-toolkit/flow-state.mjs spec-review <redteam|consistency|codex> --file <findings.json>',
      '  → 終局一條 finding：flow-state review-resolve <SR-id> --as <resolved:REQ-xxx|open|deferred:<id>|rejected:<id>>',
      '  （唯讀請用 Read 工具；staging 用 git add；歸檔舊輪不需要——freeze 只認最後一次凍結後的輪。）',
    ].join('\n') + '\n');
    process.exit(2);
  }
  if (!targetsState(target)) process.exit(0);                    // 不是寫 .flow/state.json → 放行
  if (!setsSpecDone(content)) process.exit(0);                   // 沒要把 phase 設成 spec-done → 放行
  // 放行正門：命令是 flow-state spec-ready（子命令內部用 fs 寫，不經工具呼叫；此為防禦性放行）
  if ((tool === 'Bash' || tool === 'PowerShell') && /flow-state(\.mjs)?[\s\S]*spec-ready/i.test(content)) process.exit(0);

  // 已是 spec-done 的再存（非轉移）放行——只擋「轉移成 spec-done」那一刻
  try {
    const st = JSON.parse(stripBom(readFileSync(join(cwd, '.flow', 'state.json'), 'utf8')));
    if (String(st.phase ?? '') === 'spec-done') process.exit(0);
  } catch { /* 無/壞 state.json：視為尚未凍結，繼續擋這次裸寫轉移 */ }

  process.stderr.write([
    'Flow 凍結閘門：禁止直接寫 phase="spec-done" 繞過需求收斂閘門。',
    '  → 改跑正門：node ~/.claude/skills/flow-toolkit/flow-state.mjs spec-ready --freeze',
    '     （會先驗 specs/requirements.md 的 ### 開放問題 清零 + REQ-E2E-/REQ-PERF- 齊，通過才凍結）。',
    '  別手改 state.json 假裝凍結（系統性違規）；沒問乾淨就把開放問題問到拍板（彈窗）再凍結。',
  ].join('\n') + '\n');
  process.exit(2);   // exit 2 → Claude Code 擋下此工具呼叫，把 stderr 餵回模型
}
