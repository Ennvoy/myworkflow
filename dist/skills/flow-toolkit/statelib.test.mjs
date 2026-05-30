// statelib.test.mjs — Flow .flow/ 耐久狀態庫測試（node --test）
// 重點：append-only journal 讓「並行多 worker 的 dangling」都留得住（修單檔 state.json 互蓋硬傷）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from './statelib.mjs';

async function withRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowtest-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('init 建立 .flow/ 結構', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    assert.ok(existsSync(path.join(root, '.flow', 'manifest.json')));
    assert.ok(existsSync(path.join(root, '.flow', 'journal.ndjson')));
    assert.ok(existsSync(path.join(root, '.flow', 'ledger')));
    assert.ok(existsSync(path.join(root, '.flow', 'decisions')));
  });
});

test('manifest round-trip', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1', name: 'x' }] });
    const m = await S.readManifest(root);
    assert.equal(m.project, 'p');
    assert.equal(m.tasks.length, 1);
    assert.equal(m.tasks[0].id, 'F-1');
  });
});

test('ledger write/read/list', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeLedger(root, 'F-1', { state: 'building', branch: 'flow/F-1' });
    const l = await S.readLedger(root, 'F-1');
    assert.equal(l.state, 'building');
    assert.equal(l.branch, 'flow/F-1');
    assert.equal(l.id, 'F-1');
    assert.equal((await S.listLedger(root)).length, 1);
  });
});

test('journal append/read 多筆 + 帶時間戳', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.appendJournal(root, { ev: 'a', id: '1' });
    await S.appendJournal(root, { ev: 'b', id: '2' });
    const j = await S.readJournal(root);
    assert.equal(j.length, 2);
    assert.equal(j[0].ev, 'a');
    assert.equal(j[1].id, '2');
    assert.ok(j[0].t, 'journal 事件有 t 時間戳');
  });
});

test('transition 更新 ledger 並記 journal', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeLedger(root, 'F-1', { state: 'pending' });
    await S.transition(root, 'F-1', 'pending', 'building', { branch: 'flow/F-1' });
    const l = await S.readLedger(root, 'F-1');
    assert.equal(l.state, 'building');
    assert.equal(l.branch, 'flow/F-1');
    const j = await S.readJournal(root);
    assert.ok(j.some(e => e.ev === 'task.transition' && e.id === 'F-1' && e.to === 'building'));
  });
});

test('actionStart 無 actionDone → reconstruct dangling 抓到', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    await S.actionStart(root, 'F-1', 'building');
    const v = await S.reconstruct(root);
    assert.equal(v.dangling.length, 1);
    assert.equal(v.dangling[0].id, 'F-1');
    assert.equal(v.dangling[0].action, 'building');
  });
});

test('actionStart + actionDone → 無 dangling', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    await S.actionStart(root, 'F-1', 'building');
    await S.actionDone(root, 'F-1', 'building', 'ok');
    assert.equal((await S.reconstruct(root)).dangling.length, 0);
  });
});

// 關鍵：並行多 dangling（修 Flow 單檔 state.json 互蓋硬傷）
test('兩個並行 actionStart（不同 id）→ reconstruct 兩個 dangling 都在', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }, { id: 'F-2' }] });
    await S.actionStart(root, 'F-1', 'building');
    await S.actionStart(root, 'F-2', 'building');
    const v = await S.reconstruct(root);
    assert.equal(v.dangling.length, 2);
    assert.deepEqual(v.dangling.map(d => d.id).sort(), ['F-1', 'F-2']);
  });
});

test('decision round-trip + 記 journal', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.recordDecision(root, 'F-1', { question: 'q', choice: 'A', by: 'user' });
    assert.equal((await S.readDecision(root, 'F-1')).choice, 'A');
    assert.ok((await S.readJournal(root)).some(e => e.ev === 'decision' && e.id === 'F-1'));
  });
});

test('reconstruct：manifest task 無 ledger → pending 預設', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }, { id: 'F-2' }] });
    await S.writeLedger(root, 'F-1', { state: 'delivered' });
    const v = await S.reconstruct(root);
    assert.equal(v.tasks['F-1'].state, 'delivered');
    assert.equal(v.tasks['F-2'].state, 'pending');
  });
});

test('state.json 相容 bridge round-trip（無 BOM）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeStateJson(root, { task: 'F-1', phase: 'in_progress', tdd: 'green', verify: 'none', commit: 'none' });
    const st = await S.readStateJson(root);
    assert.equal(st.task, 'F-1');
    assert.equal(st.tdd, 'green');
    const raw = await readFile(path.join(root, '.flow', 'state.json'), 'utf8');
    assert.equal(raw.charCodeAt(0), '{'.charCodeAt(0), 'state.json 開頭無 BOM');
  });
});
