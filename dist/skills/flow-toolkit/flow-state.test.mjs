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

const READY_REQ = [
  '# 需求', 'REQ-001：當 X 時，系統應 Y。',
  'REQ-E2E-001：登入 → 首頁 → 操作 → 斷言。',
  'REQ-PERF-001：dashboard LCP < 2.5s（p95）。',
  '### 開放問題', '無',
].join('\n');
async function writeReq(root, md) {
  await mkdir(path.join(root, 'specs'), { recursive: true });
  await writeFile(path.join(root, 'specs', 'requirements.md'), md, 'utf8');
}

test('spec-ready：查無 requirements.md → exit 2', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    const r = run(['spec-ready'], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /requirements\.md/);
  });
});

test('spec-ready：開放問題未清零 → exit 2 並列出未收斂項', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ.replace('### 開放問題\n無', '### 開放問題\n- 刪父層時子資源連帶失效？'));
    const r = run(['spec-ready'], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /未收斂/);
    assert.match(r.err, /子資源/);
  });
});

test('spec-ready：清零＋REQ 齊 → exit 0（檢查不寫 phase）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeStateJson(root, { mode: 'auto' });
    await writeReq(root, READY_REQ);
    const r = run(['spec-ready'], root);
    assert.equal(r.code, 0, r.err);
    assert.notEqual((await S.readStateJson(root)).phase, 'spec-done', '純檢查不該寫 phase');
  });
});

test('spec-ready --freeze：通過才寫 phase=spec-done + journal，且保留 mode', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeStateJson(root, { mode: 'auto', verify: 'none' });
    await writeReq(root, READY_REQ);
    const r = run(['spec-ready', '--freeze'], root);
    assert.equal(r.code, 0, r.err);
    const st = await S.readStateJson(root);
    assert.equal(st.phase, 'spec-done');
    assert.equal(st.mode, 'auto', 'read-modify-write 保留既有欄位');
    assert.ok((await S.readJournal(root)).some(e => e.ev === 'spec.frozen'), 'journal 留 spec.frozen 審計');
  });
});

test('spec-ready --freeze：未收斂 → exit 2 且不寫 phase', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ.replace('REQ-E2E-001：登入 → 首頁 → 操作 → 斷言。\n', ''));  // 抽掉 REQ-E2E
    const r = run(['spec-ready', '--freeze'], root);
    assert.equal(r.code, 2);
    assert.notEqual((await S.readStateJson(root)).phase, 'spec-done', '沒過閘門不准凍結');
  });
});

// ── mockup-check：互動原型走查閘門（覆蓋骨架機檢，堵「片面原型就請使用者定版」）──

async function writeMockups(root, indexHtml, pages = {}) {
  const dir = path.join(root, 'specs', 'ui-mockups');
  await mkdir(dir, { recursive: true });
  if (indexHtml !== null) await writeFile(path.join(dir, 'index.html'), indexHtml, 'utf8');
  for (const [name, html] of Object.entries(pages)) await writeFile(path.join(dir, name), html, 'utf8');
}

test('mockup-check：查無 index.html → exit 2', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);
    await writeMockups(root, null, { 'login.html': '<html>x</html>' });
    const r = run(['mockup-check'], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /index\.html/);
  });
});

test('mockup-check：走查台缺 REQ-E2E 卡 → exit 2 並點名', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ + '\nREQ-E2E-002：下單 journey。');
    await writeMockups(root, '<h2>REQ-E2E-001</h2><a href="login.html">走</a>', { 'login.html': '<html>x</html>' });
    const r = run(['mockup-check'], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /REQ-E2E-002/);
  });
});

test('mockup-check：走查台連結 404 → exit 2；補檔即綠', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);
    await writeMockups(root, '<h2>REQ-E2E-001</h2><a href="pages/login.html">走</a>');
    const r = run(['mockup-check'], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /404/);
    await mkdir(path.join(root, 'specs', 'ui-mockups', 'pages'), { recursive: true });
    await writeFile(path.join(root, 'specs', 'ui-mockups', 'pages', 'login.html'), '<html>x</html>', 'utf8');
    const r2 = run(['mockup-check'], root);
    assert.equal(r2.code, 0, r2.err);
    assert.match(r2.out, /通過/);
  });
});

test('spec-ready --freeze：ui-mockups 存在但走查台缺卡 → exit 2 不凍結；目錄不存在 → 照常凍結', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ + '\nREQ-E2E-002：下單 journey。');
    await writeMockups(root, '<h2>REQ-E2E-001</h2>');   // 缺 002 的走查卡
    const r = run(['spec-ready', '--freeze'], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /REQ-E2E-002/);
    assert.notEqual((await S.readStateJson(root)).phase, 'spec-done', '走查台不完整不准凍結');
  });
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);
    const r = run(['spec-ready', '--freeze'], root);   // 無 ui-mockups/（非 web / 已記豁免）
    assert.equal(r.code, 0, r.err);
    assert.equal((await S.readStateJson(root)).phase, 'spec-done');
  });
});

// ── verify-e2e 記錄 + coverage 對賬（REQ-E2E 覆蓋的確定性節點）──

test('verify-e2e：pass 缺 --evidence → exit 1（堵空綠）；附 evidence → 落檔', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    assert.equal(run(['verify-e2e', 'REQ-E2E-001', '--status', 'pass'], root).code, 1, 'pass 須附證據');
    const r = run(['verify-e2e', 'REQ-E2E-001', '--status', 'pass', '--evidence', 'trace.zip'], root);
    assert.equal(r.code, 0, r.err);
    const recs = await S.listVerifyRecords(root);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].id, 'REQ-E2E-001');
    assert.equal(recs[0].status, 'pass');
  });
});

test('coverage：spec 有 REQ-E2E 但無記錄 → exit 2 列 missing；補齊 pass → exit 0', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);   // 含 REQ-E2E-001
    const miss = run(['coverage'], root);
    assert.equal(miss.code, 2);
    assert.match(miss.err, /REQ-E2E-001/);
    run(['verify-e2e', 'REQ-E2E-001', '--status', 'pass', '--evidence', 'e2e green'], root);
    const ok = run(['coverage'], root);
    assert.equal(ok.code, 0, ok.err);
  });
});

test('coverage：查無 requirements.md → exit 2', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    assert.equal(run(['coverage'], root).code, 2);
  });
});

test('complete-check：tasks 全 [x] 但 REQ-E2E 無驗證記錄 → exit 2（升級後逐條對賬）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await mkdir(path.join(root, 'specs'), { recursive: true });
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [x] **F-1**\n', 'utf8');
    await writeReq(root, READY_REQ);   // REQ-E2E-001 無記錄
    const r = run(['complete-check'], root);
    assert.equal(r.code, 2, 'REQ-E2E 未覆蓋 → 不准 COMPLETE');
    assert.match(r.err, /REQ-E2E-001/);
    // 記了 pass → 放行
    run(['verify-e2e', 'REQ-E2E-001', '--status', 'pass', '--evidence', 'green'], root);
    assert.equal(run(['complete-check'], root).code, 0, '補齊覆蓋後放行');
  });
});

// ── journey-check：journey 真實性閘門（導航版禁 mock 假綠）──

async function writeSpec(root, rel, content) {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

test('journey-check：測試含 page.route 假後端 → exit 2', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeSpec(root, 'tests/e2e/bad.spec.ts',
      "import {test} from '@playwright/test'\ntest('x', async ({page}) => { await page.route('**/api/**', r=>r.fulfill({body:'{}'})); await page.goto('/') })");
    const r = run(['journey-check'], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /route|mock|攔截/);
  });
});

test('journey-check：單一 test 內 >1 goto → exit 2', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeSpec(root, 'tests/e2e/jump.spec.ts',
      "import {test} from '@playwright/test'\ntest('x', async ({page}) => { await page.goto('/login'); await page.goto('/admin/x/1') })");
    const r = run(['journey-check'], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /goto/);
  });
});

test('journey-check：合法 journey 測試 → exit 0', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeSpec(root, 'tests/e2e/good.spec.ts',
      "import {test, expect} from '@playwright/test'\ntest('x', async ({page}) => { await page.goto('/login'); await page.getByRole('button',{name:/登入/}).click(); await expect(page).toHaveURL(/home/) })");
    const r = run(['journey-check'], root);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /通過/);
  });
});

test('journey-check：找不到 journey 測試 → exit 0（非 web 專案不誤擋）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    const r = run(['journey-check'], root);
    assert.equal(r.code, 0);
    assert.match(r.out, /未找到/);
  });
});

// ── checkpoint 子命令 + resume 的 mid-task 進度／對帳輸出（B 崩潰接續）──

test('checkpoint：記一筆後 resume 帶出「上次做到第幾步」', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    await S.transition(root, 'F-1', 'pending', 'building');
    const c = run(['checkpoint', 'F-1', '--phase', 'green', '--note', '轉綠60%'], root);
    assert.equal(c.code, 0, c.err);
    const r = run(['resume'], root);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /上次做到第幾步/);
    assert.match(r.out, /F-1：green/);
  });
});

test('checkpoint：缺 --phase → exit 1', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    assert.equal(run(['checkpoint', 'F-1'], root).code, 1);
  });
});

test('resume：tasks.md 與 ledger 對不上 → 印對帳提示（ledger 唯一真相）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    await mkdir(path.join(root, 'specs'), { recursive: true });
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [x] **F-1 · a**\n', 'utf8');  // [x] 但 ledger 無 delivered
    const r = run(['resume'], root);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /對不上|重同步/);
    assert.match(r.out, /F-1/);
  });
});

test('mode：寫進 manifest + state.json，reconstruct 讀得到；非法值 exit 1', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    const r = run(['mode', 'auto'], root);
    assert.equal(r.code, 0, r.err);
    assert.equal((await S.readManifest(root)).mode, 'auto', 'manifest 有 mode（進 git）');
    assert.equal((await S.readStateJson(root)).mode, 'auto', 'state.json 同步（相容）');
    assert.equal((await S.reconstruct(root)).mode, 'auto');
    assert.equal(run(['mode', 'bad'], root).code, 1, '非法值擋下');
  });
});

test('resume：ledger delivered 但無 commit → 提示「已交付但沒記 commit」', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    await S.writeLedger(root, 'F-1', { state: 'delivered' });   // 無 commit（done 後 commit 前當機）
    await mkdir(path.join(root, 'specs'), { recursive: true });
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [x] **F-1 · a**\n', 'utf8');
    const r = run(['resume'], root);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /沒記 commit|沒記 commit sha/);
    assert.match(r.out, /F-1/);
  });
});
