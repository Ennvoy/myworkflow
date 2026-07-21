#!/usr/bin/env node
// Flow SDD 檔案膨脹偵測 hook（SessionStart + PostToolUse Write|Edit；A6 移除 UserPromptSubmit 掛點，
// 事件分支保留＝舊接線殘留時行為不變）。唯讀、確定性、非阻擋。
// 判據：SDD 檔膨脹——statSync 量 specs/*.md，任一 >50KB（抓「文件越寫越長」），命中就注入
//       「該 /flow-compact」提醒（hook 喚不動模型、由模型語意收束）。
// No-op 非 Flow 專案。任何錯一律 exit 0 放行（絕不擋使用者）。**絕不 exit 2**（過早 compact 丟脈絡比晚收束更糟）。
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SIZE_THRESHOLD = 50 * 1024;     // 單檔 >50KB 視為膨脹（對齊 flow-compact.md）
const SIZE_REGROW    = 8 * 1024;      // size 節流：較上次再長 >8KB 才重提
const SPEC_DIRS = ['specs', '.sdd'];

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const kb = b => (b / 1024).toFixed(0);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.exitCode = 0; });                      // stream error 不炸
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => { try { main(); } catch { /* 絕不擋使用者 */ } });  // 不立即 process.exit，讓 stdout 自然 flush（避免截斷提醒）

function readMarker(p) { try { return existsSync(p) ? parseInt(stripBom(readFileSync(p, 'utf8')).trim(), 10) || 0 : 0; } catch { return 0; } }
function writeMarker(p, v) { try { writeFileSync(p, String(v), 'utf8'); } catch {} }

function main() {
  let input = {};
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch {}
  const cwd = input.cwd || process.cwd();
  const event = input.hook_event_name || 'SessionStart';
  // W4-1（R1）：加掛 PostToolUse(Write|Edit)——自駕連續多輪不打字時，SDD 檔膨脹才不會整段失明。
  // 成本守則：只有「寫的是 specs//.sdd/ 的 .md」才往下量，其餘立即返回（每次寫檔多的只是這個 regex）。
  if (event === 'PostToolUse') {
    const fp = String(((input.tool_input ?? input.toolInput ?? {}).file_path) ?? '');
    if (!/(^|[\\\/])(specs|\.sdd)[\\\/].*\.md$/i.test(fp)) return;
  }
  if (!existsSync(join(cwd, 'specs')) && !existsSync(join(cwd, '.flow'))) return;
  const hasFlow = existsSync(join(cwd, '.flow'));
  const isPrompt = event === 'UserPromptSubmit' || event === 'PostToolUse';   // 兩者共用同一節流（marker+SIZE_REGROW）
  const msgs = [];

  // ── SDD 檔膨脹 ──
  const over = [];
  let maxBytes = 0;
  for (const sd of SPEC_DIRS) {
    const d = join(cwd, sd);
    if (!existsSync(d)) continue;
    let entries; try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      let bytes = 0; try { bytes = statSync(join(d, e.name)).size; } catch { continue; }
      if (bytes > maxBytes) maxBytes = bytes;
      if (bytes > SIZE_THRESHOLD) over.push({ name: `${sd}/${e.name}`, bytes });
    }
  }
  if (over.length) {
    const marker = join(cwd, '.flow', 'size-reminded');
    const last = readMarker(marker);
    const show = !isPrompt || !(last > 0 && maxBytes <= last + SIZE_REGROW);
    if (show) {
      if (hasFlow) writeMarker(marker, maxBytes);
      over.sort((a, b) => b.bytes - a.bytes);
      msgs.push([
        `# Flow SDD 檔案膨脹提醒（依檔案大小）`,
        `下列 specs 檔已超過 ${kb(SIZE_THRESHOLD)}KB，長流程讀取會稀釋注意力：`,
        ...over.map(f => `- ${f.name}：${kb(f.bytes)}KB ⚠️`),
        '→ 建議 `/flow-compact`：把「已交付 task 細節 / 已實作章節」歸檔到 `specs/archive/`（move 不刪、可回溯），',
        '  **接縫契約 / 未完成 REQ / open questions 一律留主檔**。可直接請我幫你執行收束。',
      ].join('\n'));
    }
  }

  if (!msgs.length) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: msgs.join('\n\n') },
  }));
}
