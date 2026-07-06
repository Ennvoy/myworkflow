#!/usr/bin/env node
// Flow Stop 閘門（W3-5）：自駕收工攔截——mode=auto、tasks.md 全 [x]、卻沒有「當前 HEAD 的
// complete-check 通過記錄」→ exit 2 擋收工（堵「模型自報全中、沒跑完成謂詞就結束回合」）。
// 窄觸發防誤擋：還有未完成 [ ]（mid-run／T1 停等）一律放行；讀檔任何錯一律放行（fail-open）；只在 mode=auto 生效。
// 逃生口：跑 flow-state complete-check（過了自然放行）或 flow-state mode manual（退出自駕）。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => { try { main(); } catch { process.exit(0); } });

function main() {
  let input = {};
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { process.exit(0); }
  if (input.stop_hook_active) process.exit(0);            // 已因 Stop hook 續跑過一輪 → 不遞迴再擋
  const cwd = input.cwd ?? process.cwd();
  const fd = join(cwd, '.flow');
  if (!existsSync(fd)) process.exit(0);
  let state = {};
  try { state = JSON.parse(stripBom(readFileSync(join(fd, 'state.json'), 'utf8'))); } catch { process.exit(0); }
  if (String(state.mode || '') !== 'auto') process.exit(0);
  const tp = join(cwd, 'specs', 'tasks.md');
  if (!existsSync(tp)) process.exit(0);
  let md = '';
  try { md = readFileSync(tp, 'utf8'); } catch { process.exit(0); }
  if ((md.match(/^\s*[-*]\s*\[ \]/gm) || []).length > 0) process.exit(0);   // mid-run（含 T1 停等）不干擾
  if (!(md.match(/^\s*[-*]\s*\[x\]/gim) || []).length) process.exit(0);     // 沒任何 task 的空專案不管
  let cc = null;
  try { cc = JSON.parse(stripBom(readFileSync(join(fd, 'trace', 'complete-check.json'), 'utf8'))); } catch { cc = null; }
  let head = '';
  try { head = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { head = ''; }
  if (cc && (!cc.head || !head || cc.head === head)) process.exit(0);       // 已過完成謂詞（同 HEAD 或無從比對）→ 放行
  process.stderr.write(
    'Flow 自駕收工閘門：tasks 全 [x] 但尚未（在當前 HEAD）通過 flow-state complete-check——別在完成謂詞驗證前收工。\n' +
    '  → 跑 flow-state complete-check（REQ-E2E/PERF/code-review/journey 逐條對賬，通過會落機讀記錄）；\n' +
    '    真要暫停自駕：flow-state mode manual。\n');
  process.exit(2);
}
