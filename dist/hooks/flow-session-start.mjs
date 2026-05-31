#!/usr/bin/env node
// Flow SessionStart hook.
// Injects file-durable state (.flow/state.json) into a fresh session so work resumes
// deterministically from disk, not from remembered context. No-op outside Flow projects.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

  const lines = [
    '# Flow 進度（檔案耐久狀態，讀自 .flow/state.json）',
    `- phase：${state.phase ?? '?'}`,
    state.task
      ? `- 當前 task：${state.task}（tdd=${state.tdd || 'none'} / verify=${state.verify || 'none'} / commit=${state.commit || '-'}）`
      : '',
    '- 狀態以 specs/ + .flow/ + git 為準：純讀檔接手，不靠記憶腦補。',
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
