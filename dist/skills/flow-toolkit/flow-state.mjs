#!/usr/bin/env node
// flow-state — Flow .flow/ 狀態 CLI。換手接手用：冷啟動 reconstruct 印現況+下一步；冪等起監控看板。
// 全域裝一次（~/.claude/skills/flow-toolkit），對「當前專案」生效（讀 cwd 或 --root 的 .flow/）。
// 決策/討論一律回 Claude（彈窗）；狀態都在各專案的 .flow/。
import path from 'node:path';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as S from './statelib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const root = path.resolve(flag('--root', process.cwd()));

// 下一個可推進 task：非 delivered/needs-decision、且 blockedBy 已全 delivered（與看板/build 同邏輯）
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

function ping(port) {
  return new Promise(res => {
    const req = http.get({ host: '127.0.0.1', port, path: '/status.json', timeout: 800 }, r => { r.resume(); res(r.statusCode === 200); });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
  });
}

// 冪等起看板：.flow/monitor.port 的 server 還活著就重用，否則 spawn dashboard.mjs（detached）。
async function monitor() {
  const portFile = path.join(root, '.flow', 'monitor.port');
  if (existsSync(portFile)) {
    const port = parseInt(readFileSync(portFile, 'utf8').trim(), 10);
    if (port && await ping(port)) { console.log(`flow monitor 已在執行：http://127.0.0.1:${port}`); return; }
  }
  const child = spawn(process.execPath, [path.join(__dirname, 'dashboard.mjs'), root, '--open'], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log('flow monitor 啟動中…（綁定後寫 .flow/monitor.port 並自動開瀏覽器）');
}

switch (cmd) {
  case 'resume':
  case 'status':
    await resume();
    break;
  case 'monitor':
    await monitor();
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
    console.log(`flow-state <resume|status|monitor|done> [--root <path>]
  resume | status      冷啟動：reconstruct 印現況 + 下一步（換 session/電腦/中斷後接手）
  monitor              冪等起監控看板（已在跑就重用同一個）
  done <id> [--commit] 標一個 task 完成：翻 tasks.md [x] + ledger→delivered（先標、再 commit）
決策/討論一律回 Claude（彈窗）；狀態都在專案的 .flow/。`);
}
