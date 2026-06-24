// flow-state.test.mjs — flow-state CLI 黑箱測試（spawn node、斷言 exit code/stdout/stderr）。
// 釘住兩個確定性閘門的 fail 方向：done（verify 空 → exit 2）、redteam（high 未 covered / testFile 不實存 → exit 2）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './statelib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'flow-state.mjs');

function run(args, root) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
async function withRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowcli-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('done：verify 空/none → exit 2（done 閘門，堵繞過 TaskUpdate 的權威路徑旁路）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    await S.writeStateJson(root, { verify: 'none', tdd: 'green' });
    const r = run(['done', 'F-1'], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /verify/);
    assert.notEqual((await S.readLedger(root, 'F-1')).state, 'delivered');
  });
});

test('done：verify ok＋tdd green → 成功交付＋綠燈歸零', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    await S.writeStateJson(root, { verify: 'ok:e2e', tdd: 'green' });
    const r = run(['done', 'F-1'], root);
    assert.equal(r.code, 0);
    assert.equal((await S.readLedger(root, 'F-1')).state, 'delivered');
    assert.equal((await S.readStateJson(root)).verify, 'none', '交付即歸零');
  });
});

test('done：歧義尾段 id → exit 1 並列候選', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-A-W0-5' }, { id: 'F-B-W0-5' }] });
    await S.writeStateJson(root, { verify: 'ok:x', tdd: 'green' });
    const r = run(['done', 'W0-5'], root);
    assert.equal(r.code, 1);
    assert.match(r.err, /F-A-W0-5/);
    assert.match(r.err, /F-B-W0-5/);
  });
});

test('redteam：缺落檔 → exit 2', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    const r = run(['redteam', '--wave', 'F-1'], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /未落檔/);
  });
});

test('redteam：high 攻擊 skipped / testFile 不存在 → exit 2；全 covered 且實存 → 通過', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    const dir = path.join(root, '.flow', 'redteam');
    await mkdir(dir, { recursive: true });
    // high 被 skipped → 擋
    await writeFile(path.join(dir, 'F-1.json'), JSON.stringify({
      attacks: [{ id: 'A1', severity: 'high' }, { id: 'A2', severity: 'low' }],
      coverage: [{ attackId: 'A1', status: 'skipped', reason: 'lazy' }],
    }), 'utf8');
    assert.equal(run(['redteam', '--wave', 'F-1'], root).code, 2, 'high 不准 skipped');
    // covered 但 testFile 不存在 → 擋（自報偽造不了檔案存在性）
    await writeFile(path.join(dir, 'F-1.json'), JSON.stringify({
      attacks: [{ id: 'A1', severity: 'high' }],
      coverage: [{ attackId: 'A1', status: 'covered', testFile: 'tests/ghost.test.ts' }],
    }), 'utf8');
    assert.equal(run(['redteam', '--wave', 'F-1'], root).code, 2, 'testFile 要真的在');
    // covered 且 testFile 實存且為真測試 → 通過（low 攻擊不強制）
    await mkdir(path.join(root, 'tests'), { recursive: true });
    await writeFile(path.join(root, 'tests', 'a1.test.ts'),
      "import { test, expect } from 'vitest'\ntest('A1 sql injection blocked', () => { expect(safe).toBe(true) })\n", 'utf8');
    await writeFile(path.join(dir, 'F-1.json'), JSON.stringify({
      attacks: [{ id: 'A1', severity: 'high' }, { id: 'A2', severity: 'low' }],
      coverage: [{ attackId: 'A1', status: 'covered', testFile: 'tests/a1.test.ts' }],
    }), 'utf8');
    const r = run(['redteam', '--wave', 'F-1'], root);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /通過/);
  });
});

test('redteam：testFile 是空殼/無測試關鍵字 → exit 2（堵 touch 空檔即過閘）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    const dir = path.join(root, '.flow', 'redteam');
    await mkdir(dir, { recursive: true });
    await mkdir(path.join(root, 'tests'), { recursive: true });
    await writeFile(path.join(root, 'tests', 'empty.ts'), '   \n', 'utf8');           // 空殼
    await writeFile(path.join(dir, 'F-1.json'), JSON.stringify({
      attacks: [{ id: 'A1', severity: 'high' }],
      coverage: [{ attackId: 'A1', status: 'covered', testFile: 'tests/empty.ts' }],
    }), 'utf8');
    assert.equal(run(['redteam', '--wave', 'F-1'], root).code, 2, '空殼不算 covered');
    await writeFile(path.join(root, 'tests', 'nokw.ts'), 'const x = 1; console.log(x); // 不含測試框架關鍵字 just code', 'utf8');
    await writeFile(path.join(dir, 'F-1.json'), JSON.stringify({
      attacks: [{ id: 'A1', severity: 'high' }],
      coverage: [{ attackId: 'A1', status: 'covered', testFile: 'tests/nokw.ts' }],
    }), 'utf8');
    assert.equal(run(['redteam', '--wave', 'F-1'], root).code, 2, '無測試關鍵字不算 covered');
  });
});

test('guardrail-check：settings 缺 stall 斷路器 → exit 2；含則 0', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    const home = path.join(root, 'fakehome');
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, 'settings.json'), JSON.stringify({ hooks: {} }), 'utf8');
    assert.equal(run(['guardrail-check', '--claude-home', home], root).code, 2, '缺斷路器');
    await writeFile(path.join(home, 'settings.json'),
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ command: 'node hooks/flow-stall-monitor.mjs' }] }] } }), 'utf8');
    assert.equal(run(['guardrail-check', '--claude-home', home], root).code, 0, '含斷路器放行');
  });
});

test('complete-check：tasks.md 有未完成 [ ] → exit 2；全 [x] → 0', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await mkdir(path.join(root, 'specs'), { recursive: true });
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [x] **F-1**\n- [ ] **F-2**\n', 'utf8');
    assert.equal(run(['complete-check'], root).code, 2, '還有未完成 → 不准 COMPLETE');
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [x] **F-1**\n- [x] **F-2**\n', 'utf8');
    assert.equal(run(['complete-check'], root).code, 0, '全 [x] 放行');
  });
});

test('decision：歧義尾段 id → exit 1 並列候選（不靜默 fallback）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-A-W0-5' }, { id: 'F-B-W0-5' }] });
    const r = run(['decision', 'W0-5', '--choice', 'x'], root);
    assert.equal(r.code, 1);
    assert.match(r.err, /F-A-W0-5/);
  });
});
