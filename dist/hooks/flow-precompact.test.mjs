// flow-precompact.test.mjs — Flow PreCompact hook（node --test）
// 驗：building 中的 task 各記一筆 pre-compact checkpoint（修 auto-compact 壓掉 mid-task 細節、reconstruct 接不回）；
// 非 Flow / 無進行中 task → no-op（不新增 checkpoint 事件）。hook 一律 exit 0（絕不影響 compaction）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../skills/flow-toolkit/statelib.mjs';

const HOOK = fileURLToPath(new URL('./flow-precompact.mjs', import.meta.url));
function runHook(cwd) {
  const r = spawnSync('node', [HOOK], { input: JSON.stringify({ cwd }), encoding: 'utf8' });
  return r.status;
}
async function withRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'precompact-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('非 Flow 專案 → exit 0、無寫入', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'noflow-'));
  try {
    assert.equal(runHook(tmp), 0);
    assert.ok(!existsSync(path.join(tmp, '.flow')), '非 Flow 專案不該被建出 .flow');
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('某 task ledger state=building → journal 出現 ev=checkpoint、phase=pre-compact 的該 task 事件', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    await S.transition(root, 'F-1', 'pending', 'building');
    assert.equal(runHook(root), 0);
    const j = await S.readJournal(root);
    const cp = j.find(e => e.ev === 'checkpoint' && e.id === 'F-1' && e.phase === 'pre-compact');
    assert.ok(cp, '應有 F-1 的 pre-compact checkpoint 事件');
  });
});

test('無 building 中的 task → 不新增 checkpoint 事件', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });   // 預設 pending，非 building
    assert.equal(runHook(root), 0);
    const j = await S.readJournal(root);
    assert.ok(!j.some(e => e.ev === 'checkpoint'), '沒有 building 中的 task 不該記 checkpoint');
  });
});
