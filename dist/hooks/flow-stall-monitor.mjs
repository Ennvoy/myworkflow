#!/usr/bin/env node
// Flow stall 斷路器（PostToolUse on Bash|PowerShell）。
// 自駕模式無花費上限時的防失控底線：偵測「同一個 runner（test/build/lint）失敗連續 N 輪、改動無效」的 doom loop。
//
// 定位（誠實）：偵測「優先用 runner 真實 exit code，無則 best-effort 掃失敗標記」；分桶 key 用 runnerBucket(命令)
// （不靠 state.task——生產不寫該欄），同一條測試的連續失敗自然同桶、不同測試自然分桶、cwd 隔離專案。
// 成功（exit 0）記 sig='ok' 重置該 bucket 連敗。回應是「強制注入升級指令」(additionalContext)、非 exit-2 牆
// （verify 由模型驅動、stall 在標 done 之前，沒有單一可擋的工具呼叫；硬天花板由 flow-auto-gate 的 PreToolUse 補）。
//
// 一律 fail-open：任何錯/非 Flow 專案/非 runner/判不出失敗 → 靜默放行，絕不擋使用者。
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.exitCode = 0; });   // stream error 也不炸
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => { main().catch(() => { process.exitCode = 0; }); });

// 從 tool_output/tool_response 萃取 {failed, exit, text}。優先數值 exit code；無則保守掃失敗標記（需強標記或明確失敗計數>0、排除 0 failed）。
function extractFailure(tr) {
  if (tr == null) return { failed: false, exit: 0, text: '' };
  if (typeof tr === 'string') tr = { stdout: tr };
  let exit = null;
  for (const f of ['exit_code', 'exitCode', 'code', 'returncode', 'exit', 'status']) {
    if (typeof tr[f] === 'number') { exit = tr[f]; break; }
  }
  const text = [tr.stderr, tr.stdout, tr.output, tr.content, tr.result, tr.error]
    .filter(s => typeof s === 'string').join('\n');
  let failed;
  if (exit !== null) {
    failed = exit !== 0;
  } else {
    // 大寫 FAILED＝pytest/CI 的狀態標記（真失敗）；小寫 "0 failed" 是摘要計數、由 countFail/zeroFail 處理，不算 strong。
    const strong = /\bFAILED\b/.test(text) || /(Traceback|AssertionError|\w+Error\b|✗|✘|\bnot ok\b|panic:)/i.test(text);
    const countFail = /\b[1-9]\d*\s+(failed|errors?|failures?)\b/i.test(text);   // 明確失敗計數 >0
    const zeroFail = /\b0\s+(failed|errors?|failures?)\b/i.test(text);          // 0 failed/errors → 視為綠
    // C-13：strong 標記（Traceback/AssertionError/panic…）不得被 "0 failed" 覆蓋——編譯失敗時測試框架仍可能印
    // "0 failed"，或模型手動印一行 "0 failed" 洗白；strong 命中一律算失敗，只有純 countFail 才受 zeroFail 抵銷。
    failed = strong || (countFail && !zeroFail);
  }
  return { failed, exit: exit === null ? 1 : exit, text };
}

async function main() {
  let input = {};
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { return; }

  const tool = input.tool_name ?? input.toolName ?? '';
  if (tool !== 'Bash' && tool !== 'PowerShell') return;
  const ti = input.tool_input ?? input.toolInput ?? {};
  const command = String(ti.command ?? '');

  // C-9：cwd＋.flow 存在性早退搬到 import statelib（120KB）之前——非 Flow 專案的每次 Bash/PowerShell
  // 都不再白繳這支模組的載入稅。純 fs 判斷、零成本，比 import 便宜太多，理當先跑。
  const cwd = input.cwd ?? process.cwd();
  if (!existsSync(join(cwd, '.flow'))) return;              // 非 Flow 專案 → 不污染

  let S;
  try { S = await import('../skills/flow-toolkit/statelib.mjs'); } catch { return; }  // 缺檔/壞檔 → fail-open
  // C-13：test/build runner，或連紅的 flow-state 閘門子命令（後者只軟提醒、不進 auto-gate 硬天花板）→ 都納入 doom-loop 偵測
  if (!S.isRunnerCommand(command) && !S.isGateThrash(command)) return;

  const bucket = S.runnerBucket(command);

  const { failed, exit, text } = extractFailure(input.tool_output ?? input.tool_response ?? input.toolOutput ?? input.toolResponse);
  if (!failed) { await S.recordVerifyAttempt(cwd, bucket, 'ok', 0); return; }   // 成功 → 記 ok 重置連敗

  const state = await S.readStateJson(cwd);
  const threshold = Number(state.stallThreshold) > 0 ? Number(state.stallThreshold) : 3;
  const sig = S.verifyFailSig(command, text);
  await S.recordVerifyAttempt(cwd, bucket, sig, exit);
  const n = S.stallCount(await S.readJournal(cwd), bucket);
  if (n < threshold) return;

  const msg = [
    `⚠ STALL 偵測（doom-loop 斷路器）：對**同一個失敗**（${bucket}）已連續試了 ${n} 輪、改動無效。`,
    '卡住時多迴圈是負生產力（SWE-Marathon：run-length 越長 pass rate 越崩）。**停手，別再重跑同一條路。**',
    '自駕模式下這是**必要分歧**——立刻照下列其一處理：',
    '  1) 換一條本質不同的 approach（不是微調），並 `flow-state lesson <id> --approach "<試過>" --why "<為何失敗>"` 記下。',
    '  2) 真依賴未 ready / 無解 → 標 BLOCKED，跳下一個 task。',
    '  3) 需要使用者拍板 → 立刻 AskUserQuestion 同步升級（白話講卡在哪、試過什麼、要他決定什麼）。',
    '  4) 照 references/debugging-playbook.md 的除錯紀律系統化排查（先建 tight feedback loop、列 3-5 個可證偽假說再動手，禁盲猜連試）。',
    `（連續忽略到 ${threshold + 3} 輪，flow-auto-gate 會在下一次同 runner 的 PreToolUse 硬擋。）`,
  ].join('\n');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
  }));
  // 不呼叫 process.exit——讓 stdout 自然 flush 後事件迴圈結束（避免截斷注入）。exitCode 預設 0。
}
