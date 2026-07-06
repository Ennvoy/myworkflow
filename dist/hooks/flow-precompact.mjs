#!/usr/bin/env node
// Flow PreCompact hook（W3-5）：context 壓縮前把「做到第幾步」自動落 checkpoint——
// 防 auto-compact 把 mid-task 細節壓掉後 reconstruct 接不回、整個 task 重跑。
// 對所有 building 中的 task 各記一筆（通常 1 個）；任何錯 exit 0（絕不影響 compaction）；非 Flow / 無進行中 task → no-op。
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const stripBom = s => (s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', c => (raw += c));
process.stdin.on('end', () => { main().then(() => process.exit(0)).catch(() => process.exit(0)); });

async function main() {
  let input = {};
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { return; }
  const cwd = input.cwd ?? process.cwd();
  if (!existsSync(join(cwd, '.flow'))) return;
  try {
    const libUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'flow-toolkit', 'statelib.mjs')).href;
    const S = await import(libUrl);
    const view = await S.reconstruct(cwd);
    const building = Object.values(view.tasks || {}).filter(t => t.state === 'building');
    for (const t of building) {
      await S.recordCheckpoint(cwd, t.id, 'pre-compact', 'auto：compaction 前自動存進度（reconstruct 據此接續、不重跑整個 task）');
    }
  } catch { /* fail-silent，checkpoint 非關鍵 */ }
}
