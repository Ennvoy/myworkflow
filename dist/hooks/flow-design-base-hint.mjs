#!/usr/bin/env node
// flow-design-base-hint.mjs — PreToolUse(Write) 非阻擋提示器（設計系統基底）。
// 目的：首次在某專案新建前端檔（.tsx/.css 等）時，把「Flow 內建 150 套品牌設計系統可當基底」
//   這個選項，確定性地注入主模型 context——不限走不走 /flow-spec，任何 UI/視覺工作都會被提醒到。
// 設計鐵則（與 commit-gate 的硬擋不同）：
//   1) 永不阻擋——UI 迭代不該被打斷，所以用 exit 0 + additionalContext 注入，絕不 exit 2。
//   2) 每個前端檔一次（刻意 per-file，非 per-專案）——絕對檔路徑記到 ~/.claude/.flow-design-base-seen.json，同檔迭代覆寫不重複煩；新增新 UI 檔＝新提醒。
//   3) 只攔 Write（新建檔＝最該選基底的時機）；Edit 既有檔不擾。
//   4) fail-open——解析失敗 / 沒裝設計系統 / 取不到家目錄 → 一律 exit 0 放行不注入。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exit0 = () => process.exit(0);
const stripBom = (s) => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// 新建這些副檔名＝大概率在做 UI/視覺。
const FRONTEND_EXT = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.astro', '.html', '.css', '.scss', '.sass', '.less']);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { return exit0(); }

  const tool = input.tool_name ?? input.toolName ?? '';
  if (tool !== 'Write') return exit0(); // 只攔新建檔
  const ti = input.tool_input ?? input.toolInput ?? {};
  const fp = String(ti.file_path ?? ti.filePath ?? '');
  if (!fp || !FRONTEND_EXT.has(extname(fp).toLowerCase())) return exit0();

  // 設計系統索引（與本 hook 同發行結構：hooks/ 與 skills/flow-toolkit/ 同層）。沒裝就不提醒。
  let indexPath;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    indexPath = join(here, '..', 'skills', 'flow-toolkit', 'references', 'design-systems', 'index.md');
  } catch { return exit0(); }
  if (!existsSync(indexPath)) return exit0();

  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return exit0();
  const cwd = input.cwd ?? process.cwd();
  const fileKey = resolve(cwd, fp); // 絕對化檔路徑當 key（per-檔記錄）

  // 每個前端檔提醒一次：新增 UI＝新檔 → 會再次提醒；同檔迭代覆寫 → 不重複煩。
  const seenFile = join(home, '.claude', '.flow-design-base-seen.json');
  let seen = [];
  try { if (existsSync(seenFile)) seen = JSON.parse(stripBom(readFileSync(seenFile, 'utf8'))).seen ?? []; } catch {}
  if (seen.includes(fileKey)) return exit0(); // 這個檔提醒過 → 放行不注入

  try {
    mkdirSync(dirname(seenFile), { recursive: true });
    writeFileSync(seenFile, JSON.stringify({ seen: [...seen, fileKey] }, null, 2), 'utf8');
  } catch {} // best-effort；寫不進去頂多下次再提醒一次，不影響放行

  const ctx = [
    '【Flow 設計系統基底提示 · 偵測到新建前端檔】',
    'Flow 內建 150 套大廠品牌設計系統，可當「深層客製化」起點（拒絕平庸的預設框架樣式）。',
    `索引：${indexPath}`,
    '若這是新的 UI/視覺工作：建議先讀 index.md，用 AskUserQuestion 跟使用者選一套品牌基底（如 shadcn / linear-app / stripe / claude），再讀該套 <slug>/DESIGN.md + tokens.css 當基底實作（tokens 可直接餵 Tailwind）。小改樣式、本專案已選定基底、或使用者不需要 → 略過即可。每個檔僅提醒一次。',
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow', // 永不阻擋，只附 context
      additionalContext: ctx,
    },
  }));
  process.exit(0);
});
