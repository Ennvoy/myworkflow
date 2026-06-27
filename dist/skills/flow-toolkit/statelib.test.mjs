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

// ── done 閘門（堵「不走 TaskUpdate 直接 flow-state done」的權威路徑旁路 + stale 綠燈白嫖）──

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
  assert.equal(S.runnerBucket('NPM RUN TEST'), 'npm run test', '小寫正規化');
  assert.ok(S.runnerBucket('') === '_runner', '空命令有 fallback key');
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

test('specReadiness：無 ### 開放問題 標題 → open 視為零（不誤擋）', () => {
  const r = S.specReadiness('REQ-001：x\nREQ-E2E-001：j\nREQ-PERF-001：N/A');
  assert.equal(r.open.length, 0);
  assert.equal(r.problems.length, 0);
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
