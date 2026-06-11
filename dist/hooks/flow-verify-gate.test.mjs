// flow-verify-gate.test.mjs — verify 閘門黑箱測試（spawn node hook、餵 stdin JSON、斷言 exit code）。
// 釘住 fail 方向：Flow 專案 verify 空/none → fail-closed（exit 2）；非 Flow 專案/壞輸入 → fail-open（exit 0）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, 'flow-verify-gate.mjs');

function runHook(input) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr || '' };
}
async function withRoot(state, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowvgate-'));
  try {
    if (state !== null) {
      await mkdir(path.join(root, '.flow'), { recursive: true });
      await writeFile(path.join(root, '.flow', 'state.json'), JSON.stringify(state), 'utf8');
    }
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const upd = (status, cwd) => ({ tool_name: 'TaskUpdate', tool_input: { taskId: '1', status }, cwd });

test('非 TaskUpdate / 非 completed → 放行', async () => {
  await withRoot({ verify: 'none', tdd: 'none' }, async (root) => {
    assert.equal(runHook({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: root }).code, 0);
    assert.equal(runHook(upd('in_progress', root)).code, 0);
  });
});

test('completed＋verify 空/none → exit 2（fail-closed）', async () => {
  await withRoot({ verify: 'none', tdd: 'green' }, async (root) => {
    const r = runHook(upd('completed', root));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /verify/);
  });
  await withRoot({ verify: 'ok:e2e', tdd: '' }, async (root) => {
    assert.equal(runHook(upd('completed', root)).code, 2, 'tdd 空也擋');
  });
});

test('completed＋verify ok＋tdd green → 放行', async () => {
  await withRoot({ verify: 'ok:e2e-report', tdd: 'green' }, async (root) => {
    assert.equal(runHook(upd('completed', root)).code, 0);
  });
});

test('非 Flow 專案（無 .flow/state.json）→ 放行（fail-open，不干擾一般專案）', async () => {
  await withRoot(null, async (root) => {
    assert.equal(runHook(upd('completed', root)).code, 0);
  });
});

test('壞輸入（非 JSON）→ 放行不炸', () => {
  const r = spawnSync(process.execPath, [HOOK], { input: '{broken', encoding: 'utf8' });
  assert.equal(r.status, 0);
});
