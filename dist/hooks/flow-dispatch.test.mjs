// flow-dispatch.test.mjs — C-3① 四合一 dispatcher（合併 commit/auto/spec gate 成一次 node 冷啟）。
// 驗：三道各自的 block 情境經 dispatch 仍 exit 2；全放行 exit 0；壞輸入 fail-open；dispatchWiringProblems 對賬。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../skills/flow-toolkit/statelib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, 'flow-dispatch.mjs');
const run = input => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8' });
async function withFlow(fn, mode = 'auto') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dispatch-'));
  await S.init(root, { project: 'p', tasks: [] });
  await S.writeManifest(root, { ...(await S.readManifest(root)), mode });
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const bash = (root, command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: root });
const write = (root, fp, content) => ({ tool_name: 'Write', tool_input: { file_path: fp, content }, cwd: root });

test('dispatch → auto-gate 命中：mode:auto 裝新相依 → exit 2', async () => {
  await withFlow(async (root) => {
    const r = run(bash(root, 'npm install react'));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /自駕閘門|相依/);
  });
});

test('dispatch → spec-gate 命中：裸寫 phase=spec-done 進 state.json → exit 2', async () => {
  await withFlow(async (root) => {
    const r = run(write(root, path.join(root, '.flow', 'state.json'), JSON.stringify({ phase: 'spec-done' })));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /凍結閘門|spec-done/);
  });
});

test('dispatch → commit-gate 命中：git commit --no-verify → exit 2', async () => {
  await withFlow(async (root) => {
    const r = run(bash(root, 'git commit --no-verify -m x'));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no-verify|pre-commit/);
  }, 'manual');
});

test('dispatch：全放行（manual、唯讀命令）→ exit 0；壞輸入 → exit 0（fail-open）', async () => {
  await withFlow(async (root) => {
    assert.equal(run(bash(root, 'ls -la')).status, 0);
  }, 'manual');
  assert.equal(spawnSync(process.execPath, [HOOK], { input: '{bad', encoding: 'utf8' }).status, 0);
});

test('dispatchWiringProblems：dispatch 真的引用三道 → 空；漏一道 → 回該道', () => {
  const src = readFileSync(HOOK, 'utf8');
  assert.deepEqual(S.dispatchWiringProblems(src), [], 'flow-dispatch.mjs 引用了三道合併閘門');
  assert.deepEqual(S.dispatchWiringProblems("import { autoGateCheck } from './flow-auto-gate.mjs'"),
    ['flow-commit-gate.mjs', 'flow-spec-gate.mjs'], '漏引用即回報');
});
