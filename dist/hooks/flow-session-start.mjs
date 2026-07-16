#!/usr/bin/env node
// Flow SessionStart hook.
// 智慧精簡開場：只在「真的還有事要接」（開發中／待 verify·ship／等你決策／上次當機留的對帳分歧）時印一行提醒；
// 全部出貨完 → 靜默不打擾。完整進度（計數/checkpoint/對帳/下一步）一律只有打 /flow-resume 才印。
// 純讀檔、不靠記憶；非 flow 專案一律 no-op；reconstruct/import 失敗退回 phase 粗判一行（絕不 brick session）。

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function stripBom(s) {
  return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// C-3③①：hook 冷啟＋執行耗時碼表——記本 node process 從 timeOrigin 到收尾的總 ms（含 import statelib 等 Flow hook 主成本），
// 滾動保留最近 30 筆，給「安檢門四合一（C-3①）前後對照」用實測數字（不臆測）。全程 fail-silent、寫失敗不影響 session。
function recordTiming(claudeHome, hook) {
  try {
    const ms = Math.round(performance.now());
    const p = join(claudeHome, '.flow-hook-timing.json');
    let arr = [];
    try { if (existsSync(p)) arr = JSON.parse(stripBom(readFileSync(p, 'utf8'))).samples || []; } catch { arr = []; }
    arr.push({ hook, ms });
    if (arr.length > 30) arr = arr.slice(-30);
    writeFileSync(p, JSON.stringify({ samples: arr }));
  } catch { /* 碼表非關鍵 */ }
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

  // statelib 提前載入（reconstruct 與各項自檢共用）；載入失敗各消費點自行退回，絕不 brick。
  const claudeHome = join(dirname(fileURLToPath(import.meta.url)), '..');
  let S = null;
  try {
    const libUrl = pathToFileURL(join(claudeHome, 'skills', 'flow-toolkit', 'statelib.mjs')).href;
    S = await import(libUrl);                              // Windows 絕對路徑 dynamic import 須走 file:// URL
  } catch { S = null; }

  // 非阻擋：安裝來源漂移提醒（已裝版本 ≠ 來源 dist VERSION → 多半是改了 dist 沒重裝）。全程 fail-silent，永不影響 session。
  // W0-5 加碼：VERSION 相同也可能內容漂移（安裝區被熱修沒回寫 dist 的實證）→ 雙向內容對賬，附方向提示。
  let driftLine = '';
  let syncLine = '';
  try {
    const provPath = join(claudeHome, '.flow-version.json');
    if (existsSync(provPath)) {
      const prov = JSON.parse(stripBom(readFileSync(provPath, 'utf8')));
      const srcVerPath = prov && prov.source ? join(prov.source, 'VERSION') : '';
      if (srcVerPath && existsSync(srcVerPath)) {
        const srcVer = stripBom(readFileSync(srcVerPath, 'utf8')).trim();
        const instVer = String((prov && prov.version) ?? '').trim();
        if (srcVer && instVer && srcVer !== instVer) {
          driftLine = `- ⚠️ Flow 安裝漂移：已裝 v${instVer}，來源 ${prov.source} 已是 v${srcVer} → 改了 dist 沒重裝？跑 install 或精準複製改動檔到 ~/.claude。`;
        }
        if (S) {
          // C-3③：便宜 stat-only 指紋 gate——版本或兩側任一 mtime 沒動就沿用上次「無漂移」結論，略過 60–120 檔 read+hash（開機稅）。
          // 熱修改了 dist 或安裝區 → mtime 前進 → 指紋變 → 照樣全量比對（保留 W0-5 同版本熱修偵測）。指紋讀寫失敗一律退回「照跑全量」。
          const srcDist = join(prov.source, 'dist');
          const fpPath = join(claudeHome, '.flow-syncfp.json');
          let cachedFp = null, curFp = null;
          try { curFp = await S.syncFingerprint(srcDist, claudeHome); } catch { curFp = null; }
          try { if (existsSync(fpPath)) cachedFp = JSON.parse(stripBom(readFileSync(fpPath, 'utf8'))).fp || null; } catch { cachedFp = null; }
          if (!curFp || curFp !== cachedFp) {
            const d = await S.syncDrift(srcDist, claudeHome);
            if (d.differing.length || d.missing.length) {
              const eg = d.differing[0];
              const hint = eg ? `如 ${eg.rel}（${eg.newer === 'installed' ? '安裝區較新→回寫 dist' : 'dist 較新→重裝'}）` : '';
              syncLine = `- ⚠️ Flow 同步漂移：${d.differing.length} 檔 dist↔安裝區內容不一致${hint ? '，' + hint : ''}${d.missing.length ? `；另 ${d.missing.length} 檔 dist 有、安裝區沒有` : ''}。`;
            }
            // 只在「無漂移」時把當前指紋記為 clean baseline——有漂移不更新，讓下次仍全量抓到（別把漂移狀態當 baseline 靜默掉）。
            if (curFp && !syncLine) { try { writeFileSync(fpPath, JSON.stringify({ fp: curFp, at: new Date().toISOString() })); } catch { /* 快取寫失敗不致命 */ } }
          }
        }
      }
    }
  } catch { /* fail-silent，漂移提醒非關鍵、永不影響 session */ }

  // W0-2：hook 接線對賬——hooks 目錄實存的 flow-*.mjs 沒被 settings.json 註冊＝閘門形同虛設（auto-gate 漏接線實證）。
  let wiringLine = '';
  try {
    if (S) {
      const missing = S.hookWiringProblems(
        readdirSync(join(claudeHome, 'hooks')),
        readFileSync(join(claudeHome, 'settings.json'), 'utf8'),
      );
      if (missing.length) wiringLine = `- 🚨 Flow hook 接線缺失：settings.json 沒掛 ${missing.join('、')}——對應閘門完全不會觸發。重跑 install 或手動補回註冊。`;
    }
  } catch { /* fail-silent */ }

  // W0-4：CLAUDE_CODE_SUBAGENT_MODEL 優先權最高，被設會靜默蓋掉 Flow 全套 subagent 模型路由。
  const envLine = process.env.CLAUDE_CODE_SUBAGENT_MODEL
    ? `- ⚠️ 偵測到 CLAUDE_CODE_SUBAGENT_MODEL=${process.env.CLAUDE_CODE_SUBAGENT_MODEL}：此環境變數優先權高於 frontmatter/per-invocation model，Flow 的「Opus 審查/Sonnet 苦工」路由已被整套覆蓋。非刻意請 unset。`
    : '';

  // W3-3：冪等安裝 git 原生 pre-commit 兜底（使用者已選「自動放」）。首裝醒目告知一行（狀態變更）；
  // 已裝/非 git/husky 改向/既有非 sh hook（advisory skip）→ 靜默不每 session 重複打擾；只有「寫入失敗」才提醒。全程 fail-silent、永不影響 session。
  let precommitLine = '';
  try {
    const piUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'precommit-install.mjs')).href;
    const { installPrecommit } = await import(piUrl);
    const r = installPrecommit(cwd);
    if (r.installed) precommitLine = `- 🔒 已在本專案裝 git pre-commit 兜底（commit 前擋 secrets/驗證垃圾，連你手動 commit／腳本也擋；只檢查這兩件事、不覆蓋你既有 hook）：${r.path}。Flow 卸載後自動失效（守衛偵測檔不在即跳過、不 brick commit）；要徹底清殘留刪該檔 # flow-gate 區塊。急著跳過單次 commit：git commit --no-verify。`;
    else if (r.warn && !r.skipped) precommitLine = `- ⚠️ Flow pre-commit 兜底寫入失敗：${r.warn}`;  // advisory skip（husky/foreign-interpreter）不每 session 重印，只報真寫入失敗
  } catch { /* 安裝非關鍵、fail-silent，永不影響 session */ }

  // 智慧精簡：用 statelib briefStatus 判斷「有沒有事要接」；只在有事時印一行（含對帳分歧）。全完成 → 靜默。
  // 完整進度（含 mid-task checkpoint）留給 /flow-resume 的 summarizeView。任何錯都退回 phase 粗判一行，絕不 brick。
  let body = '';
  try {
    if (!S) throw new Error('statelib unavailable');
    // 自動補 .flow/.gitignore（既有專案初次升級也生效）：瞬時檔忽略、耐久證據照常 track。冪等、只在缺/異動時寫、fail-silent。
    try { await S.ensureFlowGitignore(cwd); } catch { /* 政策檔非關鍵、永不影響 session */ }
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

  recordTiming(claudeHome, 'session-start');   // C-3③①：收尾記碼表
  const additionalContext = [body, wiringLine, driftLine, syncLine, envLine, precommitLine].filter(Boolean).join('\n');
  if (!additionalContext) process.exit(0);   // 全部完成出貨、無漂移、pre-commit 已裝（無首裝告知）→ 真靜默、不打擾
  const out = {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
  };
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
});
