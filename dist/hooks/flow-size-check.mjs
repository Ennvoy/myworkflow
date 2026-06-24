#!/usr/bin/env node
// Flow context 預算偵測 hook（SessionStart + UserPromptSubmit）。唯讀、確定性、非阻擋。
// 兩個獨立觸發判據（各自節流），任一命中就注入「該 /flow-compact」提醒（hook 喚不動模型、由模型語意收束）：
//   ① SDD 檔膨脹：statSync 量 specs/*.md，任一 >50KB（抓「文件越寫越長」）。
//   ② 對話 context 腐化：讀 hook payload 的 transcript_path（JSONL），取最後一則 assistant message 的 usage
//      算真實視窗利用率 >~60%（抓「specs 小但對話長」——size 判據抓不到的腐化，無人盯著的自駕尤其需要）。
// No-op 非 Flow 專案。任何錯一律 exit 0 放行（絕不擋使用者）。**絕不 exit 2**（過早 compact 丟脈絡比晚收束更糟）。
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const SIZE_THRESHOLD = 50 * 1024;     // 單檔 >50KB 視為膨脹（對齊 flow-compact.md）
const SIZE_REGROW    = 8 * 1024;      // size 節流：較上次再長 >8KB 才重提
const CTX_THRESHOLD  = 120 * 1000;    // 視窗 input 用量 >~120k token（約 200k 視窗 60%，n² attention「dumb zone」起點）
const CTX_REGROW     = 15 * 1000;     // ctx 節流：較上次再漲 >15k token 才重提
const TAIL_BYTES     = 512 * 1024;    // 只讀 transcript 尾 512KB（最後一則 usage 必在尾端，省讀大檔）
const SPEC_DIRS = ['specs', '.sdd'];

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const kb = b => (b / 1024).toFixed(0);
const ktok = n => (n / 1000).toFixed(0);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.exitCode = 0; });                      // stream error 不炸
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => { try { main(); } catch { /* 絕不擋使用者 */ } });  // 不立即 process.exit，讓 stdout 自然 flush（避免截斷提醒）

// 讀檔尾 maxBytes（避免讀進整份大 transcript）。
function readTail(p, maxBytes) {
  const size = statSync(p).size;
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  if (len <= 0) return '';
  const buf = Buffer.alloc(len);
  const fd = openSync(p, 'r');
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  return buf.toString('utf8');
}

// 從 transcript JSONL 尾端找最後一則帶 usage 的 assistant message，算 input 側視窗用量。
// used = input + cache_read + cache_creation（都是佔視窗的 input 側；output 不算當前 context）。
function lastTurnUsedTokens(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  let tail;
  try { tail = readTail(transcriptPath, TAIL_BYTES); } catch { return null; }
  const lines = tail.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }   // 尾端首行可能被截半 → 跳過
    if (o && o.isSidechain) continue;                       // sub-agent usage 不代表主視窗
    const u = (o && o.message && o.message.usage) || (o && o.usage);
    if (!u) continue;
    const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (used > 0) return used;                              // 跳過 0-usage 佔位 turn，往前找真實 usage（修「最肥時靜默失效」）
  }
  return null;
}

function readMarker(p) { try { return existsSync(p) ? parseInt(stripBom(readFileSync(p, 'utf8')).trim(), 10) || 0 : 0; } catch { return 0; } }
function writeMarker(p, v) { try { writeFileSync(p, String(v), 'utf8'); } catch {} }

function main() {
  let input = {};
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch {}
  const cwd = input.cwd || process.cwd();
  const event = input.hook_event_name || 'SessionStart';
  if (!existsSync(join(cwd, 'specs')) && !existsSync(join(cwd, '.flow'))) return;
  const hasFlow = existsSync(join(cwd, '.flow'));
  const isPrompt = event === 'UserPromptSubmit';
  const msgs = [];

  // ── 判據 ①：SDD 檔膨脹 ──
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

  // ── 判據 ②：對話 context 腐化（真值來源，非回合數猜測）──
  const used = lastTurnUsedTokens(input.transcript_path || input.transcriptPath);
  if (used != null && used > CTX_THRESHOLD) {
    const marker = join(cwd, '.flow', 'ctx-reminded');
    const last = readMarker(marker);
    const show = !isPrompt || !(last > 0 && used <= last + CTX_REGROW);
    if (show) {
      if (hasFlow) writeMarker(marker, used);
      msgs.push([
        `# Flow context 利用率提醒（真實視窗用量）`,
        `目前對話 context 約 ${ktok(used)}k token（>~${ktok(CTX_THRESHOLD)}k，已進 n² attention 稀釋區）。`,
        '無人盯著的自駕長流程尤其要主動收束——建議：',
        '- `/flow-compact`：**先刪最新的尾巴**（保住 prefix → prompt cache hit 價＝miss 1/10），保留最近熱檔。',
        '- 吵雜/大 context 的子工作丟獨立 subagent（context firewall），只收回 1–2k 蒸餾結果。',
      ].join('\n'));
    }
  }

  if (!msgs.length) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: msgs.join('\n\n') },
  }));
}
