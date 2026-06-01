// statelib.test.mjs — Flow .flow/ 耐久狀態庫測試（node --test）
// 重點：append-only journal 讓「並行多 worker 的 dangling」都留得住（修單檔 state.json 互蓋硬傷）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
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

// ── tasks.md 同步：markTaskDone / flipCheckbox / idMatches / resolveId ──

test('idMatches：canonical 相等 + 尾段 token 容錯', () => {
  assert.ok(S.idMatches('F-1186-W0-5', 'F-1186-W0-5'));
  assert.ok(S.idMatches('F-1186-W0-5', 'W0-5'), 'canonical 結尾含短 token');
  assert.ok(S.idMatches('W0-5', 'F-1186-W0-5'), '反向也成立');
  assert.ok(!S.idMatches('F-1186-W0-5', 'W0-1'), '不同 task 不匹配');
  assert.ok(!S.idMatches('F-1186-W0-50', 'W0-5'), '不被 W0-5 誤吃 W0-50');
});

test('flipCheckbox：只翻對應 id 那行、保留其他、冪等', () => {
  const md = [
    '- [ ] **F-1186-W0-1 · DB**（REQ-06）',
    '- [ ] **F-1186-W0-2 · labels**（REQ-05）',
    '- [x] **F-1186-W0-3 · sort**（REQ-02）',
  ].join('\n');
  const r = S.flipCheckbox(md, 'F-1186-W0-2');
  assert.ok(r.found && r.changed);
  assert.match(r.text, /- \[x\] \*\*F-1186-W0-2/);
  assert.match(r.text, /- \[ \] \*\*F-1186-W0-1/, '其他行不動');
  // 冪等：再翻一次 changed=false
  const r2 = S.flipCheckbox(r.text, 'F-1186-W0-2');
  assert.ok(r2.found && !r2.changed, '已是 [x] → 不再變動');
});

test('flipCheckbox：CRLF 內容保留 CRLF', () => {
  const md = '- [ ] **F-1 · a**\r\n- [ ] **F-2 · b**\r\n';
  const r = S.flipCheckbox(md, 'F-1');
  assert.ok(r.changed);
  assert.ok(r.text.includes('\r\n'), '保留 CRLF');
});

test('resolveId：精確優先、唯一尾段匹配、無 manifest 原樣回', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1186-W0-1' }, { id: 'F-1186-W0-2' }] });
    assert.equal(await S.resolveId(root, 'F-1186-W0-1'), 'F-1186-W0-1');
    assert.equal(await S.resolveId(root, 'W0-2'), 'F-1186-W0-2', '短 token 解析成 canonical');
    assert.equal(await S.resolveId(root, 'ZZZ'), 'ZZZ', '無匹配原樣回');
  });
});

test('markTaskDone：翻 tasks.md [x] + ledger→delivered（一次原子）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1186-W0-1' }, { id: 'F-1186-W0-2' }] });
    await mkdir(path.join(root, 'specs'), { recursive: true });
    await writeFile(path.join(root, 'specs', 'tasks.md'),
      '- [ ] **F-1186-W0-1 · DB**\n- [ ] **F-1186-W0-2 · labels**\n', 'utf8');

    // 用短 token 呼叫也要能解析到 canonical
    const r = await S.markTaskDone(root, 'W0-2', { commit: 'abc1234' });
    assert.equal(r.id, 'F-1186-W0-2');
    assert.ok(r.tasksMd.changed, 'tasks.md 已翻 [x]');

    const md = await readFile(path.join(root, 'specs', 'tasks.md'), 'utf8');
    assert.match(md, /- \[x\] \*\*F-1186-W0-2/);
    assert.match(md, /- \[ \] \*\*F-1186-W0-1/, '另一個沒被動到');

    const l = await S.readLedger(root, 'F-1186-W0-2');
    assert.equal(l.state, 'delivered');
    assert.equal(l.commit, 'abc1234');
  });
});

test('markTaskDone：冪等（已 delivered 再呼叫不重複翻、可補 commit）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    await mkdir(path.join(root, 'specs'), { recursive: true });
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [ ] **F-1 · a**\n', 'utf8');
    const r1 = await S.markTaskDone(root, 'F-1');
    assert.equal(r1.alreadyDelivered, false);
    const r2 = await S.markTaskDone(root, 'F-1', { commit: 'deadbee' });
    assert.equal(r2.alreadyDelivered, true);
    assert.equal((await S.readLedger(root, 'F-1')).commit, 'deadbee', '冪等但能補 commit');
  });
});

test('markTaskDone：無 tasks.md 不炸、仍寫 ledger', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    const r = await S.markTaskDone(root, 'F-1');
    assert.equal(r.tasksMd.found, false);
    assert.equal((await S.readLedger(root, 'F-1')).state, 'delivered');
  });
});
