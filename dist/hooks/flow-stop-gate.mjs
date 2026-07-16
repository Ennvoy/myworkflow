#!/usr/bin/env node
// Flow Stop 閘門（W3-5 / C-1 / C-2）：自駕收工攔截，兩道守：
//   (A) C-1 靜默斷氣：mode=auto 還有「可推進」的 task（依賴已滿足、非 needs-decision、無待決單）卻要結束回合
//       → exit 2 擋下。堵「模型疲乏 / context 結束 / 錯誤提早收工」這個整夜自駕最高頻的無聲失敗型態。
//   (B) W3-5 完成謂詞：tasks.md 全 [x] 但沒有「當前 HEAD 的 complete-check 通過記錄」→ exit 2。
// 窄觸發防誤擋：無可推進 task 且仍有未完成 [ ]（全待決/needs-decision，合法停等）一律放行；讀檔/reconstruct 任何錯放行
// （fail-open）；只在 mode=auto 生效。逃生口：flow-state complete-check（過了放行）/ pending add（記待決）/ mode manual。
// C-2：mode 讀取優先 git-tracked manifest（換機 clone 後 state.json 不存在也判得出 auto，護欄不靜默下線）。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
function readMode(fd) {
  let m = '';
  try { m = String(JSON.parse(stripBom(readFileSync(join(fd, 'manifest.json'), 'utf8'))).mode || ''); } catch { /* 退 state.json */ }
  if (!m) { try { m = String(JSON.parse(stripBom(readFileSync(join(fd, 'state.json'), 'utf8'))).mode || ''); } catch { /* 無 → '' */ } }
  return m;
}
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => { main().catch(() => process.exit(0)); });

async function main() {
  let input = {};
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { process.exit(0); }
  if (input.stop_hook_active) process.exit(0);            // 已因 Stop hook 續跑過一輪 → 不遞迴再擋
  const cwd = input.cwd ?? process.cwd();
  const fd = join(cwd, '.flow');
  if (!existsSync(fd)) process.exit(0);
  if (readMode(fd) !== 'auto') process.exit(0);
  // (A) C-1：自駕還有可推進的 task 卻要收工＝疑似靜默斷氣 → 擋下（needs-decision / 有待決單 / 依賴未滿足不算可推進）。
  try {
    const S = await import('../skills/flow-toolkit/statelib.mjs');
    const view = await S.reconstruct(cwd);
    const pendingIds = (await S.listPending(cwd)).map(p => p.id);
    const next = S.pickNext(view, pendingIds);
    if (next) {
      process.stderr.write(
        `Flow 自駕收工閘門：還有可推進的 task（${next.id}）卻要結束回合——自駕不該在有事可做時停。\n` +
        '  → 繼續推進；真的卡住：flow-state pending add <id> --why "<為何過不了>"（記待決單、繼續其他工作，收尾一批問使用者），\n' +
        '    需要使用者拍板才動的：標 needs-decision；要退出自駕：flow-state mode manual。\n');
      process.exit(2);
    }
  } catch { /* reconstruct/import 失敗 → 退回原完成謂詞判定（fail-open） */ }
  const tp = join(cwd, 'specs', 'tasks.md');
  if (!existsSync(tp)) process.exit(0);
  let md = '';
  try { md = readFileSync(tp, 'utf8'); } catch { process.exit(0); }
  if ((md.match(/^\s*[-*]\s*\[ \]/gm) || []).length > 0) process.exit(0);   // 無可推進、仍有 [ ]（全待決/needs-decision）→ 放行收尾
  if (!(md.match(/^\s*[-*]\s*\[x\]/gim) || []).length) process.exit(0);     // 沒任何 task 的空專案不管
  let cc = null;
  try { cc = JSON.parse(stripBom(readFileSync(join(fd, 'trace', 'complete-check.json'), 'utf8'))); } catch { cc = null; }
  let head = '';
  try { head = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { head = ''; }
  // C-1（GM-g8-001）：git 可用（head 非空）時，SHALL 有「同 HEAD」的通過記錄才放行——cc.head 為空/不符即擋，
  // 堵「寫一筆不含 head 的 complete-check.json 冒充通過」。非 git 目錄（head 空）維持 fail-open（拿不到就不苛求）。
  if (cc && (!head || (cc.head && cc.head === head))) process.exit(0);
  process.stderr.write(
    'Flow 自駕收工閘門：tasks 全 [x] 但尚未（在當前 HEAD）通過 flow-state complete-check——別在完成謂詞驗證前收工。\n' +
    '  → 跑 flow-state complete-check（REQ-E2E/PERF/code-review/journey 逐條對賬，通過會落機讀記錄）；\n' +
    '    真要暫停自駕：flow-state mode manual。\n');
  process.exit(2);
}
