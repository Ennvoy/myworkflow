#!/usr/bin/env node
// Flow SDD 檔案膨脹偵測 hook（SessionStart + UserPromptSubmit）。
// 唯讀、確定性：只 statSync 量 specs/ 的 .md 檔大小（不讀內容），
// 任一超過門檻就注入「該 /flow-compact 歸檔」提醒給模型，由模型語意歸檔（hook 喚不動模型、不能自己跑 skill）。
// No-op 非 Flow 專案。任何錯誤一律 exit 0 放行（絕不擋使用者）。
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const THRESHOLD = 50 * 1024;          // 單檔 >50KB 視為膨脹（對齊 flow-compact.md size 觸發）
const REGROW = 8 * 1024;              // UserPromptSubmit 節流：較上次提醒再長 >8KB 才重提（避免每則訊息洗版）
const SPEC_DIRS = ['specs', '.sdd'];  // 標準 flow 用 specs/；容錯也看 .sdd/（若存在）

function stripBom(s) { return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; }
const kb = b => (b / 1024).toFixed(0);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => {
  try { main(); } catch { /* 絕不擋使用者 */ }
  process.exit(0);
});

function main() {
  let input = {};
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch {}
  const cwd = input.cwd || process.cwd();
  const event = input.hook_event_name || 'SessionStart';

  // 只在 Flow 專案動作（有 specs/ 或 .flow/）
  if (!existsSync(join(cwd, 'specs')) && !existsSync(join(cwd, '.flow'))) return;

  // 收集 specs 目錄下的 .md（不遞迴進 archive/，那本來就是歸檔目的地）
  const over = [];
  let maxBytes = 0;
  for (const sd of SPEC_DIRS) {
    const dir = join(cwd, sd);
    if (!existsSync(dir)) continue;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      let bytes = 0;
      try { bytes = statSync(join(dir, e.name)).size; } catch { continue; }
      if (bytes > maxBytes) maxBytes = bytes;
      if (bytes > THRESHOLD) over.push({ name: `${sd}/${e.name}`, bytes });
    }
  }
  if (!over.length) return;

  // UserPromptSubmit 節流：每則訊息都跑，但只在「跨過門檻」或「又長大一截」時才提醒。
  // SessionStart 一律提醒一次（新 session 起點，有用），並刷新 marker。
  const markerPath = join(cwd, '.flow', 'size-reminded');
  if (event === 'UserPromptSubmit') {
    let last = 0;
    try { if (existsSync(markerPath)) last = parseInt(stripBom(readFileSync(markerPath, 'utf8')).trim(), 10) || 0; } catch {}
    if (last > 0 && maxBytes <= last + REGROW) return;   // 沒長大多少 → 這則不洗版
  }
  try {
    if (existsSync(join(cwd, '.flow'))) writeFileSync(markerPath, String(maxBytes), 'utf8');
  } catch {}

  over.sort((a, b) => b.bytes - a.bytes);
  const lines = [
    '# Flow SDD 檔案膨脹提醒（確定性偵測，依檔案大小）',
    `下列 specs 檔已超過 ${kb(THRESHOLD)}KB，長流程讀取會稀釋注意力：`,
    ...over.map(f => `- ${f.name}：${kb(f.bytes)}KB ⚠️`),
    '→ 建議跑 `/flow-compact`：把「已交付 task 細節 / 已實作章節」歸檔到 `specs/archive/`（move 不刪、可回溯），',
    '  **接縫契約 / 未完成 REQ / open questions 一律留主檔**。可直接請我幫你執行收束。',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: lines },
  }));
}
