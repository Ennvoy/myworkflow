#!/usr/bin/env node
// Flow SessionStart hook.
// 1) 把檔案耐久狀態（.flow/state.json）注入新 session → 純讀檔接手，不靠記憶腦補。
// 2) phase ∈ build/verify/ship 時，確定性起監控看板（沒在跑就 spawn + 自動開瀏覽器一次；
//    已在跑就重用、不重開分頁）→ 修「忘了開 flow-monitor」。非 flow 專案一律 no-op。

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';

function stripBom(s) {
  return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

// 看板還活著？（GET /status.json 200，短 timeout 不卡 session 啟動）
function ping(port) {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/status.json', timeout: 500 }, (r) => { r.resume(); res(r.statusCode === 200); });
    req.on('error', () => res(false));
    req.on('timeout', () => { req.destroy(); res(false); });
  });
}

// 確定性起看板：portFile 的 server 還活著就重用，否則 detached spawn dashboard.mjs --open。
async function ensureMonitor(cwd) {
  const here = dirname(fileURLToPath(import.meta.url));
  const dash = join(here, '..', 'skills', 'flow-toolkit', 'dashboard.mjs');
  if (!existsSync(dash)) return null;
  const portFile = join(cwd, '.flow', 'monitor.port');
  if (existsSync(portFile)) {
    const port = parseInt(stripBom(readFileSync(portFile, 'utf8')).trim(), 10);
    if (port && (await ping(port))) return { port, reused: true };
  }
  try {
    spawn(process.execPath, [dash, cwd, '--open'], { detached: true, stdio: 'ignore' }).unref();
    return { spawned: true };
  } catch { return null; }
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
  const statePath = join(cwd, '.flow', 'state.json');
  if (!existsSync(statePath)) process.exit(0); // not a Flow project

  let state;
  try {
    state = JSON.parse(stripBom(readFileSync(statePath, 'utf8')));
  } catch {
    process.exit(0);
  }

  const phase = String(state.phase ?? '').toLowerCase();
  const active = /build|verify|ship/.test(phase); // 開發中三階段才需要即時看板

  let monitorLine = '';
  if (active) {
    const m = await ensureMonitor(cwd);
    if (m?.reused) monitorLine = `- 監控看板：已在跑 http://127.0.0.1:${m.port}（決策回 Claude 彈窗，看板只顯示）。`;
    else if (m?.spawned) monitorLine = '- 監控看板：已自動啟動並開瀏覽器（port 寫入 .flow/monitor.port；每 2 秒刷新）。';
  }

  const lines = [
    '# Flow 進度（檔案耐久狀態，讀自 .flow/state.json）',
    `- phase：${state.phase ?? '?'}`,
    state.task
      ? `- 當前 task：${state.task}（tdd=${state.tdd || 'none'} / verify=${state.verify || 'none'} / commit=${state.commit || '-'}）`
      : '',
    monitorLine,
    '- 狀態以 specs/ + .flow/ + git 為準：純讀檔接手，不靠記憶腦補。',
    '- task 完成走 `flow-state done <id>`（翻 tasks.md [x] + ledger），再 commit；commit gate 會擋未標的。',
    '- specs 檔過大時 flow-size-check hook 會提醒跑 /flow-compact 歸檔已交付細節。',
    '- 接續：/flow（自動偵測 phase）或 /flow-resume（補上次中斷的 dangling）。',
  ]
    .filter(Boolean)
    .join('\n');

  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines,
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
});
