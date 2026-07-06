// flow-stop-gate.test.mjs — Flow Stop 閘門 hook（node --test）
// 驗：mode:auto、tasks.md 全 [x]、但當前 HEAD 未過 complete-check → exit 2 擋收工；
// mid-run（還有 [ ]）/ manual / 非 Flow 專案一律放行；stop_hook_active 防遞迴；壞 stdin fail-open。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../skills/flow-toolkit/statelib.mjs';

const HOOK = fileURLToPath(new URL('./flow-stop-gate.mjs', import.meta.url));
function run(input) {
  const r = spawnSync('node', [HOOK], { input: JSON.stringify(input), encoding: 'utf8' });
  return { code: r.status, err: r.stderr || '' };
}
async function withRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stopgate-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function writeTasks(root, md) {
  await mkdir(path.join(root, 'specs'), { recursive: true });
  await writeFile(path.join(root, 'specs', 'tasks.md'), md, 'utf8');
}

test('非 Flow 專案（無 .flow）→ exit 0', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'noflow-'));
  try {
    assert.equal(run({ cwd: tmp }).code, 0);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('mode:manual → exit 0（不干擾非自駕）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeStateJson(root, { mode: 'manual' });
    await writeTasks(root, '- [x] **F-1**\n');
    assert.equal(run({ cwd: root }).code, 0);
  });
});

test('mode:auto、tasks.md 還有 [ ] → exit 0（mid-run 不干擾）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeStateJson(root, { mode: 'auto' });
    await writeTasks(root, '- [x] **F-1**\n- [ ] **F-2**\n');
    assert.equal(run({ cwd: root }).code, 0);
  });
});

test('mode:auto、tasks.md 全 [x]、無 complete-check.json → exit 2 且 stderr 含 complete-check', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeStateJson(root, { mode: 'auto' });
    await writeTasks(root, '- [x] **F-1**\n');
    const r = run({ cwd: root });
    assert.equal(r.code, 2);
    assert.match(r.err, /complete-check/);
  });
});

test('mode:auto、全 [x]、已落 complete-check.json（測試目錄非 git → 拿不到 head）→ exit 0', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeStateJson(root, { mode: 'auto' });
    await writeTasks(root, '- [x] **F-1**\n');
    await S.writeCompleteCheck(root, { head: 'deadbeef' });
    assert.equal(run({ cwd: root }).code, 0);
  });
});

test('stop_hook_active:true → exit 0（防遞迴，即使其餘條件滿足擋的門檻）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeStateJson(root, { mode: 'auto' });
    await writeTasks(root, '- [x] **F-1**\n');
    assert.equal(run({ cwd: root, stop_hook_active: true }).code, 0);
  });
});

test('餵垃圾 stdin → exit 0（fail-open）', () => {
  const r = spawnSync('node', [HOOK], { input: '{bad', encoding: 'utf8' });
  assert.equal(r.status, 0);
});
