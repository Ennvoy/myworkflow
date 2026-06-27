// flow-spec-gate.test.mjs — 需求凍結閘門「窗戶感應器」hook（node --test）
// 驗：raw 寫 phase=spec-done 進 .flow/state.json → exit 2；正門子命令/其他檔/已凍結/非 Flow/壞 JSON → 放行(fail-open)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../skills/flow-toolkit/statelib.mjs';

const HOOK = fileURLToPath(new URL('./flow-spec-gate.mjs', import.meta.url));
const run = input => spawnSync('node', [HOOK], { input: JSON.stringify(input), encoding: 'utf8' }).status;

async function withFlow(fn, state = { mode: 'auto', phase: 'spec' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specgate-'));
  await S.init(root, { project: 'p', tasks: [] });
  await S.writeStateJson(root, state);
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const write = (root, file_path, content) => ({ tool_name: 'Write', tool_input: { file_path, content }, cwd: root });
const edit = (root, file_path, new_string) => ({ tool_name: 'Edit', tool_input: { file_path, new_string }, cwd: root });
const bash = (root, command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: root });
const SPEC_DONE = JSON.stringify({ mode: 'auto', phase: 'spec-done' });

test('Write raw 寫 phase=spec-done 進 state.json → exit 2（擋後門裸寫）', async () => {
  await withFlow(async (root) => {
    assert.equal(run(write(root, path.join(root, '.flow', 'state.json'), SPEC_DONE)), 2);
  });
});

test('Edit 把 new_string 改成 spec-done → exit 2', async () => {
  await withFlow(async (root) => {
    assert.equal(run(edit(root, path.join(root, '.flow', 'state.json'), '"phase": "spec-done"')), 2);
  });
});

test('Bash 用 Set-Content/echo 寫 spec-done 進 state.json → exit 2', async () => {
  await withFlow(async (root) => {
    assert.equal(run(bash(root, `echo '{"phase":"spec-done"}' > .flow/state.json`)), 2);
  });
});

test('正門：flow-state spec-ready --freeze（命令不含 state.json 路徑/spec-done 字樣）→ 放行', async () => {
  await withFlow(async (root) => {
    assert.equal(run(bash(root, 'node ~/.claude/skills/flow-toolkit/flow-state.mjs spec-ready --freeze')), 0);
  });
});

test('寫別的 phase（plan-done/其他檔）→ 放行', async () => {
  await withFlow(async (root) => {
    assert.equal(run(write(root, path.join(root, '.flow', 'state.json'), JSON.stringify({ phase: 'plan-done' }))), 0, '別的 phase 不擋');
    assert.equal(run(write(root, path.join(root, 'specs', 'requirements.md'), '...spec-done...')), 0, '別的檔不擋');
  });
});

test('current phase 已是 spec-done → 再存放行（只擋轉移那一刻）', async () => {
  await withFlow(async (root) => {
    assert.equal(run(write(root, path.join(root, '.flow', 'state.json'), JSON.stringify({ phase: 'spec-done', mode: 'auto' }))), 0);
  }, { mode: 'auto', phase: 'spec-done' });
});

test('非 Flow / 壞 JSON / 非相關工具 → fail-open exit 0', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'noflow-'));
  assert.equal(run(write(tmp, path.join(tmp, '.flow', 'state.json'), SPEC_DONE)), 0, '無 .flow → 放行');
  await rm(tmp, { recursive: true, force: true });
  assert.equal(spawnSync('node', [HOOK], { input: '{bad', encoding: 'utf8' }).status, 0, '壞 JSON 放行');
  await withFlow(async (root) => {
    assert.equal(run({ tool_name: 'TaskUpdate', tool_input: {}, cwd: root }), 0, '非 Write/Edit/Bash/PS 放行');
  });
});
