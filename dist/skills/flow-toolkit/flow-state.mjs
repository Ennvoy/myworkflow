#!/usr/bin/env node
// flow-state — Flow .flow/ 狀態 CLI。換手接手用：冷啟動 reconstruct 純讀檔印現況 + 下一步 + 原子標完成。
// 全域裝一次（~/.claude/skills/flow-toolkit），對「當前專案」生效（讀 cwd 或 --root 的 .flow/）。
// 決策/討論一律回 Claude（彈窗）；狀態都在各專案的 .flow/。進度看這支的文字輸出；平行波看 /workflows。
import path from 'node:path';
import * as S from './statelib.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const root = path.resolve(flag('--root', process.cwd()));

// 下一個可推進 task：非 delivered/needs-decision、且 blockedBy 已全 delivered
function pickNext(view) {
  const done = id => (view.tasks[id] || {}).state === 'delivered';
  for (const t of (view.manifest.tasks || [])) {
    const s = (view.tasks[t.id] || { state: 'pending' }).state;
    if (s === 'delivered' || s === 'needs-decision') continue;
    if ((s === 'pending' || s === 'blocked') && !(t.blockedBy || []).every(done)) continue;
    return { id: t.id, state: s };
  }
  return null;
}

async function resume() {
  const view = await S.reconstruct(root);
  const tasks = Object.values(view.tasks);
  const by = s => tasks.filter(t => t.state === s).length;
  const L = [];
  L.push(`\n=== flow resume :: ${view.manifest.project || '(未命名)'}  (phase: ${view.manifest.phase || '?'}) ===`);
  L.push(`已交付 ${by('delivered')}/${tasks.length} | 開發中 ${by('building')} | 驗收中 ${by('verifying')} | 待開發 ${by('pending') + by('blocked')} | ⚠️ 等你決策 ${by('needs-decision')}`);
  const need = tasks.filter(t => t.state === 'needs-decision');
  if (need.length) { L.push(`\n⚠️ 等你決策（回 Claude 以彈窗拍板）：`); for (const t of need) L.push(`   - ${t.id}：${t.decision || '需要你決策'}`); }
  if (view.dangling.length) { L.push(`\n↻ 未完成動作（對帳會冪等補做）：`); for (const d of view.dangling) L.push(`   - ${d.id} → ${d.action}`); }
  const next = pickNext(view);
  L.push(`\n下一步：${next ? `推進 ${next.id}（${next.state} → 下一階段）` : (need.length ? '等你決策後才有得做' : '無可推進（全部完成或卡依賴）')}\n`);
  console.log(L.join('\n'));
  return view;
}

switch (cmd) {
  case 'resume':
  case 'status':
    await resume();
    break;
  case 'done': {
    // 原子完成一個 task：翻 tasks.md [x] + ledger→delivered。一個指令取代三條會被漏掉的散文步驟。
    // 用法：flow-state done <taskId> [--commit <sha>]（taskId 可給 canonical 或唯一尾段如 W0-5）
    const id = argv[1];
    if (!id || id.startsWith('--')) { console.error('usage: flow-state done <taskId> [--commit <sha>]'); process.exit(1); }
    const commit = flag('--commit');
    const r = await S.markTaskDone(root, id, commit ? { commit } : {});
    const md = r.tasksMd.changed ? 'tasks.md [x] 已翻' : (r.tasksMd.found ? 'tasks.md 本已 [x]' : '⚠ tasks.md 無對應行（id 對不上？）');
    const lg = r.alreadyDelivered ? 'ledger 本已 delivered' : 'ledger→delivered';
    console.log(`✓ ${r.id}：${md}；${lg}${commit ? `；commit=${commit}` : ''}`);
    console.log('  下一步：照常 git commit（commit gate 已可放行此 task）。');
    break;
  }
  default:
    console.log(`flow-state <resume|status|done> [--root <path>]
  resume | status      冷啟動：reconstruct 印現況 + 下一步（換 session/電腦/中斷後接手；平行波看 /workflows）
  done <id> [--commit] 標一個 task 完成：翻 tasks.md [x] + ledger→delivered（先標、再 commit）
決策/討論一律回 Claude（彈窗）；狀態都在專案的 .flow/。`);
}
