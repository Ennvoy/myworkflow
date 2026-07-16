#!/usr/bin/env node
// Flow deterministic gate (PreToolUse on Bash/PowerShell) — 攔 `git commit`，三道確定性閘門：
//   閘門〇「secrets 不進歷史」：staged 含 .env/私鑰類檔案 → 擋下，先移出 staging＋補 .gitignore。
//   閘門一「先清、再 commit」：staged 含驗證垃圾（含 .playwright-mcp 的 MCP 殘留）→ 擋下，先跑 clean script。
//   閘門二「先標、再 commit」：commit message 點名某 flow task，但它在 .flow/ledger 還不是 delivered → 擋下。
//   `--amend` 不豁免：閘門〇/一照常；閘門二看「有無解析到新訊息」——純 --no-edit amend 訊息為空自然放行。
//   訊息解析含 PowerShell here-string（@'…'@ / @"…"@，Windows 多行 commit message 主形）。
// W3-3：三道判定抽進 commit-gate-core（與 git 原生 pre-commit hook 共用單一事實來源）；本 hook 負責解析
//   command/msg + 呼叫 core，另補「模型端 --no-verify / -c core.hooksPath」兩條 regex（堵模型在命令列繞過 pre-commit 兜底）。
// 設計鐵則：fail-open（解析不出 / 非 flow 專案 / 非 git commit / git 或 import 失敗 → 一律放行，絕不誤擋）。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as core from './commit-gate-core.mjs';

const exit0 = () => process.exit(0);
function stripBom(s) { return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; }

// C-3①：本 gate 邏輯抽成 commitGateCheck(input) → { block, message }，供 flow-dispatch 合併呼叫；保留獨立 stdin 入口可單跑。
const PASS = { block: false };
const BLOCK = msg => ({ block: true, message: msg });

// C-3①：只有直接執行本檔時才掛 stdin/跑（被 dispatch import 時不可自動跑，否則會搶先 exit 短路 dispatcher）。
let raw = '';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', async () => {
    let input;
    try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { return exit0(); }
    let r; try { r = await commitGateCheck(input); } catch { return exit0(); }   // fail-open
    if (r && r.block) { process.stderr.write(r.message + '\n'); process.exit(2); }
    exit0();
  });
}

// 純判定（不碰 exit/stderr）。呼叫端負責 fail-open（try-catch）與輸出。
export async function commitGateCheck(input) {
  const tool = input.tool_name ?? input.toolName ?? '';
  if (tool !== 'Bash' && tool !== 'PowerShell') return PASS;
  const ti = input.tool_input ?? input.toolInput ?? {};
  const cmd = String(ti.command ?? '');
  // 只攔真正的 commit；放行非 commit / 唯讀 git（--amend 不豁免，見檔頭）。
  if (!/\bgit\b[^\n]*\bcommit\b/.test(cmd)) return PASS;

  const cwd = input.cwd ?? process.cwd();
  if (!existsSync(join(cwd, '.flow'))) return PASS; // 非 flow 專案

  // ── W3-3：模型端補堵「繞過 git pre-commit 兜底」的旗標 ──
  // 只挖「-m/-F 的值」（含 here-string 與雙引號轉義），再去掉殘餘引號「字元」（非內容）：
  // C-6：-m\s* 而非 \s+——同時吃緊湊寫法 `-m"msg"`/`-mmsg`（無空白），否則訊息不被挖除＝假阻擋，或 task id 不被抽出＝繞過「先標再 commit」。
  //   ① message 內文含 --no-verify 隨值挖掉＝不誤擋；② 被引號包的旗標（git commit "--no-verify"）去引號後仍測得到＝不漏擋。
  // git 原生 pre-commit 是兜底，模型若在命令列直接 --no-verify/-n 或改向 core.hooksPath 就繞過它——對模型明確擋。
  // （人自己在終端機打的不過本 hook → --no-verify 對人仍是 documented 逃生門、reflog 可稽核。）
  const cmdFlags = cmd
    .replace(/-m\s*@(['"])[\s\S]*?\1@/g, ' ')                 // PowerShell here-string message
    .replace(/-m\s*"(?:\\.|[^"\\])*"/g, ' ')                  // 雙引號 message（吞轉義 \" 不提前收尾）
    .replace(/-m\s*'[^']*'/g, ' ')                            // 單引號 message（POSIX 無轉義）
    .replace(/-F\s+\S+/g, ' ')                                // -F <file>
    .replace(/['"]/g, ' ');                                   // 去殘餘引號字元（"--no-verify" → --no-verify）
  // --no-verify（含短式 -n 與 bundle 含 n，如 -an）＋改向 core.hooksPath（-c 旗標形／大小寫不敏感／git config 子命令形持久改向）
  const noVerify = /(^|\s)--no-verify(\s|$)/.test(cmdFlags) || /(^|\s)-[a-z]*n[a-z]*(\s|$)/.test(cmdFlags);
  const hooksPathBypass = /-c\s+core\.hooksPath\b/i.test(cmdFlags) || /\bconfig\b[^\n]*\bcore\.hooksPath\b/i.test(cmdFlags);
  if (noVerify || hooksPathBypass) {
    return BLOCK([
      'Flow commit gate：擋下 commit —— 命令帶了 --no-verify/-n 或改向 core.hooksPath（會繞過 git pre-commit 兜底）。',
      '  Flow 的 secrets/驗證垃圾防護要靠 pre-commit 兜住整批繞法，別在自動流程裡關掉它（-n 是 --no-verify 短式、git config core.hooksPath 持久改向同理）。',
      '  真有正當理由跳過（例如 hook 本身壞了）→ 回報使用者由人拍板，別自行繞過。',
    ].join('\n'));
  }

  // ── 三道閘門（判定在 commit-gate-core，與 flow-precommit.mjs 共用）──
  const staged = core.stagedFiles(cwd); // 取一次，閘門〇/一共用；取不到＝null＝兩道 fail-open
  const secret = core.secretsReason(cwd, staged);
  if (secret) return BLOCK(secret);
  const artifact = await core.artifactsReason(cwd, staged);
  if (artifact) return BLOCK(artifact);

  // 閘門二取 commit 訊息：PowerShell here-string @'…'@/@"…"@、-m "..."/'...'、或 -F <file>。取不到就 fail-open。
  let msg = '';
  for (const m of cmd.matchAll(/-m\s*@(['"])([\s\S]*?)\1@/g)) msg += ' ' + m[2];
  for (const m of cmd.matchAll(/-m\s*("([^"]*)"|'([^']*)'|((?!@)\S+))/g)) msg += ' ' + (m[2] ?? m[3] ?? m[4] ?? ''); // (?!@)：不重吃 here-string 殘渣
  const fm = cmd.match(/-F\s+("([^"]*)"|'([^']*)'|(\S+))/);
  if (fm) { const f = fm[2] ?? fm[3] ?? fm[4]; try { msg += ' ' + readFileSync(f, 'utf8'); } catch { /* 讀不到 -F 檔 → 略過 */ } }
  const task = await core.taskDeliveredReason(cwd, msg);
  if (task) return BLOCK(task);
  return PASS;
}
