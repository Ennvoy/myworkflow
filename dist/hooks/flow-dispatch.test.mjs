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

test('dispatch → git-guardrail 命中：git checkout -b feature → exit 2（排最前面、statelib 都還沒碰就先攔）', async () => {
  await withFlow(async (root) => {
    const r = run(bash(root, 'git checkout -b feature'));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /git guardrail|checkout/);
  }, 'manual');
});

test('dispatch → git-guardrail 逃生口：帶 FLOW_GIT_OK → 放行（manual 模式、非 commit 也不誤觸其他道）', async () => {
  await withFlow(async (root) => {
    const r = run(bash(root, 'FLOW_GIT_OK=1 git checkout -b feature'));
    assert.equal(r.status, 0);
  }, 'manual');
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

test('dispatchWiringProblems：dispatch 引用四道閘門＋提示器 → 空；漏引用 → 回該檔', () => {
  const src = readFileSync(HOOK, 'utf8');
  assert.deepEqual(S.dispatchWiringProblems(src), [], 'flow-dispatch.mjs 引用了四道合併閘門＋design 提示器');
  assert.deepEqual(S.dispatchWiringProblems("import { autoGateCheck } from './flow-auto-gate.mjs'"),
    ['flow-commit-gate.mjs', 'flow-spec-gate.mjs', 'flow-git-guardrail.mjs', 'flow-design-base-hint.mjs'], '漏引用即回報');
});

test('C-3②：dispatch → design 基底提示：新建前端檔注入 additionalContext、同檔僅一次、阻擋優先', async () => {
  await withFlow(async (root) => {
    // seen 檔寫進 tmp 家目錄，不汙染真 ~/.claude
    const env = { ...process.env, USERPROFILE: root, HOME: root };
    const hint = (fp) => spawnSync(process.execPath, [HOOK],
      { input: JSON.stringify(write(root, fp, '<div/>')), encoding: 'utf8', env });
    const r1 = hint(path.join(root, 'src', 'App.tsx'));
    assert.equal(r1.status, 0, '非阻擋');
    assert.match(r1.stdout, /設計系統基底/, '首見前端檔注入提示');
    assert.match(r1.stdout, /"permissionDecision":"allow"/, '照舊 allow 不擋');
    const r2 = hint(path.join(root, 'src', 'App.tsx'));
    assert.doesNotMatch(String(r2.stdout || ''), /設計系統基底/, '同檔第二次不重複');
    const r3 = hint(path.join(root, 'src', 'util.mjs'));
    assert.equal(String(r3.stdout || ''), '', '非前端檔不注入');
    // 阻擋優先：spec-gate 命中時 exit 2、不帶提示 stdout
    const rb = spawnSync(process.execPath, [HOOK],
      { input: JSON.stringify(write(root, path.join(root, '.flow', 'state.json'), '{"phase":"spec-done"}')), encoding: 'utf8', env });
    assert.equal(rb.status, 2);
    assert.equal(String(rb.stdout || ''), '', '被擋時不注入提示');
  }, 'manual');
});
