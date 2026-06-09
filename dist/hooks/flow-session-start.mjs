#!/usr/bin/env node
// Flow SessionStart hook.
// 把檔案耐久狀態（.flow/state.json）注入新 session → 純讀檔接手，不靠記憶腦補。
// 非 flow 專案一律 no-op。進度看 in-chat `flow-state status`；平行波看 /workflows。

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function stripBom(s) {
  return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
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

  const lines = [
    '# Flow 進度（檔案耐久狀態，讀自 .flow/state.json）',
    `- phase：${state.phase ?? '?'}`,
    state.task
      ? `- 當前 task：${state.task}（tdd=${state.tdd || 'none'} / verify=${state.verify || 'none'} / commit=${state.commit || '-'}）`
      : '',
    '- 狀態以 specs/ + .flow/ + git 為準：純讀檔接手，不靠記憶腦補。進度跑 `flow-state status`；平行波看 /workflows。',
    '- task 完成走 `flow-state done <id>`（翻 tasks.md [x] + ledger），再 commit；commit gate 會擋未標的。',
    '- specs 檔過大時 flow-size-check hook 會提醒跑 /flow-compact 歸檔已交付細節。',
    '- 接續：/flow（自動偵測 phase）或 /flow-resume（補上次中斷的 dangling）。',
    driftLine,
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
