// statelib.test.mjs — Flow .flow/ 耐久狀態庫測試（node --test）
// 重點：append-only journal 讓「並行多 worker 的 dangling」都留得住（修單檔 state.json 互蓋硬傷）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    assert.ok(existsSync(path.join(root, '.flow', '.gitignore')));   // 版控政策檔隨 init 落地
  });
});

test('ensureFlowGitignore：忽略瞬時檔、耐久證據照常 track', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    const gi = await readFile(path.join(root, '.flow', '.gitignore'), 'utf8');
    // 瞬時/衍生檔在忽略清單
    for (const p of ['state.json', 'state.json.mode', 'monitor.port', '*.log', '*-reminded']) assert.ok(gi.includes(p), `應忽略 ${p}`);
    // 耐久證據不在忽略清單（照常 track）——逐字元行比對，避免被 *-reminded / *.log 之類 glob 誤判
    const lines = gi.split('\n').map(l => l.trim());
    for (const p of ['manifest.json', 'journal.ndjson', 'lessons.ndjson', 'ledger/', 'redteam/', 'verify/', 'decisions/']) assert.ok(!lines.includes(p), `不該忽略耐久檔 ${p}`);
  });
});

test('ensureFlowGitignore：冪等（第二次不動檔）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    const before = await readFile(path.join(root, '.flow', '.gitignore'), 'utf8');
    const changed = await S.ensureFlowGitignore(root);   // init 已寫過一次 → 這次應無變化
    const after = await readFile(path.join(root, '.flow', '.gitignore'), 'utf8');
    assert.equal(changed, false);
    assert.equal(after, before);
  });
});

test('ensureFlowGitignore：保留使用者自訂行、只換 managed block', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, '.flow'), { recursive: true });
    await writeFile(path.join(root, '.flow', '.gitignore'), 'my-scratch.tmp\n# 使用者自訂\n', 'utf8');
    const changed = await S.ensureFlowGitignore(root);
    assert.equal(changed, true);
    const gi = await readFile(path.join(root, '.flow', '.gitignore'), 'utf8');
    assert.ok(gi.includes('my-scratch.tmp'), '應保留使用者原有行');
    assert.ok(gi.includes('# 使用者自訂'), '應保留使用者註解');
    assert.ok(gi.includes('state.json'), '應補上 managed block');
    // 再跑一次仍冪等（不重複塞 block）
    await S.ensureFlowGitignore(root);
    const gi2 = await readFile(path.join(root, '.flow', '.gitignore'), 'utf8');
    assert.equal((gi2.match(/# >>> flow-state/g) || []).length, 1, 'managed block 只該有一份');
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

// 關鍵回歸：state.json.tasks 的未交付 task（in-progress/todo）必須被 reconstruct 納入。
// 這正是 /flow-resume「接不上、誤報全交付」的根因——舊 reconstruct 只讀 ledger/manifest，
// 漏掉只存在 state.json 的整波 task（如 F-DASH-4a/4b/4c）。
test('reconstruct：併入 state.json.tasks 未交付 task（修 /flow-resume 漏算盲點）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });        // manifest 空（真實漂移情境）
    await S.writeLedger(root, 'F-A', { state: 'delivered' }); // ledger 只有已交付的
    await S.writeStateJson(root, {                            // state.json 才有完整 task 表
      tasks: {
        'F-A': { status: 'done', blockedBy: [] },
        'F-B': { status: 'in-progress', blockedBy: [] },
        'F-C': { status: 'todo', blockedBy: ['F-B'] },
      },
    });
    const v = await S.reconstruct(root);
    assert.equal(Object.keys(v.tasks).length, 3, '三個 task 都在（非只 1 個 delivered）');
    assert.equal(v.tasks['F-A'].state, 'delivered', 'ledger 權威 delivered 覆蓋 state.json');
    assert.equal(v.tasks['F-B'].state, 'building', 'in-progress → building（過去被漏）');
    assert.equal(v.tasks['F-C'].state, 'pending', 'todo → pending（過去被漏）');
    assert.deepEqual(v.tasks['F-C'].blockedBy, ['F-B'], 'blockedBy 帶出供 pickNext 用');
    assert.deepEqual(v.order.slice(0, 3), ['F-A', 'F-B', 'F-C'], 'order 保留 state.json 排序');
  });
});

test('reconstruct：ledger-only task（不在 state.json）仍納入並附在 order 尾', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeLedger(root, 'F-OLD', { state: 'delivered' });   // 前迭代遺留、不在 state.json
    await S.writeStateJson(root, { tasks: { 'F-NEW': { status: 'todo', blockedBy: [] } } });
    const v = await S.reconstruct(root);
    assert.equal(v.tasks['F-OLD'].state, 'delivered');
    assert.equal(v.tasks['F-NEW'].state, 'pending');
    assert.ok(v.order.includes('F-OLD') && v.order.includes('F-NEW'));
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

test('resolveId：歧義（同尾段對到多個 canonical）→ 拒絕並列候選，不靜默挑一個', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-A-W0-5' }, { id: 'F-B-W0-5' }] });
    await assert.rejects(
      () => S.resolveId(root, 'W0-5'),
      (e) => e.code === 'AMBIGUOUS_ID' && e.candidates.length === 2,
      '歧義要丟錯，避免翻錯行/開幽靈 ledger'
    );
    assert.equal(await S.resolveId(root, 'F-A-W0-5'), 'F-A-W0-5', '完整 canonical 不受影響');
  });
});

test('markTaskDone：翻 tasks.md [x] + ledger→delivered（一次原子）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1186-W0-1' }, { id: 'F-1186-W0-2' }] });
    await mkdir(path.join(root, 'specs'), { recursive: true });
    await writeFile(path.join(root, 'specs', 'tasks.md'),
      '- [ ] **F-1186-W0-1 · DB**\n- [ ] **F-1186-W0-2 · labels**\n', 'utf8');
    await S.writeStateJson(root, { verify: 'ok:e2e', tdd: 'green' });   // done 閘門需要真綠燈

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

test('markTaskDone：冪等（已 delivered 再呼叫不重複翻、可補 commit、不再過閘門）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    await mkdir(path.join(root, 'specs'), { recursive: true });
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [ ] **F-1 · a**\n', 'utf8');
    await S.writeStateJson(root, { verify: 'ok:e2e', tdd: 'green' });
    const r1 = await S.markTaskDone(root, 'F-1');
    assert.equal(r1.alreadyDelivered, false);
    // 交付後綠燈已歸零（verify=none），但冪等重呼（補 commit）不過閘門、不被擋
    const r2 = await S.markTaskDone(root, 'F-1', { commit: 'deadbee' });
    assert.equal(r2.alreadyDelivered, true);
    assert.equal((await S.readLedger(root, 'F-1')).commit, 'deadbee', '冪等但能補 commit');
  });
});

test('markTaskDone：無 tasks.md 不炸、仍寫 ledger', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    await S.writeStateJson(root, { verify: 'ok:smoke', tdd: 'n/a' });
    const r = await S.markTaskDone(root, 'F-1');
    assert.equal(r.tasksMd.found, false);
    assert.equal((await S.readLedger(root, 'F-1')).state, 'delivered');
  });
});

// ── done 閘門（標完成的單點執法者：verify/tdd 須綠 + 堵 stale 綠燈白嫖）──

test('markTaskDone：done 閘門——verify 空/none → 拒標 delivered、tasks.md 不翻', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    await mkdir(path.join(root, 'specs'), { recursive: true });
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [ ] **F-1 · a**\n', 'utf8');
    await S.writeStateJson(root, { verify: 'none', tdd: 'green' });
    await assert.rejects(() => S.markTaskDone(root, 'F-1'), (e) => e.code === 'VERIFY_GATE');
    const md = await readFile(path.join(root, 'specs', 'tasks.md'), 'utf8');
    assert.match(md, /- \[ \] \*\*F-1/, '閘門擋下時 tasks.md 不動');
    assert.notEqual((await S.readLedger(root, 'F-1')).state, 'delivered', 'ledger 也不動');
    // state.json 整個缺 verify 欄（從沒跑過 /flow-verify）同樣擋
    await S.writeStateJson(root, {});
    await assert.rejects(() => S.markTaskDone(root, 'F-1'), (e) => e.code === 'VERIFY_GATE');
  });
});

test('markTaskDone：交付成功即把 state.json verify/tdd 歸零（堵 stale 綠燈白嫖）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }, { id: 'F-2' }] });
    await S.writeStateJson(root, { phase: 'building', verify: 'ok:e2e', tdd: 'green' });
    await S.markTaskDone(root, 'F-1');
    const st = await S.readStateJson(root);
    assert.equal(st.verify, 'none', '交付即歸零');
    assert.equal(st.tdd, 'none');
    assert.equal(st.phase, 'building', '其他欄位保留');
    // 下一個 task 借不到 F-1 的舊綠燈
    await assert.rejects(() => S.markTaskDone(root, 'F-2'), (e) => e.code === 'VERIFY_GATE');
  });
});

// ── conflictZone 越界檢查（同 repo 平行檔案安全閘門） ──

test('fileInZone：前綴 + 邊界，不誤吃相似前綴', () => {
  assert.ok(S.fileInZone('features/items/list.tsx', 'features/items'), '/ 邊界');
  assert.ok(S.fileInZone('api/items.ts', 'api/items'), '. 邊界');
  assert.ok(S.fileInZone('migrations/001.sql', 'migrations/'), '尾斜線正規化');
  assert.ok(!S.fileInZone('features/itemsmore/x.ts', 'features/items'), '不誤吃 itemsmore');
  assert.ok(!S.fileInZone('package.json', 'features/items'));
  assert.ok(S.fileInZone('app/x/y.tsx', 'app/**/*.tsx'), 'glob ** + *');
  assert.ok(!S.fileInZone('app/x/y.ts', 'app/**/*.tsx'), 'glob 副檔名不符');
});

test('fileInZone：globstar 零層匹配 + 大小寫不敏感（Windows/macOS）', () => {
  assert.ok(S.fileInZone('src/index.ts', 'src/**/*.ts'), '**/ 零層也匹配（src/index.ts ∈ src/**/*.ts）');
  assert.ok(S.fileInZone('src/a/b/c.ts', 'src/**/*.ts'), '**/ 多層仍匹配');
  assert.ok(S.fileInZone('x.ts', '**/*.ts'), '開頭 **/ 零層');
  assert.ok(!S.fileInZone('src/a/b.tsx', 'src/**/*.ts'), '副檔名仍要符');
  assert.ok(S.fileInZone('SRC/Index.TS', 'src/**/*.ts'), 'glob 大小寫不敏感');
  assert.ok(S.fileInZone('Features/Items/list.tsx', 'features/items'), '前綴 zone 大小寫不敏感');
});

test('fileInZone：中文路徑段（git core.quotepath=false 輸出 UTF-8 原文後可正常比對）', () => {
  assert.ok(S.fileInZone('src/報表/匯出.ts', 'src/報表'), '中文前綴 zone');
  assert.ok(S.fileInZone('src/報表/a/匯出.ts', 'src/**/*.ts'), '中文路徑過 globstar');
  assert.ok(!S.fileInZone('src/儀表板/x.ts', 'src/報表'), '不同中文目錄不誤吃');
});

test('checkScope：歸屬 / 越界 / 忽略 .flow specs', () => {
  const zones = { 'F-1': ['features/auth-ui', 'api/auth'], 'F-2': ['features/items', 'api/items'] };
  const r = S.checkScope([
    'features/auth-ui/login.tsx',   // → F-1
    'api/items/list.ts',            // → F-2
    'package.json',                 // 越界（共用檔）
    '.flow/state.json',             // 忽略
    'specs/tasks.md',               // 忽略
  ], zones);
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations.map((v) => v.file), ['package.json']);
  assert.equal(r.attributed.find((a) => a.file === 'features/auth-ui/login.tsx').feature, 'F-1');
  assert.equal(r.attributed.find((a) => a.file === 'api/items/list.ts').feature, 'F-2');
});

test('checkScope：conflictZone 重疊（規劃問題）標 overlap 但不算越界', () => {
  const r = S.checkScope(['shared/x/util.ts'], { 'F-1': ['shared/x'], 'F-2': ['shared/x'] });
  assert.equal(r.ok, true, '重疊仍在某 zone 內，不算越界');
  assert.equal(r.overlaps.length, 1);
  assert.deepEqual(r.overlaps[0].features.sort(), ['F-1', 'F-2']);
});

test('checkScope：全部在 zone 內 → ok', () => {
  const r = S.checkScope(['features/a/x.ts', 'features/a/y.ts'], { 'F-1': ['features/a'] });
  assert.ok(r.ok);
  assert.equal(r.violations.length, 0);
});

// ── stall 偵測（doom-loop 斷路器）：runner 辨識 + 失敗指紋 + 連續計數 ──
// 自駕無花費上限時的唯一防失控閘門。偵測走真實 exit code + journal（模型偽造/遺忘不了）。

test('isRunnerCommand：辨識 test + build/typecheck runner、排除套件管理 install 與純印出', () => {
  assert.ok(S.isRunnerCommand('pytest tests/'));
  assert.ok(S.isRunnerCommand('python -m pytest -q'));
  assert.ok(S.isRunnerCommand('npm test'));
  assert.ok(S.isRunnerCommand('npm run test:e2e'));
  assert.ok(S.isRunnerCommand('npx playwright test'));
  assert.ok(S.isRunnerCommand('go test ./...'));
  assert.ok(S.isRunnerCommand('node --test foo.test.mjs'));
  assert.ok(S.isRunnerCommand('vitest run'));
  assert.ok(S.isRunnerCommand('python -m unittest'));
  assert.ok(S.isRunnerCommand('./gradlew test'));
  // 擴含會回 exit code 的 build/typecheck/lint 命令型迴圈（rank 5 非 runner doom loop）
  assert.ok(S.isRunnerCommand('tsc --noEmit'), 'tsc');
  assert.ok(S.isRunnerCommand('npm run build'), 'build 迴圈也要接到');
  assert.ok(S.isRunnerCommand('pnpm run typecheck'), 'typecheck');
  assert.ok(S.isRunnerCommand('go build ./...'), 'go build');
  // 偽陽排除
  assert.ok(!S.isRunnerCommand('git status'));
  assert.ok(!S.isRunnerCommand('ls -la'));
  assert.ok(!S.isRunnerCommand('npm install'), '裝套件非 runner');
  assert.ok(!S.isRunnerCommand('npm install jest'), '裝 jest 含 runner 字樣但仍非 runner');
  assert.ok(!S.isRunnerCommand('pip install pytest'), '裝 pytest 仍非 runner');
  assert.ok(!S.isRunnerCommand('echo pytest'), '純印出含 runner 字樣不算');
});

test('runnerBucket：去 flag、同測試重跑同桶、不同檔不同桶', () => {
  assert.equal(S.runnerBucket('pytest tests/test_x.py -v --tb=short'), S.runnerBucket('pytest tests/test_x.py'), '同測試去 flag 後同桶');
  assert.notEqual(S.runnerBucket('pytest tests/test_x.py'), S.runnerBucket('pytest tests/test_y.py'), '不同檔不同桶');
  assert.equal(S.runnerBucket('NPM RUN TEST'), S.runnerBucket('npm test'), 'C-13：npm run <s> ≡ npm <s>＋小寫正規化');
  assert.equal(S.runnerBucket('npm test'), 'npm test');
  assert.ok(S.runnerBucket('') === '_runner', '空命令有 fallback key');
  // C-13：cd 前綴/加 flag/串接前置指令都摺成穩定同桶（doom-loop 連敗不被換寫法歸零）；不同 cd 目標不誤併（monorepo）
  assert.equal(S.runnerBucket('cd packages/api && npm test'), S.runnerBucket('cd packages/api && npm test --silent'), 'cd 目標＋runner 相同→同桶');
  assert.notEqual(S.runnerBucket('cd packages/api && npm test'), S.runnerBucket('cd packages/web && npm test'), '不同 cd 目標→不同桶');
  assert.equal(S.runnerBucket('export CI=1 && pytest tests/test_x.py'), S.runnerBucket('pytest tests/test_x.py'), '前置指令不影響 runner 桶');
});

test('verifyFailSig：抽失敗特徵行（非 banner）；同失敗去噪後穩定、不同失敗不同指紋', () => {
  // 過鬆防呆：首行同為 pytest banner，但失敗 test 不同 → 不同指紋（舊「取首行」會誤判同指紋）
  const banner = '==== test session starts ====';
  const a = S.verifyFailSig('pytest', `${banner}\nFAILED tests/test_a.py::test_x - AssertionError: 1 != 2`);
  const b = S.verifyFailSig('pytest', `${banner}\nFAILED tests/test_b.py::test_y - ImportError: foo`);
  assert.notEqual(a, b, 'banner 相同但失敗不同 → 不同指紋（不被 banner 併成偽 stall）');
  // 過嚴防呆：同一個失敗，但訊息含不同耗時/絕對路徑/行號 → 去噪後同指紋（才湊得到連 3）
  const c1 = S.verifyFailSig('pytest tests/test_a.py', 'FAILED test_x - took 3.2s\n  at /home/alice/proj/x.py:42');
  const c2 = S.verifyFailSig('pytest tests/test_a.py', 'FAILED test_x - took 9.7s\n  at /home/bob/work/x.py:88');
  assert.equal(c1, c2, '同失敗但路徑/耗時/行號變動 → 去噪後同指紋（斷路器才累得到）');
  assert.ok(/^[0-9a-f]{8,}$/.test(a), '指紋是 hex');
  // 撈不到特徵行 → fallback 首行（不炸）
  assert.ok(S.verifyFailSig('cmd', 'just some non-failure output').length >= 8);
});

test('stallCount：尾端同 sig 連續、bucket 精確比對、成功 ok 歸 0、換 sig 歸 1', () => {
  const j = [
    { ev: 'verify.attempt', id: 'b1', sig: 'X' },
    { ev: 'task.transition', id: 'b1' },
    { ev: 'verify.attempt', id: 'b1', sig: 'Y' },
    { ev: 'verify.attempt', id: 'b1', sig: 'Y' },
    { ev: 'verify.attempt', id: 'b1', sig: 'Y' },
  ];
  assert.equal(S.stallCount(j, 'b1'), 3, '尾端 Y 連 3');
  assert.equal(S.stallCount(j, 'b2'), 0, '不同 bucket 不算');
  assert.equal(S.stallCount(j.concat([{ ev: 'verify.attempt', id: 'b1', sig: 'Z' }]), 'b1'), 1, '換 sig 歸 1');
  assert.equal(S.stallCount(j.concat([{ ev: 'verify.attempt', id: 'b1', sig: 'ok' }]), 'b1'), 0, '末筆成功(ok) 歸 0');
  // 關鍵回歸（生產形狀）：另一 bucket 的不同失敗交錯插進來，不該沖掉 b1 的連敗
  const interleaved = [
    { ev: 'verify.attempt', id: 'b1', sig: 'Y' },
    { ev: 'verify.attempt', id: 'b2', sig: 'Q' },
    { ev: 'verify.attempt', id: 'b1', sig: 'Y' },
    { ev: 'verify.attempt', id: 'b2', sig: 'R' },
    { ev: 'verify.attempt', id: 'b1', sig: 'Y' },
  ];
  assert.equal(S.stallCount(interleaved, 'b1'), 3, '跨 bucket 交錯失敗不沖掉本桶連敗（修 _current 串味）');
});

test('recordVerifyAttempt → journal 有 verify.attempt，stallCount 連 3 抓到', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    const bucket = S.runnerBucket('pytest tests/test_x.py');
    await S.recordVerifyAttempt(root, bucket, 'SIG', 1);
    await S.recordVerifyAttempt(root, bucket, 'SIG', 1);
    await S.recordVerifyAttempt(root, bucket, 'SIG', 1);
    const jr = await S.readJournal(root);
    assert.equal(S.stallCount(jr, bucket), 3);
  });
});

test('safeId：含路徑分隔/.. 的 id 寫入被拒（防自駕傳惡意 id 寫出 .flow 之外）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await assert.rejects(() => S.recordDecision(root, '../../evil', { choice: 'x' }), (e) => e.code === 'UNSAFE_ID');
    await assert.rejects(() => S.writeLedger(root, 'a/b', { state: 'x' }), (e) => e.code === 'UNSAFE_ID');
    await S.recordDecision(root, 'F-1', { choice: 'ok' });   // 正常 id 不受影響
    assert.equal((await S.readDecision(root, 'F-1')).choice, 'ok');
  });
});

// ── 失敗記憶（防計畫再生撞同一面牆）：append-only、cap 5、delivered task 自動濾掉 ──

test('appendLesson / readLessons round-trip + 硬上限 5 筆丟最舊', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    for (let i = 1; i <= 7; i++) await S.appendLesson(root, { id: 'F-1', failedApproach: 'a' + i, why: 'w' + i });
    const ls = await S.readLessons(root);
    assert.equal(ls.length, 5, '只留最近 5 筆');
    assert.equal(ls[0].failedApproach, 'a3', '最舊兩筆被丟');
    assert.equal(ls[4].failedApproach, 'a7');
    assert.ok((await S.readJournal(root)).some(e => e.ev === 'lesson'));
  });
});

test('reconstruct：帶出 active lessons，delivered task 的 lesson 自動濾掉', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }, { id: 'F-2' }] });
    await S.appendLesson(root, { id: 'F-1', failedApproach: 'mock fallback', why: '真依賴未 ready' });
    await S.appendLesson(root, { id: 'F-2', failedApproach: 'wrong index', why: 'N+1' });
    await S.writeLedger(root, 'F-2', { state: 'delivered' });   // F-2 已交付 → 其死路不再相關
    const v = await S.reconstruct(root);
    assert.equal(v.lessons.length, 1, 'delivered 的濾掉');
    assert.equal(v.lessons[0].id, 'F-1');
  });
});

// ── specReadiness：凍結前 requirements 就緒度（純函式，需求收斂閘門的核心）──
const READY_MD = [
  '# 需求', 'REQ-001：當 X 時，系統應 Y。',
  'REQ-E2E-001：登入 → 首頁 → 操作 → 斷言。',
  'REQ-PERF-001：dashboard LCP < 2.5s（p95）。',
  '### 開放問題', '無',
].join('\n');

test('specReadiness：齊備且 ### 開放問題=無 → 零 problems', () => {
  const r = S.specReadiness(READY_MD);
  assert.equal(r.open.length, 0);
  assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
});

test('specReadiness：### 開放問題 有未拍板 bullet → 標記未收斂', () => {
  const md = READY_MD.replace('### 開放問題\n無', '### 開放問題\n- 刪父層時子資源連帶失效或保留？\n- 列表預設排序？');
  const r = S.specReadiness(md);
  assert.equal(r.open.length, 2);
  assert.match(r.problems.join('\n'), /開放問題.*未收斂/);
});

test('specReadiness：開放問題段在下一個同級標題後結束（不誤吃後段內容）', () => {
  const md = READY_MD.replace('### 開放問題\n無', '### 開放問題\n無\n\n### 延後決策\n- DEFERRED：付款幣別待商務拍板（暫用 TWD）');
  const r = S.specReadiness(md);
  assert.equal(r.open.length, 0, '延後決策段不算開放問題');
  assert.equal(r.problems.length, 0);
});

test('specReadiness：缺 REQ-E2E / REQ-PERF 各自報缺', () => {
  const noE2E = S.specReadiness('REQ-001：x\nREQ-PERF-001：N/A\n### 開放問題\n無');
  assert.match(noE2E.problems.join('\n'), /REQ-E2E/);
  const noPerf = S.specReadiness('REQ-001：x\nREQ-E2E-001：journey\n### 開放問題\n無');
  assert.match(noPerf.problems.join('\n'), /REQ-PERF/);
});

test('specReadiness：無 ### 開放問題 標題 → problems 點名缺段（W0-1 堵「整段不寫＝閘門恆綠」）', () => {
  const r = S.specReadiness('REQ-001：當 X 時，系統應 Y。\nREQ-E2E-001：登入 → 首頁 → 斷言。\nREQ-PERF-001：LCP < 2.5s');
  assert.equal(r.open.length, 0, '段不存在 open 仍為零');
  assert.match(r.problems.join('\n'), /開放問題.*段/, '缺段本身就是 problem');
});

test('specReadiness：placeholder（TODO/TBD/待定/???）→ problems 點名行號（W0-2）', () => {
  const md = READY_MD.replace('REQ-001：當 X 時，系統應 Y。', 'REQ-001：當 X 時，系統應 Y。\nREQ-002：權限規則 TBD\n細節 ???');
  const r = S.specReadiness(md);
  assert.match(r.problems.join('\n'), /placeholder/);
  assert.match(r.problems.join('\n'), /TBD/);
});

test('specReadiness：REQ 行含糊詞無數字 → 只進 warnings 不進 problems（W0-2 防 Goodhart 誤殺）', () => {
  const md = READY_MD.replace('REQ-001：當 X 時，系統應 Y。', 'REQ-001：當查詢時，系統應快速回應。');
  const r = S.specReadiness(md);
  assert.equal(r.problems.length, 0, '含糊詞不擋');
  assert.match(r.warnings.join('\n'), /含糊詞/);
  // 同句有數字＝已量化 → 不警告
  const r2 = S.specReadiness(READY_MD.replace('REQ-001：當 X 時，系統應 Y。', 'REQ-001：當查詢時，系統應快速回應（p95 < 300ms）。'));
  assert.equal(r2.warnings.filter(w => /含糊詞/.test(w)).length, 0);
});

test('specReadiness：非 E2E/PERF 的 REQ 行缺規範動詞 → warnings；READY_MD 零警告', () => {
  const r = S.specReadiness(READY_MD.replace('REQ-001：當 X 時，系統應 Y。', 'REQ-001：使用者可以登入。'));
  assert.match(r.warnings.join('\n'), /規範動詞/);
  assert.equal(S.specReadiness(READY_MD).warnings.length, 0, '合格 fixture 不該有噪音警告');
});

test('specReadiness：REQ-E2E 缺 journey 結構 → problems；箭頭鏈 ≥3 段或欄位式 → 過（W0-4）', () => {
  // 單行只描述目標頁（無箭頭鏈）→ 擋
  const bad = S.specReadiness(READY_MD.replace('REQ-E2E-001：登入 → 首頁 → 操作 → 斷言。', 'REQ-E2E-001：使用者能在 dashboard 看到清單。'));
  assert.match(bad.problems.join('\n'), /REQ-E2E-001.*journey 結構/);
  // 欄位式（入口/步驟≥2/斷言≥1）→ 過
  const fieldForm = READY_MD.replace('REQ-E2E-001：登入 → 首頁 → 操作 → 斷言。', [
    'REQ-E2E-001：訪客完成註冊',
    '- 入口：/（landing 頁）',
    '- 步驟：',
    '  1. 點「註冊」',
    '  2. 填 email/密碼送出',
    '- 斷言：導向 /dashboard 且顯示空狀態',
  ].join('\n'));
  const ok = S.specReadiness(fieldForm);
  assert.equal(ok.problems.length, 0, JSON.stringify(ok.problems));
  // 欄位式缺步驟（只 1 步）→ 擋
  const oneStep = fieldForm.replace('  2. 填 email/密碼送出\n', '');
  assert.match(S.specReadiness(oneStep).problems.join('\n'), /REQ-E2E-001/);
});

test('specReadiness：REQ-PERF 標 N/A → perfNA=true（豁免檔對賬由 CLI 做）；有數字 → false（W0-3）', () => {
  assert.equal(S.specReadiness(READY_MD).perfNA, false);
  assert.equal(S.specReadiness(READY_MD.replace('REQ-PERF-001：dashboard LCP < 2.5s（p95）。', 'REQ-PERF-001：N/A')).perfNA, true);
});

test('specReadiness：perfNA 同義詞/次行變體全數要豁免；真 budget 提到裸 NA 不誤中（覆核 B3/FP2）', () => {
  const withPerf = v => READY_MD.replace('REQ-PERF-001：dashboard LCP < 2.5s（p95）。', v);
  // 無量化（同義詞洗白）→ 一律 perfNA
  for (const v of ['REQ-PERF-001：不適用（內部工具）', 'REQ-PERF-001：無效能敏感路徑', 'REQ-PERF-001：N.A.', 'REQ-PERF-001：Ｎ／Ａ', 'REQ-PERF-001：\n- N/A（無敏感路徑）'])
    assert.equal(S.specReadiness(withPerf(v)).perfNA, true, v);
  // 真 budget 含裸 NA（區域縮寫）→ 有數字＝已量化，不誤中、不逼假豁免
  assert.equal(S.specReadiness(withPerf('REQ-PERF-001：NA 區域用戶 dashboard 首屏 LCP < 2.5s（p95）。')).perfNA, false);
});

test('specReadiness：開放問題項寫成子標題（#### 問題）也算 open item（覆核 B8）', () => {
  const md = READY_MD.replace('### 開放問題\n無', '### 開放問題\n#### 是否支援 SSO？\n#### 資料保留幾天？');
  const r = S.specReadiness(md);
  assert.equal(r.open.length, 2, '子標題不能被 heading 分支吞掉');
});

test('specReadiness：總覽/追溯行不是 REQ-E2E 結構的萬用通行證（覆核 B7）', () => {
  // 三條定義全是零結構句，另有一行含三個 id 的箭頭總覽——不得洗白
  const md = [
    '# 需求', 'REQ-001：當 X 時，系統應 Y。',
    'REQ-E2E-001：使用者能看到清單。', 'REQ-E2E-002：使用者能看到明細。',
    'journey 順序：REQ-E2E-001 → REQ-E2E-002 → 完成',
    'REQ-PERF-001：LCP < 2.5s。', '### 開放問題', '無',
  ].join('\n');
  const r = S.specReadiness(md);
  assert.match(r.problems.join('\n'), /REQ-E2E-001/);
  assert.match(r.problems.join('\n'), /REQ-E2E-002/);
});

test('specReadiness：placeholder 變體與誤殺邊界（覆核 B9/FP1）', () => {
  const base = v => READY_MD.replace('REQ-001：當 X 時，系統應 Y。', v);
  // zh-TW 變體要抓：全形？？？、待確認、未定、TBC
  for (const v of ['REQ-002：權限規則？？？', 'REQ-002：權限規則待確認', 'REQ-002：配額 TBC', 'REQ-002：排序規則未定'])
    assert.match(S.specReadiness(base(v)).problems.join('\n'), /placeholder/, v);
  // 領域名詞/複合詞不誤殺：todo-list app 的 TODO、電商「待補貨」、「未定義」
  for (const v of ['REQ-002：當使用者新增 TODO 項目時，系統應存入清單。', 'REQ-002：當商品狀態為待補貨時，系統應顯示補貨提示。', 'REQ-002：若欄位未定義，系統應回 400。'])
    assert.equal(S.specReadiness(base(v)).problems.filter(p => /placeholder/.test(p)).length, 0, v);
});

test('specReadiness：延後決策段內 placeholder 降 warning 不擋（覆核 I1——逃生口不能被自家閘門堵死）', () => {
  const md = READY_MD + '\n### 延後決策\n- 排序欄位待定（AI 建議預設 createdAt，已 flow-state decision 記錄）';
  const r = S.specReadiness(md);
  assert.equal(r.problems.filter(p => /placeholder/.test(p)).length, 0, '合法逃生寫法不 exit 2');
  assert.match(r.warnings.join('\n'), /延後決策段/, '仍留提醒可稽核');
});

test('specReadiness：標題行式 REQ（內文在次行）不誤報缺規範動詞；追溯行不警告（覆核 FP4）', () => {
  const md = READY_MD.replace('REQ-001：當 X 時，系統應 Y。', 'REQ-001：訂單建立\n當使用者送出表單時，系統應建立訂單並回 201。\nREQ-005 → F-1（追溯對照）');
  const r = S.specReadiness(md);
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
});

// ── REQ-E2E 覆蓋對賬（extractReqE2E / coverageAudit）：完成謂詞的機讀核心 ──

test('extractReqE2E：抽出去重、保序、大小寫正規化', () => {
  const md = [
    'REQ-E2E-001：登入 journey。', '一些散文 REQ-E2E-002 內嵌。',
    'REQ-E2E-001 又出現一次（去重）。', '小寫 req-e2e-003 也算。',
    'REQ-PERF-001 不是 E2E、REQ-005 也不是。',
  ].join('\n');
  assert.deepEqual(S.extractReqE2E(md), ['REQ-E2E-001', 'REQ-E2E-002', 'REQ-E2E-003']);
  assert.deepEqual(S.extractReqE2E(''), []);
});

test('coverageAudit：缺記錄→missing、fail→failed、pass/n-a→covered、全覆蓋→ok', () => {
  const reqIds = ['REQ-E2E-001', 'REQ-E2E-002', 'REQ-E2E-003'];
  const recs = [
    { id: 'REQ-E2E-001', status: 'pass', evidence: 'trace1' },
    { id: 'REQ-E2E-002', status: 'fail' },
    // REQ-E2E-003 無記錄
  ];
  const a = S.coverageAudit(reqIds, recs);
  assert.equal(a.ok, false);
  assert.deepEqual(a.covered, ['REQ-E2E-001']);
  assert.deepEqual(a.missing, ['REQ-E2E-003']);
  assert.deepEqual(a.failed.map(f => f.id), ['REQ-E2E-002']);
  // 補齊：002 轉 pass、003 標 n/a → 全覆蓋
  const a2 = S.coverageAudit(reqIds, [
    { id: 'REQ-E2E-001', status: 'pass', evidence: 't' },
    { id: 'REQ-E2E-002', status: 'pass', evidence: 't' },
    { id: 'req-e2e-003', status: 'n/a', evidence: '無法自動化' },   // 大小寫不敏感比對
  ]);
  assert.equal(a2.ok, true, JSON.stringify(a2));
  assert.equal(a2.covered.length, 3);
});

test('coverageAudit：記錄了但 spec 查無 → orphan，提示但不擋 ok', () => {
  const a = S.coverageAudit(['REQ-E2E-001'], [
    { id: 'REQ-E2E-001', status: 'pass', evidence: 't' },
    { id: 'REQ-E2E-099', status: 'pass', evidence: 't' },   // spec 沒有這條
  ]);
  assert.equal(a.ok, true, 'orphan 不影響 ok');
  assert.deepEqual(a.orphans, ['REQ-E2E-099']);
});

// ── 互動原型走查對賬（mockupAudit）：mockup-check 閘門的純核心 ──

test('mockupAudit：走查台列齊每條 REQ-E2E → missingReq 空；缺卡 → 點名', () => {
  const req = 'REQ-E2E-001：登入 journey。\nREQ-E2E-002：下單 journey。';
  const full = '<h2>REQ-E2E-001</h2><a href="login.html">走</a><h2>req-e2e-002</h2><a href="order.html">走</a>';
  assert.deepEqual(S.mockupAudit(req, full).missingReq, [], '大小寫不敏感、全列即空');
  const partial = S.mockupAudit(req, '<h2>REQ-E2E-001</h2><a href="login.html">走</a>');
  assert.deepEqual(partial.missingReq, ['REQ-E2E-002'], '缺卡要點名');
});

test('mockupAudit：hrefs 只收本地 .html（去重、去 #?、去反斜線），外部/絕對/錨點不收', () => {
  const html = [
    '<a href="pages/list.html?tab=1">a</a>', '<a href="pages\\detail.html#top">b</a>',
    '<a href="pages/list.html">重複</a>', '<a href="https://x.y/z.html">外部</a>',
    '<a href="//cdn.z/a.html">協定相對</a>', '<a href="/abs.html">絕對路徑</a>',
    '<a href="#sec">錨點</a>', '<a href="mailto:a@b.c">信</a>', '<a href="app.js">非 html</a>',
  ].join('\n');
  assert.deepEqual(S.mockupAudit('', html).hrefs, ['pages/list.html', 'pages/detail.html']);
});

test('mockupAudit：requirements 無 REQ-E2E → reqIds 空、不誤報缺卡', () => {
  const a = S.mockupAudit('REQ-001：非 E2E。', '<a href="p.html">x</a>');
  assert.deepEqual(a.reqIds, []);
  assert.deepEqual(a.missingReq, []);
});

test('mockupPageProblems：有 app.js＋互動元素 → 空；空殼頁 → 兩項點名（W0-8）', () => {
  assert.deepEqual(S.mockupPageProblems('<html><script src="../app.js"></script><button>登入</button></html>'), []);
  const shell = S.mockupPageProblems('<html><h1>Dashboard</h1><p>lorem</p></html>');
  assert.equal(shell.length, 2, JSON.stringify(shell));
  assert.match(shell.join('\n'), /app\.js/);
  assert.match(shell.join('\n'), /互動元素/);
  assert.deepEqual(S.mockupPageProblems('<script src="app.js"></script><form><input></form>'), [], 'form/input 也算互動');
});

// ── 互動原型定版凍結（mockup-index）：與 req-index 同構的漂移偵測 ──

test('mockupAggHash：與檔案順序無關、內容變即變', () => {
  const a = S.mockupAggHash({ 'index.html': 'h1', 'pages/login.html': 'h2' });
  const b = S.mockupAggHash({ 'pages/login.html': 'h2', 'index.html': 'h1' });
  assert.equal(a, b, '順序無關');
  assert.notEqual(a, S.mockupAggHash({ 'index.html': 'h1x', 'pages/login.html': 'h2' }));
});

test('mockupHashProblem：無 index 向後相容放行；相符 null；改動/刪除/新增逐類點名；index 損毀明講', () => {
  const files = { 'index.html': 'h1', 'pages/login.html': 'h2' };
  const idx = { files, aggHash: S.mockupAggHash(files) };
  assert.equal(S.mockupHashProblem(null, files), null, '舊專案無 index 不擋');
  assert.equal(S.mockupHashProblem(idx, { ...files }), null, '相符放行');
  assert.match(S.mockupHashProblem(idx, { 'index.html': 'h1改', 'pages/login.html': 'h2' }), /改動 index\.html/);
  assert.match(S.mockupHashProblem(idx, { 'index.html': 'h1' }), /刪除 pages\/login\.html/);
  assert.match(S.mockupHashProblem(idx, { ...files, 'pages/new.html': 'h3' }), /新增 pages\/new\.html/);
  assert.match(S.mockupHashProblem({ files }, files), /損毀/, '缺 aggHash＝索引損毀要明講');
});

test('mockupFileHashes：只收文字資產、遞迴子目錄、行尾正規化（autocrlf 不算漂移）', async () => {
  await withRoot(async (root) => {
    const dir = path.join(root, 'specs', 'ui-mockups');
    await mkdir(path.join(dir, 'pages'), { recursive: true });
    await writeFile(path.join(dir, 'index.html'), '<h1>走查台</h1>\n', 'utf8');
    await writeFile(path.join(dir, 'tokens.css'), ':root { --c: red }\n', 'utf8');
    await writeFile(path.join(dir, 'pages', 'login.html'), '<button>登入</button>\n', 'utf8');
    await writeFile(path.join(dir, 'shot.png'), Buffer.from([0x89, 0x50]));
    const h = await S.mockupFileHashes(root);
    assert.deepEqual(Object.keys(h).sort(), ['index.html', 'pages/login.html', 'tokens.css'], '二進位不進 hash');
    // CRLF 翻行尾 → hash 不變（sha256Text 正規化）
    await writeFile(path.join(dir, 'index.html'), '<h1>走查台</h1>\r\n', 'utf8');
    const h2 = await S.mockupFileHashes(root);
    assert.equal(S.mockupAggHash(h), S.mockupAggHash(h2), 'CRLF 不算漂移');
  });
});

test('mockupChainProblem：凍結後刪 index/刪目錄 → 擋；未凍結舊專案/已豁免 → 放（UF-1/UF-2 分母保護）', () => {
  const idx = { files: {}, aggHash: 'h' };
  assert.equal(S.mockupChainProblem({ dirExists: true, index: idx, frozen: true, waived: false }), null);
  assert.match(S.mockupChainProblem({ dirExists: true, index: null, frozen: true, waived: false }), /定版分母被刪/);
  assert.equal(S.mockupChainProblem({ dirExists: true, index: null, frozen: false, waived: false }), null, '未凍結舊專案不擋');
  assert.match(S.mockupChainProblem({ dirExists: false, index: null, frozen: true, waived: false }), /目錄消失/);
  assert.equal(S.mockupChainProblem({ dirExists: false, index: null, frozen: true, waived: true }), null, 'mockup-waiver 放行');
  assert.equal(S.mockupChainProblem({ dirExists: false, index: null, frozen: false, waived: false }), null, '從未凍結且無目錄＝非 web，不表態');
});

test('tokenReferenced：詞界比對——--gray-1 不誤中 --gray-10、--font 不誤中 --font-size（UF-4 另創撞前綴色階假陽性）', () => {
  assert.equal(S.tokenReferenced('color: var(--gray-10)', '--gray-1'), false);
  assert.equal(S.tokenReferenced('color: var(--gray-1)', '--gray-1'), true);
  assert.equal(S.tokenReferenced('font-size: var(--font-size)', '--font'), false);
  assert.equal(S.tokenReferenced('font: var(--font);', '--font'), true);
});

test('manifestScopeHash：無/空 mockupPages 投影相同（BC-1 升級不讓舊專案假性判 manifest 漂移）', () => {
  assert.equal(
    S.manifestScopeHash({ tasks: [{ id: 'F-1', blockedBy: [], conflictZone: ['api/'] }] }),
    S.manifestScopeHash({ tasks: [{ id: 'F-1', blockedBy: [], conflictZone: ['api/'], mockupPages: [] }] }),
    '空陣列不進投影＝與無欄位同 hash');
});

// ── mockupPages 機讀欄位鏈（task↔原型頁承接，plan-check/wave 投餵的事實來源）──

test('parseTasksMd/planManifestDiff：mockupPages 續行欄位解析＋不一致點名；舊格式（無欄位）不誤判', () => {
  const md = '- [ ] F-1 登入（對應 REQ-E2E-001）\n      blockedBy: — | conflictZone: api/ | mockupPages: pages/login.html, pages/register.html\n';
  assert.deepEqual(S.parseTasksMd(md)[0].mockupPages, ['pages/login.html', 'pages/register.html']);
  assert.deepEqual(S.planManifestDiff(md, { tasks: [{ id: 'F-1', blockedBy: [], conflictZone: ['api/'], mockupPages: ['pages/Register.html', 'pages/login.html'] }] }), [], '大小寫/順序外觀差異不誤判');
  assert.match(S.planManifestDiff(md, { tasks: [{ id: 'F-1', blockedBy: [], conflictZone: ['api/'] }] }).join('\n'), /mockupPages 不一致/);
  const old = '- [ ] F-2 x（對應 REQ-001）\n      blockedBy: — | conflictZone: api/\n';
  assert.deepEqual(S.planManifestDiff(old, { tasks: [{ id: 'F-2', blockedBy: [], conflictZone: ['api/'] }] }), [], '無 mockupPages 的舊格式不誤判');
});

test('mockupPageCoverage：phantom 宣告不存在的頁、uncovered 沒人承接的頁；同頁多 task 合法', () => {
  const r = S.mockupPageCoverage(
    [{ id: 'F-1', mockupPages: ['pages/login.html'] }, { id: 'F-2', mockupPages: ['pages/Login.html', 'pages/ghost.html'] }],
    ['pages/login.html', 'pages/items.html']);
  assert.equal(r.phantom.length, 1);
  assert.match(r.phantom[0], /F-2.*ghost/);
  assert.deepEqual(r.uncovered, ['pages/items.html']);
  const ok = S.mockupPageCoverage(
    [{ id: 'F-1', mockupPages: ['pages/login.html'] }, { id: 'F-2', mockupPages: ['pages/login.html'] }],
    ['pages/login.html']);
  assert.deepEqual([...ok.phantom, ...ok.uncovered], [], '同頁多 task 承接合法');
});

test('uiFocusAudit：缺節/漏頁點名；節在＋逐頁提及 → 空', () => {
  const md = '# design\n## UI 對焦結論\n畫面清單：pages/login.html（登入）\n';
  assert.deepEqual(S.uiFocusAudit(md, ['pages/login.html']), []);
  const miss = S.uiFocusAudit('# design\n只有別的', ['pages/login.html']);
  assert.equal(miss.length, 2);
  assert.match(miss[0], /UI 對焦結論/);
  assert.match(miss[1], /login\.html/);
  assert.match(S.uiFocusAudit(md, ['pages/login.html', 'pages/items.html']).join('\n'), /items\.html/);
});

test('uiFocusAudit：admin-login.html 不得替 login.html 洗過（左詞界）；同名頁須完整路徑提及（UF-5）', () => {
  const md = '## UI 對焦結論\n畫面清單：admin-login.html\n';
  assert.match(S.uiFocusAudit(md, ['pages/login.html']).join('\n'), /login\.html/, '後綴撞名不算提及');
  const dup = S.uiFocusAudit('## UI 對焦結論\nitems.html\n', ['pages/items.html', 'pages/admin/items.html']);
  assert.equal(dup.length, 2, '同名頁 basename 不夠、逐頁強制完整路徑');
  assert.match(dup.join('\n'), /同名頁/);
  assert.deepEqual(S.uiFocusAudit('## UI 對焦結論\npages/items.html 與 pages/admin/items.html\n',
    ['pages/items.html', 'pages/admin/items.html']), [], '完整路徑逐頁提及 → 過');
});

test('extractCssVars/tokenUsageAudit：抽 :root 定義變數（var() 引用不算定義）、引用對賬', () => {
  const vars = S.extractCssVars(':root {\n  --color-primary: #333;\n  --font-body: sans-serif;\n}\n.x { color: var(--color-primary) }');
  assert.deepEqual(vars, ['--color-primary', '--font-body']);
  const a = S.tokenUsageAudit(vars, ['--color-primary']);
  assert.deepEqual(a.hit, ['--color-primary']);
  assert.deepEqual(a.miss, ['--font-body']);
  assert.equal(a.total, 2);
});

test('buildWavePlan：uiCtx 附進 wave-plan.ui、per-task mockupPages 自 manifest 帶出（UI 逐字投餵）', () => {
  const manifest = { tasks: [{ id: 'F-1', blockedBy: [], conflictZone: ['api/'], mockupPages: ['pages/login.html'] }] };
  const tasksMd = '- [ ] F-1 登入（對應 REQ-E2E-001）\n      blockedBy: — | conflictZone: api/ | mockupPages: pages/login.html\n';
  const reqMd = 'REQ-E2E-001：登入 → 首頁 → 斷言。';
  const plan = S.buildWavePlan(manifest, [], tasksMd, reqMd, null, { designBase: 'shadcn', tokensCss: ':root{--c:red}', mockupDir: 'specs/ui-mockups', mockupAggHash: 'h' });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.ui.designBase, 'shadcn');
  assert.equal(plan.ui.tokensCss, ':root{--c:red}', 'tokens 逐字');
  assert.deepEqual(plan.waves[0][0].mockupPages, ['pages/login.html']);
  assert.ok(!('ui' in S.buildWavePlan(manifest, [], tasksMd, reqMd, null)), '無 uiCtx（非 web）不附 ui 欄位');
});

test('manifestScopeHash：mockupPages 進投影（plan 後改動＝漂移要重算波次）', () => {
  const a = S.manifestScopeHash({ tasks: [{ id: 'F-1', conflictZone: ['api/'], mockupPages: ['pages/a.html'] }] });
  assert.notEqual(a, S.manifestScopeHash({ tasks: [{ id: 'F-1', conflictZone: ['api/'], mockupPages: ['pages/b.html'] }] }));
  assert.equal(a, S.manifestScopeHash({ tasks: [{ id: 'F-1', conflictZone: ['api/'], mockupPages: ['pages/A.html'] }], mode: 'auto' }), '正規化＋語意無關欄位不影響');
});

// ── spec 審查 lens ledger（第 1 波）：驗形／終局／收斂判準的純核心 ──

test('validateSpecReviewFindings：合法（含空陣列）過；缺欄/壞 id/前綴不符 lens/重複/lens 不符逐項點名', () => {
  assert.deepEqual(S.validateSpecReviewFindings({ findings: [] }, 'redteam'), [], '零發現＝空陣列合法');
  assert.deepEqual(S.validateSpecReviewFindings({ lens: 'redteam', findings: [{ id: 'SR-RT-001', severity: 'high', claim: 'REQ-012 scope 缺口' }] }, 'redteam'), []);
  assert.deepEqual(S.validateSpecReviewFindings({ findings: [{ id: 'SR-CS-001', severity: 'low', claim: 'REQ-005 與 story 矛盾' }] }, 'consistency'), []);
  assert.match(S.validateSpecReviewFindings({}, 'redteam').join('\n'), /findings 陣列/);
  assert.match(S.validateSpecReviewFindings({ lens: 'consistency', findings: [] }, 'redteam').join('\n'), /lens/);
  // 前綴綁 lens：redteam 用了 SR-CS- → 擋（防跨 lens 撞號蒸發質疑）
  assert.match(S.validateSpecReviewFindings({ findings: [{ id: 'SR-CS-001', severity: 'high', claim: 'x' }] }, 'redteam').join('\n'), /SR-RT-/);
  const bad = S.validateSpecReviewFindings({ findings: [{ id: 'X-1', severity: 'critical', claim: '' }, { id: 'SR-RT-9', severity: 'low', claim: 'x' }, { id: 'sr-rt-9', severity: 'low', claim: 'y' }] }, 'redteam');
  assert.match(bad.join('\n'), /SR-RT-/);
  assert.match(bad.join('\n'), /severity/);
  assert.match(bad.join('\n'), /claim/);
  assert.match(bad.join('\n'), /重複/);
});

const REVIEW_MD = READY_MD.replace('### 開放問題\n無', '### 開放問題\n- [SR-RT-002] 刪父層時子資源怎麼辦？');

test('specResolutionProblem：四種終局各附機器指標；指標失效/亂寫逐一擋（第 1 波）', () => {
  const dec = id => id === 'D-1';
  assert.equal(S.specResolutionProblem('SR-RT-001', 'resolved:REQ-001', READY_MD, dec), null);
  assert.match(S.specResolutionProblem('SR-RT-001', 'resolved:REQ-999', READY_MD, dec), /不存在/);
  assert.equal(S.specResolutionProblem('SR-RT-002', 'open', REVIEW_MD, dec), null, '開放問題段有 [SR-RT-002] bullet');
  assert.match(S.specResolutionProblem('SR-RT-001', 'open', REVIEW_MD, dec), /查無帶 \[SR-RT-001\]/, '沒掛標籤不算 open');
  assert.equal(S.specResolutionProblem('SR-RT-003', 'rejected:D-1', READY_MD, dec), null);
  assert.match(S.specResolutionProblem('SR-RT-003', 'deferred:D-404', READY_MD, dec), /不存在/);
  assert.match(S.specResolutionProblem('SR-RT-003', '算了不管', READY_MD, dec), /不合法的終局/);
});

test('reviewCheckAudit：未終局/指標失效點名；全終局＝零 problems（發現不能無痕蒸發）', () => {
  const ledgers = [{ lens: 'redteam', round: 1, findings: [{ id: 'SR-RT-001', severity: 'high' }, { id: 'SR-RT-002', severity: 'low' }] }];
  const dec = () => false;
  const none = S.reviewCheckAudit(ledgers, {}, REVIEW_MD, dec);
  assert.equal(none.length, 2, '兩條都沒終局');
  assert.match(none.join('\n'), /SR-RT-001.*未終局/);
  const ok = S.reviewCheckAudit(ledgers, { 'SR-RT-001': { as: 'resolved:REQ-001' }, 'sr-rt-002': { as: 'open' } }, REVIEW_MD, dec);
  assert.deepEqual(ok, [], JSON.stringify(ok));
});

test('reviewCheckAudit：frozenAt 週期斷代——歷史輪只驗終局存在（REQ 已歸檔不偽陽性）、當前輪照驗指標', () => {
  const frozenAt = '2026-07-06T00:00:00.000Z';
  const dec = () => false;
  const oldRound = { lens: 'redteam', round: 1, at: '2026-07-05T10:00:00.000Z', findings: [{ id: 'SR-RT-901', severity: 'high' }] };
  const newRound = { lens: 'redteam', round: 2, at: '2026-07-15T10:00:00.000Z', findings: [{ id: 'SR-RT-902', severity: 'low' }] };
  // 歷史輪 resolved 指向已歸檔（現行文件沒有）的 REQ → 不偽陽性
  const hist = S.reviewCheckAudit([oldRound], { 'SR-RT-901': { as: 'resolved:REQ-ARCHIVED-9' } }, REVIEW_MD, dec, undefined, frozenAt);
  assert.deepEqual(hist, [], JSON.stringify(hist));
  // 歷史輪沒終局 → 仍點名（不可蒸發不放鬆）
  const gone = S.reviewCheckAudit([oldRound], {}, REVIEW_MD, dec, undefined, frozenAt);
  assert.equal(gone.length, 1);
  assert.match(gone[0], /SR-RT-901.*未終局/);
  // 當前週期輪指向不存在 REQ → 照擋
  const cur = S.reviewCheckAudit([newRound], { 'SR-RT-902': { as: 'resolved:REQ-NOPE-1' } }, REVIEW_MD, dec, undefined, frozenAt);
  assert.equal(cur.length, 1);
  assert.match(cur[0], /REQ-NOPE-1 不存在/);
  // 未曾凍結（frozenAt=''）→ 行為同舊版全量重驗
  const legacy = S.reviewCheckAudit([oldRound], { 'SR-RT-901': { as: 'resolved:REQ-ARCHIVED-9' } }, REVIEW_MD, dec, undefined, '');
  assert.equal(legacy.length, 1);
});

test('lastFrozenAt：取最後一次 spec.frozen 時戳；無凍結事件回空字串', () => {
  assert.equal(S.lastFrozenAt([]), '');
  assert.equal(S.lastFrozenAt([{ ev: 'spec.frozen', t: '2026-07-01T00:00:00Z' }, { ev: 'spec.frozen', t: '2026-07-06T00:00:00Z' }]), '2026-07-06T00:00:00Z');
});

// ── 第 2 波：全鏈路對賬純函式 ──

test('extractAllReqIds：抽全型號 REQ id 去重保序大寫（W2-1）', () => {
  const md = 'REQ-001 REQ-E2E-002\nreq-perf-003 REQ-RBAC-004 REQ-001（重複）';
  assert.deepEqual(S.extractAllReqIds(md), ['REQ-001', 'REQ-E2E-002', 'REQ-PERF-003', 'REQ-RBAC-004']);
});

test('reqHashProblem：無 index→null（相容）；hash 相符→null；不符→錯誤（W2-1）', () => {
  const md = 'REQ-001：x';
  const idx = { reqHash: S.sha256Text(md), reqIds: ['REQ-001'] };
  assert.equal(S.reqHashProblem(null, md), null, '無 index 不擋');
  assert.equal(S.reqHashProblem(idx, md), null, '相符');
  assert.match(S.reqHashProblem(idx, md + '\nREQ-002：偷改'), /凍結快照不符/);
  assert.equal(S.reqHashProblem(idx, md.replace('\n', '\r\n')), null, 'CRLF 差異不誤判');
  assert.match(S.reqHashProblem({ reqIds: ['REQ-001'] }, md), /reqHash 遺失/, 'H2-F2：index 實存但 reqHash 缺＝損毀，明講不靜默放行');
  assert.equal(S.reqHashProblem(idx, '﻿' + md), null, 'H2-F3：BOM 差異不誤判為凍結漂移');
});

test('parseTasksMd：抽 id/blockedBy/conflictZone；planManifestDiff 抓寬窄不一致（W2-2）', () => {
  const md = [
    '- [ ] F-1 訪客註冊（對應 REQ-E2E-001）',
    '      blockedBy: P-1,P-2 | conflictZone: features/auth, api/auth',
    '- [x] F-2 建立 item（對應 REQ-E2E-002）',
    '      blockedBy: — | conflictZone: features/items',
  ].join('\n');
  const tasks = S.parseTasksMd(md);
  assert.deepEqual(tasks.map(t => t.id), ['F-1', 'F-2']);
  assert.deepEqual(tasks[0].blockedBy, ['P-1', 'P-2']);
  assert.deepEqual(tasks[0].conflictZone, ['features/auth', 'api/auth']);
  assert.deepEqual(tasks[1].blockedBy, [], '— 視為空');
  // manifest 少一個 conflictZone → diff 抓到
  const manifest = { tasks: [{ id: 'F-1', blockedBy: ['P-1', 'P-2'], conflictZone: ['features/auth'] }, { id: 'F-2', blockedBy: [], conflictZone: ['features/items'] }] };
  const d = S.planManifestDiff(md, manifest);
  assert.match(d.join('\n'), /F-1.*conflictZone 不一致/);
  // 全一致 → 空
  manifest.tasks[0].conflictZone = ['features/auth', 'api/auth'];
  assert.deepEqual(S.planManifestDiff(md, manifest), []);
  // manifest 多一個幽靈 task → 抓到
  manifest.tasks.push({ id: 'F-9', blockedBy: [], conflictZone: [] });
  assert.match(S.planManifestDiff(md, manifest).join('\n'), /F-9.*manifest 有、tasks\.md 沒有/);
});

test('reqTaskCoverage：只要求 REQ-E2E/PERF 承接、功能型 REQ 不強求；註解不算承接；前綴 glob；不前綴碰撞（W2-2 修）', () => {
  // REQ-E2E-001 被 task 承接、REQ-PERF-001 沒 → uncovered 只列 PERF（功能型 REQ-001 不要求）
  assert.deepEqual(S.reqTaskCoverage(['REQ-001', 'REQ-E2E-001', 'REQ-PERF-001'], '- [ ] F-1（對應 REQ-E2E-001）').uncovered, ['REQ-PERF-001']);
  // REQ id 只出現在註解/追溯行（非 checkbox task 行）→ 不算承接
  const commentOnly = '- [ ] F-1（對應 REQ-E2E-001）\n<!-- 追溯：REQ-PERF-001 效能待後續 -->';
  assert.deepEqual(S.reqTaskCoverage(['REQ-E2E-001', 'REQ-PERF-001'], commentOnly).uncovered, ['REQ-PERF-001'], '註解不算承接');
  // 前綴 glob「REQ-PERF-*」覆蓋該前綴全部 id
  assert.equal(S.reqTaskCoverage(['REQ-PERF-001', 'REQ-PERF-002'], '- [ ] X-1 效能整體驗收（REQ-PERF-*）').ok, true, 'glob 覆蓋');
  // 前綴碰撞：REQ-E2E-1 不被 REQ-E2E-10 覆蓋（tokenized set，非裸子字串）
  assert.deepEqual(S.reqTaskCoverage(['REQ-E2E-1'], '- [ ] F-1（對應 REQ-E2E-10）').uncovered, ['REQ-E2E-1'], '不前綴碰撞');
  // phantom：具體 id 不在 index（glob 殘綴不算幻覺）
  assert.deepEqual(S.reqTaskCoverage(['REQ-E2E-001'], '- [ ] F-1 做 REQ-E2E-999').phantom, ['REQ-E2E-999']);
  assert.deepEqual(S.reqTaskCoverage(['REQ-PERF-001'], '- [ ] X-1（REQ-PERF-*）').phantom, [], 'glob 非幻覺');
});

test('planManifestDiff：conflictZone 尾斜線/大小寫/順序純外觀差異不誤判（覆核 W2 誤殺）', () => {
  const md = '- [ ] F-1 標題\n      conflictZone: Api/, features/x | blockedBy: —';
  const manifest = { tasks: [{ id: 'F-1', blockedBy: [], conflictZone: ['api', 'features/x/'] }] };
  assert.deepEqual(S.planManifestDiff(md, manifest), [], '尾斜線/大小寫/順序都不算不一致');
});

test('isValidVerify：ok:<ref>（含冒號後空白）過；裸 ok/passed/none 擋（覆核 W2 誤殺 + 對齊 gate）', () => {
  assert.equal(S.isValidVerify('ok:e2e'), true);
  assert.equal(S.isValidVerify('ok: dashboard e2e green'), true, '冒號後空白不誤殺');
  assert.equal(S.isValidVerify('ok'), false);
  assert.equal(S.isValidVerify('passed'), false);
  assert.equal(S.isValidVerify('none'), false);
});

// ── C：藍軍 code-review 機讀落檔＋終局化 ──

test('validateCodeFindings：合法（含空陣列）過；壞 id/severity/缺 claim/重複逐項點名', () => {
  assert.deepEqual(S.validateCodeFindings({ findings: [] }), []);
  assert.deepEqual(S.validateCodeFindings({ findings: [{ id: 'CR-001', severity: 'red', file: 'a.ts:1', claim: 'SQLi' }] }), []);
  assert.match(S.validateCodeFindings({}).join('\n'), /findings 陣列/);
  const bad = S.validateCodeFindings({ findings: [{ id: 'X1', severity: 'high', claim: '' }, { id: 'CR-1', severity: 'red', claim: 'x' }, { id: 'cr-1', severity: 'yellow', claim: 'y' }] });
  assert.match(bad.join('\n'), /CR-/);
  assert.match(bad.join('\n'), /severity/);
  assert.match(bad.join('\n'), /claim/);
  assert.match(bad.join('\n'), /重複/);
});

test('codeResolutionProblem：fixed 須附證據、waiver 須 decision 實存、擋 .. 與亂寫（C）', () => {
  const dec = id => id === 'D-1';
  assert.equal(S.codeResolutionProblem('fixed:src/x.ts:42 parameterized', dec), null);
  assert.match(S.codeResolutionProblem('fixed:', dec), /須附證據/);
  assert.match(S.codeResolutionProblem('fixed: ', dec), /須附證據/);
  assert.equal(S.codeResolutionProblem('waiver:D-1', dec), null);
  assert.match(S.codeResolutionProblem('waiver:D-404', dec), /不存在/);
  assert.match(S.codeResolutionProblem('waiver:../secret', dec), /路徑分隔或 \.\./);
  assert.match(S.codeResolutionProblem('算了', dec), /不合法/);
});

test('codeReviewAudit：resolution 綁內容 hash（非裸 id）；yellow 不進閘門；同號內容變不繼承終局（C 修）', () => {
  const dec = () => false;
  assert.deepEqual(S.codeReviewAudit(null, {}, dec), [], 'codeReviewAudit 本身不擋沒跑（forcing 在 complete-check）');
  const red = { id: 'CR-001', severity: 'red', file: 'a.ts:1', claim: 'SQLi' };
  const review = { findings: [red, { id: 'CR-002', severity: 'yellow', claim: '神奇數字' }] };
  assert.equal(S.codeReviewAudit(review, {}, dec).length, 1, '只 red 未終局進閘門');
  // 綁 hash 終局 → 過
  const ok = S.codeReviewAudit(review, { [S.codeFindingHash(red)]: { as: 'fixed:src/a.ts:1' } }, dec);
  assert.deepEqual(ok, [], 'hash 終局＝過');
  // 同號 CR-001 但內容全新 → hash 不同 → 舊終局不算，仍未終局
  const review2 = { findings: [{ id: 'CR-001', severity: 'red', file: 'c.ts:3', claim: 'XSS 全新' }] };
  assert.equal(S.codeReviewAudit(review2, { [S.codeFindingHash(red)]: { as: 'fixed:x' } }, dec).length, 1, '內容變＝不繼承舊終局');
});

test('codeFindingHash：內容相同→同 hash（id 無關）；內容變→不同 hash（C）', () => {
  const a = { id: 'CR-001', severity: 'red', file: 'a.ts:1', claim: 'SQLi' };
  const b = { id: 'CR-099', severity: 'red', file: 'a.ts:1', claim: 'SQLi' };   // 只差 id
  assert.equal(S.codeFindingHash(a), S.codeFindingHash(b), 'id 無關');
  assert.notEqual(S.codeFindingHash(a), S.codeFindingHash({ ...a, claim: '別的問題' }));
});

test('parsePerfBudget / perfMeetsBudget：上界/下界/單位錨定/條件句不誤抓（W2-4 修正）', () => {
  assert.deepEqual(S.parsePerfBudget('REQ-PERF-001：dashboard LCP < 2.5s（p95）'), { op: '<', budget: 2.5, unit: 's', lower: false });
  assert.deepEqual(S.parsePerfBudget('p95 <= 400ms @ POST /api/items'), { op: '<=', budget: 400, unit: 'ms', lower: false });
  // 條件句「資料量 < 5000 筆時 p95 <= 400ms」：錨定帶單位的 400ms、不誤抓 5000（覆核 bypass finding）
  assert.deepEqual(S.parsePerfBudget('查詢在資料量 < 5000 筆時，p95 <= 400ms'), { op: '<=', budget: 400, unit: 'ms', lower: false });
  // 下界（吞吐量）：>= 1000 rps
  assert.deepEqual(S.parsePerfBudget('吞吐量 >= 1000 rps'), { op: '>=', budget: 1000, unit: 'rps', lower: true });
  assert.equal(S.parsePerfBudget('無數字'), null);
  const up = { budget: 400, unit: 'ms', op: '<=', lower: false };
  assert.equal(S.perfMeetsBudget(420, up), null, '上界 5% 容差內');
  assert.match(S.perfMeetsBudget(500, up), /超標/);
  const lo = { budget: 1000, unit: 'rps', op: '>=', lower: true };
  assert.equal(S.perfMeetsBudget(1500, lo), null, '下界達標');
  assert.match(S.perfMeetsBudget(500, lo), /未達下限/);
});

test('parsePerfBudget：千分位逗號 budget 不被逗號截斷（1,000ms / 2,000 tokens 回歸）', () => {
  // 過去 [\d.]+ 遇逗號截斷把「< 1,000ms」錯解成 budget=1、「≤ 2,000 tokens」錯解成 budget=2，
  // 讓實測達標（85ms / 1155 tokens）反被判超標。strip 逗號後應回真正的 1000 / 2000。
  assert.deepEqual(S.parsePerfBudget('SessionStart 注入 hook p95 < 1,000ms'), { op: '<', budget: 1000, unit: 'ms', lower: false });
  assert.deepEqual(S.parsePerfBudget('單次注入總量 ≤ 2,000 tokens'), { op: '≤', budget: 2000, unit: '', lower: false });
  assert.equal(S.perfMeetsBudget(85.62, S.parsePerfBudget('p95 < 1,000ms')), null, '85.62ms 應達標 <1000ms');
  assert.equal(S.perfMeetsBudget(1155, S.parsePerfBudget('≤ 2,000 tokens')), null, '1155 tokens 應達標 ≤2000');
});

test('perfIsNonMeasurable：無 budget/N/A 的 REQ-PERF → true（走 perf-waiver 不是 verify-perf）（W2-4 死鎖修）', () => {
  const md = ['REQ-PERF-001：p95 <= 400ms。', 'REQ-PERF-002：不阻塞主線程（設計約束）。', 'REQ-PERF-003：N/A（內部工具）。'].join('\n');
  assert.equal(S.perfIsNonMeasurable(md, 'REQ-PERF-001'), false, '有 budget＝量測型');
  assert.equal(S.perfIsNonMeasurable(md, 'REQ-PERF-002'), true, '無數字＝非量測型');
  assert.equal(S.perfIsNonMeasurable(md, 'REQ-PERF-003'), true, 'N/A');
});

test('taskRunnerRed：canonical 嚴格相等（不跨 task 污染）＋逐 bucket 最後一次（換命令洗綠不算）（W2-3 修）', () => {
  // 同 task 同 bucket 先紅後綠 → 該 bucket 已綠、null
  assert.equal(S.taskRunnerRed([
    { ev: 'verify.attempt', id: 'make test', sig: 'abc', taskId: 'F-1' },
    { ev: 'verify.attempt', id: 'make test', sig: 'ok', taskId: 'F-1' },
  ], 'F-1'), null);
  // 換 bucket 跑綠洗不掉原 failing runner 的紅
  assert.equal(S.taskRunnerRed([
    { ev: 'verify.attempt', id: 'npm test', sig: 'red1', taskId: 'F-1' },
    { ev: 'verify.attempt', id: 'node', sig: 'ok', taskId: 'F-1' },
  ], 'F-1'), 'npm test', '原 npm test 仍紅');
  // 跨 task 不污染：F-1 的紅不擋 F-2（嚴格相等，不用 idMatches）
  assert.equal(S.taskRunnerRed([{ ev: 'verify.attempt', id: 'x', sig: 'red', taskId: 'Admin-F-1' }], 'F-1'), null);
  // 沒走 run → null（不表態）
  assert.equal(S.taskRunnerRed([{ ev: 'verify.attempt', id: 'npm test', sig: 'ok' }], 'F-1'), null);
});

test('sha256Text：行尾正規化——CRLF/LF/CR 同文字同 hash（覆核 W1 docHash 對 autocrlf 不敏感）', () => {
  assert.equal(S.sha256Text('a\r\nb'), S.sha256Text('a\nb'));
  assert.equal(S.sha256Text('a\rb'), S.sha256Text('a\nb'));
  assert.notEqual(S.sha256Text('a\nb'), S.sha256Text('a\nc'), '真改字仍不同');
  assert.equal(S.sha256Text('﻿a\nb'), S.sha256Text('a\nb'), 'H2-F3：開頭 BOM 屬位元組雜訊，同文字同 hash');
  assert.notEqual(S.sha256Text('a﻿b'), S.sha256Text('ab'), '非開頭的 FEFF 是真內容差異，不剝');
});

test('specResolutionProblem：resolved 要求文件在 finding 落檔後有變動——指回一字未改的 REQ 擋（覆核 W1）', () => {
  const dec = () => false;
  const H = S.sha256Text(READY_MD);
  // findingDocHash == currentHash（文件零改動）→ 擋
  assert.match(S.specResolutionProblem('SR-RT-001', 'resolved:REQ-001', READY_MD, dec, { findingDocHash: H, currentHash: H }), /無任何變動/);
  // 文件已改（hash 不同）→ 過
  assert.equal(S.specResolutionProblem('SR-RT-001', 'resolved:REQ-001', READY_MD, dec, { findingDocHash: 'old', currentHash: H }), null);
  // 不給 hash（review-resolve 當下無 currentHash）→ 只驗 REQ 存在（向後相容）
  assert.equal(S.specResolutionProblem('SR-RT-001', 'resolved:REQ-001', READY_MD, dec), null);
});

test('specResolutionProblem：deferred/rejected id 收中文（與 decision 正門對齊）、擋 .. 穿越（覆核 W1）', () => {
  assert.equal(S.specResolutionProblem('SR-RT-001', 'rejected:延後付款', READY_MD, id => id === '延後付款'), null, '中文 id 對齊 safeId');
  assert.match(S.specResolutionProblem('SR-RT-001', 'deferred:../secrets', READY_MD, () => true), /\.\./);
});

test('openSectionHasTag：tag 掛在段內子標題也算（覆核 W1，堵「算未收斂卻登記不了 open」死結）', () => {
  const md = '### 開放問題\n#### [SR-RT-001] 刪父層時子資源怎麼辦？\n';
  assert.equal(S.openSectionHasTag(md, 'SR-RT-001'), true);
  assert.equal(S.openSectionHasTag('### 開放問題\n- [SR-CS-002] bullet 形式\n', 'SR-CS-002'), true);
  assert.equal(S.openSectionHasTag('### 開放問題\n無\n', 'SR-RT-001'), false);
});

test('currentCycleLedgers：只留最後一次 spec.frozen 之後的輪；無凍結事件＝全留（覆核 W1 週期斷代）', () => {
  const led = [
    { lens: 'redteam', round: 1, at: '2026-01-01T00:00:00Z' },
    { lens: 'redteam', round: 2, at: '2026-01-02T00:00:00Z' },
    { lens: 'redteam', round: 3, at: '2026-01-04T00:00:00Z' },
  ];
  assert.equal(S.currentCycleLedgers(led, []).length, 3, '沒凍結過＝全留');
  const j = [{ ev: 'spec.frozen', t: '2026-01-03T00:00:00Z' }];
  const cur = S.currentCycleLedgers(led, j);
  assert.equal(cur.length, 1);
  assert.equal(cur[0].round, 3, '只留凍結後那輪');
});

test('lensConvergenceAudit：未跑/1 輪/末輪有 findings 擋；2 輪末輪空過；docHash 不符擋；3 輪封頂放行（第 1 波）', () => {
  const H = 'hash-now';
  const mk = (lens, round, n, docHash = H) => ({ lens, round, docHash, findings: Array.from({ length: n }, (_, i) => ({ id: `SR-X-${round}${i}` })) });
  assert.match(S.lensConvergenceAudit([], H).join('\n'), /redteam.*未跑/);
  assert.match(S.lensConvergenceAudit([mk('redteam', 1, 0), mk('consistency', 1, 0), mk('consistency', 2, 0)], H).join('\n'), /redteam.*未收斂/, '單輪即使空也不算收斂（≥2 輪）');
  const good = [mk('redteam', 1, 2), mk('redteam', 2, 0), mk('consistency', 1, 0), mk('consistency', 2, 0)];
  assert.deepEqual(S.lensConvergenceAudit(good, H), []);
  const stale = [mk('redteam', 1, 0), mk('redteam', 2, 0, 'hash-old'), mk('consistency', 1, 0), mk('consistency', 2, 0)];
  assert.match(S.lensConvergenceAudit(stale, H).join('\n'), /docHash 不符/);
  const capped = [mk('redteam', 1, 3), mk('redteam', 2, 2), mk('redteam', 3, 1), mk('consistency', 1, 0), mk('consistency', 2, 0)];
  assert.deepEqual(S.lensConvergenceAudit(capped, H), [], '滿 3 輪封頂（剩餘 findings 由 diagnose review 逼終局）');
});

test('isHighRiskAttackText：真攻擊面命中（含自然語言句型）、工程語境不誤中（W0-6 三組制）', () => {
  // 真安全面 → true（強訊號單獨；或 domain＋攻擊動詞共現）
  for (const s of [
    'auth bypass via token replay',
    '未登入使用者可繞過權限看到他人資料',
    'SQL injection on search field',
    'unauthorized access to admin panel',
    'account takeover via password reset link',
    '未登入者可直接開啟 /admin 後台頁',
    '密碼以明文儲存在 log',
  ]) assert.equal(S.isHighRiskAttackText(s), true, s);
  // 非安全語境 → false（domain 名詞單獨出現、依賴注入、word boundary）
  for (const s of [
    'author list renders slowly on repayment page',
    '清單分頁在空狀態顯示錯誤',
    'prompt 超過 token 上限時截斷',
    'service 依賴注入順序錯誤',
    'cache bypass 造成回應變慢',
    '多個 tab 共用同一 session 時 UI 不同步',
    'CSV 匯出時 login 次數統計欄位錯位',
    'payment reminder 信重複寄送',
  ]) assert.equal(S.isHighRiskAttackText(s), false, s);
});

test('isHighRiskAttackText：範圍排除句不誤觸發、禁止句照常觸發（(d) 否定語境剝除）', () => {
  // 「宣告不做」＝排除語意 → 剝掉後不觸發（原本 strong 詞單獨即中，這是 C 類誤報主源）
  for (const s of [
    '本功能不涉及金流',
    '本版不包含個資蒐集',
    'MVP 不含金流與付費功能',
    '此階段不需要金流串接',
  ]) assert.equal(S.isHighRiskAttackText(s), false, s);
  // 剝除止於標點；禁止句（不得/禁止）是真安全需求、絕不剝
  for (const s of [
    '不涉及金流，但會蒐集個資',
    '系統不得允許未登入者繞過權限存取後台',
    '禁止竄改他人資料',
  ]) assert.equal(S.isHighRiskAttackText(s), true, s);
});

// ── Playwright journey 真實性審計（auditJourneyTest）：導航版「禁 mock 假綠」 ──

test('auditJourneyTest：非 journey 檔（無 playwright/goto）→ isJourney=false、零問題', () => {
  const a = S.auditJourneyTest("import { test, expect } from 'vitest'\ntest('unit', () => { vi.fn().mockReturnValue(1) })");
  assert.equal(a.isJourney, false);
  assert.equal(a.problems.length, 0);
});

test('auditJourneyTest：合法範本（單一入口 goto + 真點擊 + 真 API）→ 零 hard 問題', () => {
  const good = [
    "import { test, expect, request } from '@playwright/test'",
    "test('journey', async ({ page }) => {",
    "  await page.goto('/login')",
    "  await page.getByLabel(/email/i).fill('a@b.c')",
    "  await page.getByRole('button', { name: /登入/i }).click()",
    "  const r = await api.get('/items'); expect(r.status()).toBe(200)",
    "})",
  ].join('\n');
  const a = S.auditJourneyTest(good);
  assert.equal(a.isJourney, true);
  assert.equal(a.problems.length, 0, JSON.stringify(a.problems));
});

test('auditJourneyTest：page.route / MSW / mockResolvedValue 任一 → hard 問題（禁 mock）', () => {
  const route = S.auditJourneyTest("import {test} from '@playwright/test'\ntest('x', async ({page}) => { await page.route('**/api/**', r => r.fulfill({body:'{}'})); await page.goto('/') })");
  assert.ok(route.problems.some(p => /route|mock|攔截/.test(p)), JSON.stringify(route.problems));
  const msw = S.auditJourneyTest("import {test} from '@playwright/test'\nimport { setupServer } from 'msw/node'\ntest('x', async ({page}) => { await page.goto('/') })");
  assert.ok(msw.problems.length >= 1, 'MSW 被擋');
  const vimock = S.auditJourneyTest("import {test} from '@playwright/test'\ntest('x', async ({page}) => { await page.goto('/'); fetch.mockResolvedValue({}) })");
  assert.ok(vimock.problems.some(p => /mock/.test(p)));
});

test('auditJourneyTest：單一 test 內 >1 goto → hard 問題（第五鐵則）', () => {
  const multi = [
    "import {test} from '@playwright/test'",
    "test('shortcut', async ({page}) => {",
    "  await page.goto('/login')",
    "  await page.goto('/admin/users/123')",   // 第二個 goto＝抄捷徑
    "})",
  ].join('\n');
  const a = S.auditJourneyTest(multi);
  assert.ok(a.problems.some(p => /goto/.test(p) && /第五鐵則/.test(p)), JSON.stringify(a.problems));
});

test('auditJourneyTest：多個 test 各一 goto（合法）→ 不誤判', () => {
  const ok = [
    "import {test} from '@playwright/test'",
    "test('a', async ({page}) => { await page.goto('/login'); await page.getByRole('button').click() })",
    "test('b', async ({page}) => { await page.goto('/signup'); await page.getByRole('link').click() })",
  ].join('\n');
  const a = S.auditJourneyTest(ok);
  assert.equal(a.problems.length, 0, '各 test 一個 goto 不算違規');
});

test('auditJourneyTest：深層 goto / 無互動 → 只進 warnings（不擋）', () => {
  const deep = "import {test} from '@playwright/test'\ntest('x', async ({page}) => { await page.goto('/admin/users/5'); await expect(page).toHaveTitle(/x/) })";
  const a = S.auditJourneyTest(deep);
  assert.equal(a.problems.length, 0, '軟訊號不進 problems（loose 防誤殺）');
  assert.ok(a.warnings.some(w => /深層/.test(w)), '深層 goto 進 warnings');
  assert.ok(a.warnings.some(w => /互動/.test(w)), '無點擊互動進 warnings');
});

// ── W4-4：journal 歸檔（archiveJournal）──

test('archiveJournal：delivered task 的任務域事件搬歸檔；未交付/全域事件留主檔；回傳 archived/kept 數正確；冪等', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }, { id: 'F-2' }] });
    await S.recordCheckpoint(root, 'F-1', 'green', '完成');
    await S.transition(root, 'F-1', 'building', 'delivered');
    await S.recordVerifyAttempt(root, 'pytest tests/x.py', 'ok', 0, 'F-1');
    await S.recordCheckpoint(root, 'F-2', 'red', '進行中');
    await S.appendJournal(root, { ev: 'spec.frozen', reqHash: 'abc' });   // 全域事件（無 taskId/id 綁定）

    const r1 = await S.archiveJournal(root, ['F-1']);
    assert.equal(r1.archived, 3, 'F-1 的 checkpoint/task.transition/verify.attempt 三筆搬歸檔');
    assert.equal(r1.kept, 2, '主檔留 F-2 checkpoint ＋ spec.frozen 全域事件');

    const mainJournal = await S.readJournal(root);
    assert.equal(mainJournal.length, 2, '主檔恰留 2 筆');
    assert.ok(!mainJournal.some(e => e.ev === 'checkpoint' && e.id === 'F-1'), 'F-1 checkpoint 已搬離主檔');
    assert.ok(!mainJournal.some(e => e.ev === 'task.transition' && e.id === 'F-1'), 'F-1 task.transition 已搬離主檔');
    assert.ok(!mainJournal.some(e => e.ev === 'verify.attempt' && e.taskId === 'F-1'), 'F-1 verify.attempt 已搬離主檔');
    assert.ok(mainJournal.some(e => e.ev === 'checkpoint' && e.id === 'F-2'), 'F-2（未交付）checkpoint 留主檔');
    assert.ok(mainJournal.some(e => e.ev === 'spec.frozen'), '全域事件留主檔（不分 task）');

    const archivePath = path.join(root, '.flow', 'archive', 'journal.ndjson');
    assert.ok(existsSync(archivePath), '歸檔檔案落地');
    const archiveEvents = (await readFile(archivePath, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(archiveEvents.length, 3);
    assert.ok(archiveEvents.some(e => e.ev === 'checkpoint' && e.id === 'F-1'));
    assert.ok(archiveEvents.some(e => e.ev === 'task.transition' && e.id === 'F-1'));
    assert.ok(archiveEvents.some(e => e.ev === 'verify.attempt' && e.taskId === 'F-1'));

    const r2 = await S.archiveJournal(root, ['F-1']);
    assert.equal(r2.archived, 0, '再跑一次冪等——F-1 的任務域事件已搬空，沒東西可再搬');
    assert.equal(r2.kept, 2, '主檔內容不變');
  });
});

// ── B 崩潰容錯：原子寫 / mid-task checkpoint / 對帳 reconcile / verifyTaskId 白嫖防線 / summarizeView / pickNext ──

test('writeJSON（經 writeStateJson）：原子寫入內容完整、無 BOM、無殘留 .tmp', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeStateJson(root, { a: 1, 中: '文', verify: 'ok' });
    const st = await S.readStateJson(root);
    assert.equal(st.a, 1);
    assert.equal(st['中'], '文', '中文內容完整（UTF-8）');
    const raw = await readFile(path.join(root, '.flow', 'state.json'), 'utf8');
    assert.equal(raw.charCodeAt(0), '{'.charCodeAt(0), '無 BOM');
    const files = await readdir(path.join(root, '.flow'));
    assert.ok(!files.some(f => f.endsWith('.tmp')), 'rename 後不留 tmp 孤兒');
  });
});

test('recordCheckpoint + reconstruct：帶出每 task 最新 checkpoint（修開發中當機重跑整個 task）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }, { id: 'F-2' }] });
    await S.recordCheckpoint(root, 'F-1', 'red', '測試已寫、紅');
    await S.recordCheckpoint(root, 'F-1', 'green', '轉綠 60%');   // 後一筆覆蓋
    await S.recordCheckpoint(root, 'F-2', 'red', 'x');
    const v = await S.reconstruct(root);
    assert.equal(v.tasks['F-1'].checkpoint.phase, 'green', '取最新一筆');
    assert.equal(v.tasks['F-1'].checkpoint.note, '轉綠 60%');
    assert.ok(v.tasks['F-1'].checkpoint.at, 'checkpoint 有時戳');
    assert.equal(v.tasks['F-2'].checkpoint.phase, 'red');
    assert.equal(v.dangling.length, 0, 'checkpoint 事件不被誤判成 dangling');
  });
});

test('reconcile：tasks.md [x] vs ledger delivered 雙向分歧偵測', () => {
  const md = [
    '- [x] **F-1 · a**',   // [x] 但 ledger building → checkedButNotDelivered（flip 成功、transition 掉了）
    '- [ ] **F-2 · b**',   // [ ] 但 ledger delivered → deliveredButNotChecked（transition 成功、flip 掉了）
    '- [x] **F-3 · c**',   // [x] 且 delivered → 一致
  ].join('\n');
  const ledger = [{ id: 'F-2', state: 'delivered' }, { id: 'F-3', state: 'delivered' }, { id: 'F-1', state: 'building' }];
  const r = S.reconcile(md, ledger);
  assert.deepEqual(r.checkedButNotDelivered, ['F-1']);
  assert.deepEqual(r.deliveredButNotChecked, ['F-2']);
});

test('reconcile：全一致 → 兩邊皆空', () => {
  const r = S.reconcile('- [x] **F-1**\n', [{ id: 'F-1', state: 'delivered' }]);
  assert.equal(r.checkedButNotDelivered.length, 0);
  assert.equal(r.deliveredButNotChecked.length, 0);
});

test('markTaskDone：verifyTaskId 屬於別的 task → 擋白嫖（崩潰殘留的 stale 綠燈），交付後清 verifyTaskId', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }, { id: 'F-2' }] });
    // 模擬 F-1 交付後當機：綠燈與 verifyTaskId=F-1 都殘留（沒歸零）
    await S.writeStateJson(root, { verify: 'ok:e2e', tdd: 'green', verifyTaskId: 'F-1' });
    // F-2 沒驗證就想 done：verify 非 none 過第一關，但綠燈屬於 F-1 → 擋
    await assert.rejects(() => S.markTaskDone(root, 'F-2'), (e) => e.code === 'VERIFY_GATE');
    assert.notEqual((await S.readLedger(root, 'F-2')).state, 'delivered');
    // F-1 自己 done 正常（綠燈就是它的），交付後 verifyTaskId 歸零
    await S.markTaskDone(root, 'F-1');
    assert.equal((await S.readStateJson(root)).verifyTaskId, 'none', '交付即清 verifyTaskId');
  });
});

test('markTaskDone：向後相容——舊 state.json 無 verifyTaskId → 不誤擋（退回原全域檢查）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    await S.writeStateJson(root, { verify: 'ok:e2e', tdd: 'green' });   // 無 verifyTaskId 欄
    await S.markTaskDone(root, 'F-1');
    assert.equal((await S.readLedger(root, 'F-1')).state, 'delivered', '舊專案不被誤擋');
  });
});

test('markTaskDone：verifyTaskId 用嚴格 !== 而非 idMatches——尾段相同的別 task 不誤放行', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1186-W0-5' }, { id: 'W0-5' }] });
    // 綠燈屬於 F-1186-W0-5；task 'W0-5' 想白嫖。idMatches(F-1186-W0-5, W0-5)=true 會誤放行，嚴格 !== 才擋住。
    await S.writeStateJson(root, { verify: 'ok:e2e', tdd: 'green', verifyTaskId: 'F-1186-W0-5' });
    await assert.rejects(() => S.markTaskDone(root, 'W0-5'), (e) => e.code === 'VERIFY_GATE');
    assert.notEqual((await S.readLedger(root, 'W0-5')).state, 'delivered');
  });
});

test('summarizeView：含計數/mode/mid-task checkpoint/dangling/下一步', () => {
  const view = {
    manifest: { tasks: [{ id: 'F-1' }, { id: 'F-2' }] },
    tasks: {
      'F-1': { id: 'F-1', state: 'building', checkpoint: { phase: 'green', note: '60%' } },
      'F-2': { id: 'F-2', state: 'pending', blockedBy: [] },
    },
    dangling: [{ id: 'F-1', action: 'building' }],
    lessons: [], mode: 'auto', order: ['F-1', 'F-2'],
  };
  const out = S.summarizeView(view).join('\n');
  assert.match(out, /已交付 0\/2/);
  assert.match(out, /自駕/);
  assert.match(out, /上次做到第幾步/);
  assert.match(out, /F-1：green（60%）/);
  assert.match(out, /F-1 → building/, 'dangling 列出');
  assert.match(out, /下一步/);
});

test('pickNext：跳過 delivered、解開 blockedBy 已交付的 task', () => {
  const view = {
    manifest: { tasks: [{ id: 'F-1' }, { id: 'F-2', blockedBy: ['F-1'] }, { id: 'F-3' }] },
    tasks: {
      'F-1': { id: 'F-1', state: 'delivered' },
      'F-2': { id: 'F-2', state: 'pending', blockedBy: ['F-1'] },
      'F-3': { id: 'F-3', state: 'pending', blockedBy: [] },
    },
    order: ['F-1', 'F-2', 'F-3'],
  };
  assert.equal(S.pickNext(view).id, 'F-2', 'F-1 delivered 跳過、F-2 依賴已解 → 回 F-2');
});

test('briefStatus：全部 delivered + phase=shipped → hasWork=false（SessionStart 開場靜默）', () => {
  const view = {
    manifest: { phase: 'shipped', tasks: [{ id: 'F-1' }, { id: 'F-2' }] },
    tasks: { 'F-1': { id: 'F-1', state: 'delivered' }, 'F-2': { id: 'F-2', state: 'delivered' } },
    order: ['F-1', 'F-2'],
  };
  assert.equal(S.briefStatus(view).hasWork, false, '全部出貨完 → 不打擾');
});

test('briefStatus：task 全 delivered 但 phase≠shipped → 提醒「待驗證/出貨」', () => {
  const view = {
    manifest: { phase: 'building', tasks: [{ id: 'F-1' }, { id: 'F-2' }] },
    tasks: { 'F-1': { id: 'F-1', state: 'delivered' }, 'F-2': { id: 'F-2', state: 'delivered' } },
    order: ['F-1', 'F-2'],
  };
  const b = S.briefStatus(view);
  assert.equal(b.hasWork, true, 'task 做完但沒 ship → 仍要提醒、不讓使用者以為完成');
  assert.match(b.line, /待驗證\/出貨/);
});

test('briefStatus：開發中 + 等你決策 → 提醒一行', () => {
  const view = {
    manifest: { phase: 'building', tasks: [{ id: 'F-1' }, { id: 'F-2' }] },
    tasks: { 'F-1': { id: 'F-1', state: 'building' }, 'F-2': { id: 'F-2', state: 'needs-decision' } },
    order: ['F-1', 'F-2'],
  };
  const b = S.briefStatus(view);
  assert.equal(b.hasWork, true);
  assert.match(b.line, /開發中 1/);
  assert.match(b.line, /等你決策/);
});

// ── Codex 審查後的恢復增強：白嫖根治／deliveredNoCommit／dangling 提醒／mode 進 manifest ──

test('markTaskDone：from=verifying（verify 不搶標 delivered 的新流程）→ done 仍歸零、堵下個 task 白嫖（連舊專案無 verifyTaskId）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }, { id: 'F-2' }] });
    await S.writeLedger(root, 'F-1', { state: 'verifying' });           // verify 只到 verifying、不搶標 delivered
    await S.writeStateJson(root, { verify: 'ok:e2e', tdd: 'green' });   // 舊專案：無 verifyTaskId
    await S.markTaskDone(root, 'F-1');                                  // done 是唯一 delivered 入口
    assert.equal((await S.readLedger(root, 'F-1')).state, 'delivered');
    assert.equal((await S.readStateJson(root)).verify, 'none', 'from=verifying 仍歸零（done 唯一正門→一定清綠燈）');
    await assert.rejects(() => S.markTaskDone(root, 'F-2'), (e) => e.code === 'VERIFY_GATE', '下個 task 借不到、連舊專案也防');
  });
});

test('reconcile：delivered 但 ledger 無 commit → deliveredNoCommit（done 後 commit 前當機）', () => {
  const r = S.reconcile('- [x] **F-1**\n- [x] **F-2**\n', [
    { id: 'F-1', state: 'delivered', commit: 'abc123' },
    { id: 'F-2', state: 'delivered' },                                  // 無 commit
  ]);
  assert.deepEqual(r.deliveredNoCommit, ['F-2']);
});

test('briefStatus：全 delivered+shipped 但有 dangling 動作 → 仍 hasWork、列出未完成動作', () => {
  const view = {
    manifest: { phase: 'shipped', tasks: [{ id: 'F-1' }] },
    tasks: { 'F-1': { id: 'F-1', state: 'delivered' } },
    dangling: [{ id: 'F-1', action: 'deploy' }],
    order: ['F-1'],
  };
  const b = S.briefStatus(view);
  assert.equal(b.hasWork, true, 'dangling 不該被靜默漏掉');
  assert.match(b.line, /未完成動作/);
});

test('reconstruct：mode 優先讀 git-tracked manifest（換機 clone 後自駕不掉回 manual）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeManifest(root, { ...(await S.readManifest(root)), mode: 'auto' });   // manifest 有 mode、state.json 無
    assert.equal((await S.reconstruct(root)).mode, 'auto', '從 manifest 帶出 auto');
  });
});

// ── 第 3 波：波次計算（W3-1）＋ worker 逐字投餵（W3-2）純函式 ──

test('computeWaves：線性依賴 → 逐波拆開', () => {
  const m = { tasks: [
    { id: 'F-1', blockedBy: [], conflictZone: ['a/'] },
    { id: 'F-2', blockedBy: ['F-1'], conflictZone: ['b/'] },
    { id: 'F-3', blockedBy: ['F-2'], conflictZone: ['c/'] },
  ] };
  const r = S.computeWaves(m, []);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.waves, [['F-1'], ['F-2'], ['F-3']]);
});

test('computeWaves：無依賴＋zone 不重疊 → 全同一波（字典序）', () => {
  const m = { tasks: [
    { id: 'F-2', blockedBy: [], conflictZone: ['b/'] },
    { id: 'F-1', blockedBy: [], conflictZone: ['a/'] },
  ] };
  const r = S.computeWaves(m, []);
  assert.deepEqual(r.waves, [['F-1', 'F-2']], '同層按 id 字典序、非 manifest 插入序');
});

test('computeWaves：conflictZone 前綴重疊 → 自動拆波＋warning（不 exit）', () => {
  const m = { tasks: [
    { id: 'F-1', blockedBy: [], conflictZone: ['src/'] },
    { id: 'F-2', blockedBy: [], conflictZone: ['src/x.ts'] },  // 落在 src/ 內＝重疊
  ] };
  const r = S.computeWaves(m, []);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.waves, [['F-1'], ['F-2']], '重疊者延到後波');
  assert.ok(r.warnings.some((w) => /F-2/.test(w)), '有並行度受限 warning');
});

test('computeWaves：src/ab 不算 src/a 的子路徑（路徑邊界，非裸子字串）', () => {
  const m = { tasks: [
    { id: 'F-1', blockedBy: [], conflictZone: ['src/a'] },
    { id: 'F-2', blockedBy: [], conflictZone: ['src/ab'] },
  ] };
  const r = S.computeWaves(m, []);
  assert.deepEqual(r.waves, [['F-1', 'F-2']], 'src/a 與 src/ab 不重疊、可同波');
});

test('computeWaves：已 delivered 的 task 不進波、解開其下游', () => {
  const m = { tasks: [
    { id: 'F-1', blockedBy: [], conflictZone: ['a/'] },
    { id: 'F-2', blockedBy: ['F-1'], conflictZone: ['b/'] },
  ] };
  const r = S.computeWaves(m, ['F-1']);
  assert.deepEqual(r.waves, [['F-2']], 'F-1 已交付被排除、F-2 依賴滿足直接可跑');
});

test('computeWaves：blockedBy 成環 → problems 非空（拓樸無解）', () => {
  const m = { tasks: [
    { id: 'F-1', blockedBy: ['F-2'], conflictZone: ['a/'] },
    { id: 'F-2', blockedBy: ['F-1'], conflictZone: ['b/'] },
  ] };
  const r = S.computeWaves(m, []);
  assert.ok(r.problems.length, '成環回 problems');
  assert.match(r.problems[0], /拓樸無解|成環/);
});

test('computeWaves：懸空依賴（blockedBy 指向不存在/永不交付）→ problems 非空', () => {
  const m = { tasks: [{ id: 'F-1', blockedBy: ['GHOST'], conflictZone: ['a/'] }] };
  const r = S.computeWaves(m, []);
  assert.ok(r.problems.length);
  assert.match(r.problems[0], /F-1/, '列出被卡死進不了波的 task');
  assert.deepEqual(r.waves, [], '無任何波');
});

test('taskReqIds：抽每 task 行承接的 REQ id（只掃 checkbox 行）', () => {
  const md = [
    '- [ ] **F-1 · 登入（對應 REQ-E2E-001）**',
    '- [ ] F-2 報表（對應 REQ-E2E-002, REQ-PERF-001）',
    '  這行是註解不是 task：REQ-E2E-999',   // 非 checkbox 行 → 不算承接
  ].join('\n');
  assert.deepEqual(S.taskReqIds(md), {
    'F-1': ['REQ-E2E-001'],
    'F-2': ['REQ-E2E-002', 'REQ-PERF-001'],
  });
});

test('extractReqBlock：逐字抽定義區塊、找不到回 null', () => {
  const md = [
    '## 需求',
    '',
    '- **REQ-E2E-001** 使用者登入',
    '  詳細：帳密驗證、鎖定策略',
    '',
    '- **REQ-E2E-002** 報表匯出',
  ].join('\n');
  const blk = S.extractReqBlock(md, 'REQ-E2E-001');
  assert.ok(/REQ-E2E-001/.test(blk) && /帳密驗證/.test(blk), '含定義行與細節');
  assert.ok(!/REQ-E2E-002/.test(blk), '切界在下個 REQ 定義行');
  assert.equal(S.extractReqBlock(md, 'REQ-E2E-999'), null);
});

test('buildWavePlan：組裝波次＋逐字 reqText；承接 REQ 抽不到 → problems', () => {
  const m = { tasks: [
    { id: 'F-1', blockedBy: [], conflictZone: ['a/'] },
    { id: 'F-2', blockedBy: ['F-1'], conflictZone: ['b/'] },
  ] };
  const reqMd = [
    '- **REQ-E2E-001** 登入',
    '  帳密驗證',
    '- **REQ-E2E-002** 報表',
  ].join('\n');
  const tasksMd = [
    '- [ ] F-1 登入（對應 REQ-E2E-001）',
    '- [ ] F-2 報表（對應 REQ-E2E-002）',
  ].join('\n');
  const idx = { reqHash: S.sha256Text(reqMd) };
  const plan = S.buildWavePlan(m, [], tasksMd, reqMd, idx);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.waves.length, 2);
  assert.equal(plan.waves[0][0].id, 'F-1');
  assert.ok(/帳密驗證/.test(plan.waves[0][0].reqText), 'reqText 逐字內嵌');
  assert.equal(plan.reqHash, idx.reqHash);
  // 承接一個 requirements.md 沒有的 REQ → problems 非空
  const bad = S.buildWavePlan(m, [], '- [ ] F-1 x（對應 REQ-E2E-999）', reqMd, idx);
  assert.ok(bad.problems.length);
  assert.match(bad.problems[0], /REQ-E2E-999/);
});

test('buildWavePlan：glob 前綴（REQ-PERF-*）不抽區塊、不算 missing', () => {
  const m = { tasks: [{ id: 'F-1', blockedBy: [], conflictZone: ['a/'] }] };
  const reqMd = '- **REQ-E2E-001** 登入\n';
  const tasksMd = '- [ ] F-1 全部（對應 REQ-E2E-001, REQ-PERF-*）';
  const plan = S.buildWavePlan(m, [], tasksMd, reqMd, { reqHash: S.sha256Text(reqMd) });
  assert.deepEqual(plan.problems, [], 'REQ-PERF-* glob 前綴被跳過、不判 missing');
  assert.deepEqual(plan.waves[0][0].reqIds, ['REQ-E2E-001']);
});

test('waveMembershipProblem：成員相符 null、不符/漂移/無 plan 各回正確', () => {
  const m = { tasks: [{ id: 'F-1' }, { id: 'F-2' }] };
  const plan = { waves: [[{ id: 'F-1' }, { id: 'F-2' }]], manifestHash: S.manifestScopeHash(m) };
  assert.equal(S.waveMembershipProblem(plan, m, ['F-2', 'F-1']), null, '成員集合相等、順序無關');
  assert.match(S.waveMembershipProblem(plan, m, ['F-1']), /不對應.*任何一波|成員/, '缺一個成員→不符');
  const m2 = { tasks: [{ id: 'F-1' }, { id: 'F-2' }, { id: 'F-3' }] };  // hash 變了
  assert.match(S.waveMembershipProblem(plan, m2, ['F-1', 'F-2']), /manifest.*不符|漂移|重跑/, 'manifest 漂移→擋');
  assert.equal(S.waveMembershipProblem(null, m, ['F-1']), null, '無 wave-plan→相容跳過');
});

// ── 第 3 波對抗驗證修復回歸 ──

test('#10：manifestScopeHash 對 updatedAt/mode/projectType 穩定、只認 blockedBy/conflictZone', () => {
  const m1 = { tasks: [{ id: 'F-1', blockedBy: [], conflictZone: ['a/'] }], updatedAt: 't0', mode: 'manual' };
  const m2 = { tasks: [{ id: 'F-1', blockedBy: [], conflictZone: ['a/'] }], updatedAt: 't1', mode: 'auto', projectType: 'web' };
  assert.equal(S.manifestScopeHash(m1), S.manifestScopeHash(m2), 'updatedAt/mode/projectType 不影響 hash（否則 wave --compute 後跑 mode 誤判漂移）');
  const m3 = { tasks: [{ id: 'F-1', blockedBy: ['F-0'], conflictZone: ['a/'] }] };
  assert.notEqual(S.manifestScopeHash(m1), S.manifestScopeHash(m3), 'blockedBy 變則 hash 變');
  assert.equal(
    S.manifestScopeHash({ tasks: [{ id: 'F-1', conflictZone: ['a/'] }] }),
    S.manifestScopeHash({ tasks: [{ id: 'F-1', conflictZone: ['a'] }] }),
    'zone 尾斜線正規化');
});

test('#11：extractAllReqIds 不吞尾 ASCII 句點（task 行 REQ id 接句號）', () => {
  assert.deepEqual(S.extractAllReqIds('對應 REQ-E2E-001.'), ['REQ-E2E-001'], '尾點不進 id（否則變幻覺 id）');
  assert.deepEqual(S.extractAllReqIds('REQ-E2E-001, REQ-PERF-002'), ['REQ-E2E-001', 'REQ-PERF-002']);
});

test('W0-2 hookWiringProblems：實存 flow hook 未註冊即回報；test/非註冊型/dispatch 合併門/非 flow 檔排除', () => {
  const files = ['flow-size-check.mjs', 'flow-auto-gate.mjs', 'flow-spec-gate.mjs', 'flow-commit-gate.mjs',
    'flow-commit-gate.test.mjs', 'flow-precommit.mjs', 'commit-gate-core.mjs', 'settings.flow.json'];
  const settings = '{"hooks":{"PreToolUse":[{"hooks":[{"command":"node hooks/flow-dispatch.mjs"}]}]}}';
  assert.deepEqual(S.hookWiringProblems(files, settings), ['flow-size-check.mjs'],
    'size-check 檔案在、沒接線 → 回報；C-3① 經 dispatch 合併的 auto/spec/commit-gate 豁免；.test/precommit/core 不算');
  assert.deepEqual(S.hookWiringProblems(files, settings + ' flow-size-check.mjs'), [], '接上即空');
  assert.deepEqual(S.hookWiringProblems([], settings), [], '空清單不炸');
});

test('W0-5 syncDrift：內容不一致/安裝區缺檔回報，方向提示認 mtime；test 檔與 design-systems 排除', async () => {
  await withRoot(async (root) => {
    const src = path.join(root, 'dist');
    const home = path.join(root, 'home');
    await mkdir(path.join(src, 'hooks'), { recursive: true });
    await mkdir(path.join(src, 'skills', 'flow-toolkit', 'references', 'design-systems'), { recursive: true });
    await mkdir(path.join(home, 'hooks'), { recursive: true });
    await writeFile(path.join(src, 'hooks', 'a.mjs'), 'same', 'utf8');
    await writeFile(path.join(home, 'hooks', 'a.mjs'), 'same', 'utf8');
    await writeFile(path.join(src, 'hooks', 'b.mjs'), 'old', 'utf8');
    await new Promise((r) => setTimeout(r, 20));                       // 確保 home 的 mtime 較新
    await writeFile(path.join(home, 'hooks', 'b.mjs'), 'hotfixed', 'utf8');
    await writeFile(path.join(src, 'hooks', 'c.mjs'), 'new-file', 'utf8');           // 安裝區沒有
    await writeFile(path.join(src, 'hooks', 'd.test.mjs'), 'test', 'utf8');          // 排除
    await writeFile(path.join(src, 'skills', 'flow-toolkit', 'references', 'design-systems', 'x.css'), 'skip', 'utf8');
    const d = await S.syncDrift(src, home);
    assert.deepEqual(d.missing, ['hooks/c.mjs'], 'test 檔與 design-systems 不算 missing');
    assert.equal(d.differing.length, 1);
    assert.equal(d.differing[0].rel, 'hooks/b.mjs');
    assert.equal(d.differing[0].newer, 'installed', '安裝區較新 → 提示回寫 dist');
  });
});

// ── Batch 2：C-48 ID_RE 放寬、C-13 isGateThrash ──
test('flipCheckbox / lineId：字母緊接數字的 id（W0-5/T1-2）解析得到（C-48，原 ID_RE 解析成 null）', () => {
  const md = '- [ ] **W0-5** 波\n- [ ] **T1-2** 拓樸\n';
  assert.ok(/- \[x\] \*\*W0-5\*\*/.test(S.flipCheckbox(md, 'W0-5').text), 'W0-5 被翻勾');
  assert.ok(/- \[x\] \*\*T1-2\*\*/.test(S.flipCheckbox(md, 'T1-2').text), 'T1-2 被翻勾');
  // 既有 REQ-E2E-001 / F-1 樣式不回歸
  assert.ok(/- \[x\] \*\*F-1\*\*/.test(S.flipCheckbox('- [ ] **F-1**\n', 'F-1').text), 'F-1 仍可翻');
});

test('isGateThrash：flow-state 閘門連紅偵測（C-13）——只給 stall 軟提醒、不進 isRunnerCommand（不上硬天花板）', () => {
  assert.ok(S.isGateThrash('node ~/.claude/skills/flow-toolkit/flow-state.mjs complete-check'));
  assert.ok(S.isGateThrash('flow-state plan-check'));
  assert.ok(!S.isGateThrash('flow-state done F-1'), 'done 不是閘門');
  assert.ok(!S.isGateThrash('npm test'));
  assert.ok(!S.isRunnerCommand('flow-state complete-check'), '閘門不進 isRunnerCommand（否則 auto-gate 硬擋掉 complete-check）');
});

// ── C-20 非字面 goto 警告、C-3③ syncFingerprint ──
test('auditJourneyTest：page.goto(變數) 非字面＋另一 goto → 警告（C-20，非阻擋）', () => {
  const c = "import {test} from '@playwright/test'\ntest('x', async ({page}) => { await page.goto('/login'); await page.goto(target); await page.getByRole('button').click() })";
  const r = S.auditJourneyTest(c);
  assert.ok(r.isJourney);
  assert.ok(r.warnings.some(w => /非字面 goto/.test(w)), '有非字面 goto 警告');
  // 單一字面入口 goto ＋點擊 → 不噴非字面警告
  const clean = "import {test} from '@playwright/test'\ntest('x', async ({page}) => { await page.goto('/login'); await page.getByRole('button').click() })";
  assert.ok(!S.auditJourneyTest(clean).warnings.some(w => /非字面 goto/.test(w)), '單一字面入口不誤噴');
});

test('syncFingerprint：回穩定字串、內容不變同指紋（C-3③）', async () => {
  const here2 = path.dirname(fileURLToPath(import.meta.url));   // skills/flow-toolkit
  const fp1 = await S.syncFingerprint(here2, here2);
  const fp2 = await S.syncFingerprint(here2, here2);
  assert.equal(typeof fp1, 'string');
  assert.equal(fp1, fp2, '同輸入同指紋（stat-only 冪等）');
  assert.match(fp1, /^\d+:\d+:\d+$/, 'count:maxMtime:totalSize 格式');
});
