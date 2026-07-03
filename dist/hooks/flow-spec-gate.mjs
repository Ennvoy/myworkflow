#!/usr/bin/env node
// Flow spec/plan 階段閘門的「窗戶感應器」（PreToolUse on Write|Edit|Bash|PowerShell），守兩道後門：
// ① 階段轉移：擋「繞過子命令、直接 raw-edit .flow/state.json 把 phase 寫成 spec-done / plan-done」——
//    正門＝flow-state spec-ready --freeze（凍結）／flow-state plan-check（計畫對賬）。只擋轉移那一刻，已是該 phase 的再存放行。
// ② 機讀 ledger：擋「裸寫/刪除 .flow/{spec-review,trace,verify}/」——正門＝flow-state 各子命令
//    （docHash/reqHash/manifestHash 由 CLI 自算，裸改＝偽造或蒸發對賬證據）。Bash/PS 分讀寫：唯讀/staging 放行。
// 自駕下模型不能靠竄改檔案跳過收斂/對賬檢查（與 done-gate + flow-verify-gate 同 belt-and-suspenders）；
// 非此一律 fail-open exit 0，絕不誤擋非 Flow 專案。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => { try { main(); } catch { process.exit(0); } });

// 內容是否把 phase 設成受守 phase（spec-done / plan-done）——回 phase 名或 null。
const setsGatedPhase = s => { const m = String(s || '').match(/["']?phase["']?\s*[:=]\s*["']?(spec-done|plan-done)\b/i); return m ? m[1].toLowerCase() : null; };
// 目標是否為 .flow/state.json（含 Bash/PS 命令字串內嵌路徑：可在重導/空白/引號後出現）。
// 先把反斜線正規化成正斜線，再要求 .flow 落在路徑邊界（開頭 / 斜線 / 空白 / 引號）。
const targetsState = s => /(^|[\s'"/])\.flow\/state\.json\b/.test(String(s || '').replace(/\\/g, '/'));
// 目標是否落在 CLI-only ledger 目錄（spec-review/trace/verify/code-review，含目錄本體無尾斜線——rm -rf 要擋）：
// hash/終局由 CLI 自算——裸寫/覆寫/刪除＝偽造或蒸發對賬證據，只准走 flow-state 正門。
const targetsLedger = s => /(^|[\s'"/])\.flow\/(spec-review|trace|verify|code-review)(\/|\b)/.test(String(s || '').replace(/\\/g, '/'));
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

  // 第一道：CLI-only ledger（spec-review/trace/verify）竄改/刪除。Write/Edit 本質是寫，命中路徑即擋；
  // Bash/PowerShell 只在有寫入/刪除意圖時擋（唯讀 cat/ls/git add/diff/commit 放行——它們動不了檔案內容，
  // 誤殺會撞 v0.20.0「ledger 進版控」政策與 git-tools 逐檔 staging）。CLI 正門走 fs 內部寫、不經重導，自然放行。
  if (targetsLedger(target)) {
    const isCmd = tool === 'Bash' || tool === 'PowerShell';
    if (isCmd && !hasWriteIntent(content)) process.exit(0);        // 純讀取/staging → 放行
    process.stderr.write([
      'Flow ledger 閘門：禁止裸寫/刪除 .flow/{spec-review,trace,verify,code-review}/（hash/終局由 CLI 自算，裸改＝偽造或蒸發對賬證據）。',
      '  → 收 lens findings：flow-state spec-review …／終局：flow-state review-resolve …',
      '  → 凍結分母：flow-state spec-ready --freeze／計畫對賬：flow-state plan-check',
      '  → REQ-E2E 驗證：flow-state verify-e2e …／效能：flow-state verify-perf …',
      '  → 藍軍 code-review：flow-state review-code …／終局：flow-state code-resolve …',
      '  （唯讀請用 Read 工具；staging 用 git add——它們不動內容，不會被擋。）',
    ].join('\n') + '\n');
    process.exit(2);
  }
  if (!targetsState(target)) process.exit(0);                    // 不是寫 .flow/state.json → 放行
  const phase = setsGatedPhase(content);
  if (!phase) process.exit(0);                                   // 沒要把 phase 設成 spec-done/plan-done → 放行
  // 放行正門：spec-ready（凍結）／plan-check（計畫）子命令內部用 fs 寫，不經工具呼叫；此為防禦性放行
  if ((tool === 'Bash' || tool === 'PowerShell') && /flow-state(\.mjs)?[\s\S]*(spec-ready|plan-check)/i.test(content)) process.exit(0);

  // 已是該 phase 的再存（非轉移）放行——只擋「轉移成該 phase」那一刻
  try {
    const st = JSON.parse(stripBom(readFileSync(join(cwd, '.flow', 'state.json'), 'utf8')));
    if (String(st.phase ?? '').toLowerCase() === phase) process.exit(0);
  } catch { /* 無/壞 state.json：視為尚未轉移，繼續擋這次裸寫轉移 */ }

  const gate = phase === 'spec-done'
    ? ['Flow 凍結閘門：禁止直接寫 phase="spec-done" 繞過需求收斂閘門。',
       '  → 改跑正門：node ~/.claude/skills/flow-toolkit/flow-state.mjs spec-ready --freeze（驗收斂＋lens 對賬通過才凍結）。']
    : ['Flow 計畫閘門：禁止直接寫 phase="plan-done" 繞過計畫對賬。',
       '  → 改跑正門：node ~/.claude/skills/flow-toolkit/flow-state.mjs plan-check（驗 REQ↔task 覆蓋＋tasks.md↔manifest 一致才過）。'];
  process.stderr.write([...gate, '  別手改 state.json 假裝過關（系統性違規）。'].join('\n') + '\n');
  process.exit(2);   // exit 2 → Claude Code 擋下此工具呼叫，把 stderr 餵回模型
}
