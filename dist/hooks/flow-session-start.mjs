#!/usr/bin/env node
// Flow SessionStart hook.
// 智慧精簡開場：只在「真的還有事要接」（開發中／待 verify·ship／等你決策／上次當機留的對帳分歧）時印一行提醒；
// 全部出貨完 → 靜默不打擾。完整進度（計數/checkpoint/對帳/下一步）一律只有打 /flow-resume 才印。
// 純讀檔、不靠記憶；非 flow 專案一律 no-op；reconstruct/import 失敗退回 phase 粗判一行（絕不 brick session）。

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function stripBom(s) {
  return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  let input = {};
  try {
    input = JSON.parse(stripBom(raw).trim() || '{}');
  } catch {
    /* ignore */
  }

  const cwd = input.cwd ?? process.cwd();
  const flowDir = join(cwd, '.flow');
  // 判 Flow 專案：manifest.json（進 git、fresh clone 也在）或 state.json（gitignored、同機才有）任一存在。
  // 過去只認 state.json → 換電腦 clone 下來（state.json 不進 git）SessionStart 直接 no-op、接不上現況。
  if (!existsSync(join(flowDir, 'manifest.json')) && !existsSync(join(flowDir, 'state.json'))) process.exit(0);

  // state 只供「reconstruct 失敗時」的退回粗判；主路徑用 reconstruct（讀 manifest/ledger/journal，不依賴 state.json）。
  let state = {};
  try {
    const sp = join(flowDir, 'state.json');
    if (existsSync(sp)) state = JSON.parse(stripBom(readFileSync(sp, 'utf8')));
  } catch { state = {}; }

  // 非阻擋：安裝來源漂移提醒（已裝版本 ≠ 來源 dist VERSION → 多半是改了 dist 沒重裝）。全程 fail-silent，永不影響 session。
  let driftLine = '';
  try {
    const provPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.flow-version.json');
    if (existsSync(provPath)) {
      const prov = JSON.parse(stripBom(readFileSync(provPath, 'utf8')));
      const srcVerPath = prov && prov.source ? join(prov.source, 'VERSION') : '';
      if (srcVerPath && existsSync(srcVerPath)) {
        const srcVer = stripBom(readFileSync(srcVerPath, 'utf8')).trim();
        const instVer = String((prov && prov.version) ?? '').trim();
        if (srcVer && instVer && srcVer !== instVer) {
          driftLine = `- ⚠️ Flow 安裝漂移：已裝 v${instVer}，來源 ${prov.source} 已是 v${srcVer} → 改了 dist 沒重裝？跑 install 或精準複製改動檔到 ~/.claude。`;
        }
      }
    }
  } catch { /* fail-silent，漂移提醒非關鍵、永不影響 session */ }

  // 智慧精簡：用 statelib briefStatus 判斷「有沒有事要接」；只在有事時印一行（含對帳分歧）。全完成 → 靜默。
  // 完整進度（含 mid-task checkpoint）留給 /flow-resume 的 summarizeView。任何錯都退回 phase 粗判一行，絕不 brick。
  let body = '';
  try {
    const libUrl = pathToFileURL(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'flow-toolkit', 'statelib.mjs')
    ).href;                                            // Windows 絕對路徑 dynamic import 須走 file:// URL
    const S = await import(libUrl);
    const view = await S.reconstruct(cwd);
    const parts = [];
    const brief = S.briefStatus(view);
    if (brief.hasWork) parts.push(brief.line);
    // 對帳分歧（上次標完成時當機留的 tasks.md↔ledger 不一致）也提醒一行
    try {
      const tp = join(cwd, 'specs', 'tasks.md');
      if (existsSync(tp)) {
        const rec = S.reconcile(readFileSync(tp, 'utf8'), await S.listLedger(cwd));
        const n = rec.checkedButNotDelivered.length + rec.deliveredButNotChecked.length;
        if (n) parts.push(`⚠ tasks.md 與 ledger 有 ${n} 處對不上（上次標完成時當機？）→ 打 /flow-resume 看詳情、\`flow-state done <id>\` 冪等重同步。`);
      }
    } catch { /* 對帳非關鍵，失敗略過 */ }
    body = parts.join('\n');
  } catch {
    // 退回：reconstruct/import 失敗時，用 state.json.phase 粗判——未出貨才提一行（寧可多提醒，不 brick）
    body = (state.phase && state.phase !== 'shipped')
      ? `⚡ 有未完成的 Flow（phase=${state.phase}）→ 打 /flow-resume 看完整進度並接續。`
      : '';
  }

  const additionalContext = [body, driftLine].filter(Boolean).join('\n');
  if (!additionalContext) process.exit(0);   // 全部完成出貨且無漂移 → 真靜默、不打擾
  const out = {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
  };
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
});
