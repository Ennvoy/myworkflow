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
// run --task 專用：--root 須在 -- 之前（-- 之後全歸 runner 命令），不能用上面會 append --root 的 run()
function runTask(taskId, cmdArr, root) {
  const r = spawnSync(process.execPath, [CLI, 'run', '--task', taskId, '--root', root, '--', ...cmdArr], { encoding: 'utf8' });
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

// 良性 low 攻擊（不含高危關鍵字、無 coverage 也合法）——湊 minItems:3 鏡射檢查用
const BENIGN = [{ id: 'A8', severity: 'low', scenario: '清單空狀態顯示錯誤' }, { id: 'A9', severity: 'low', scenario: '長字串截斷顯示' }];

test('redteam：high 攻擊 skipped / testFile 不存在 → exit 2；全 covered 且實存 → 通過', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    const dir = path.join(root, '.flow', 'redteam');
    await mkdir(dir, { recursive: true });
    // high 被 skipped → 擋
    await writeFile(path.join(dir, 'F-1.json'), JSON.stringify({
      attacks: [{ id: 'A1', severity: 'high' }, ...BENIGN],
      coverage: [{ attackId: 'A1', status: 'skipped', reason: 'lazy' }],
    }), 'utf8');
    assert.equal(run(['redteam', '--wave', 'F-1'], root).code, 2, 'high 不准 skipped');
    // covered 但 testFile 不存在 → 擋（自報偽造不了檔案存在性）
    await writeFile(path.join(dir, 'F-1.json'), JSON.stringify({
      attacks: [{ id: 'A1', severity: 'high' }, ...BENIGN],
      coverage: [{ attackId: 'A1', status: 'covered', testFile: 'tests/ghost.test.ts' }],
    }), 'utf8');
    assert.equal(run(['redteam', '--wave', 'F-1'], root).code, 2, 'testFile 要真的在');
    // covered 且 testFile 實存且為真測試 → 通過（良性 low 攻擊不強制）
    await mkdir(path.join(root, 'tests'), { recursive: true });
    await writeFile(path.join(root, 'tests', 'a1.test.ts'),
      "import { test, expect } from 'vitest'\ntest('A1 sql injection blocked', () => { expect(safe).toBe(true) })\n", 'utf8');
    await writeFile(path.join(dir, 'F-1.json'), JSON.stringify({
      attacks: [{ id: 'A1', severity: 'high' }, ...BENIGN],
      coverage: [{ attackId: 'A1', status: 'covered', testFile: 'tests/a1.test.ts' }],
    }), 'utf8');
    const r = run(['redteam', '--wave', 'F-1'], root);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /通過/);
  });
});

test('redteam：攻擊清單 <3（含空/缺欄位）→ exit 2（鏡射 ATTACK_SCHEMA minItems，堵模型親手落檔繞過 schema）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    const dir = path.join(root, '.flow', 'redteam');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'F-1.json'), JSON.stringify({ attacks: [], coverage: [] }), 'utf8');
    const r0 = run(['redteam', '--wave', 'F-1'], root);
    assert.equal(r0.code, 2, '空清單不能 vacuous 過關');
    assert.match(r0.err, /少於 3/);
    await writeFile(path.join(dir, 'F-1.json'), JSON.stringify({ coverage: [] }), 'utf8');
    assert.equal(run(['redteam', '--wave', 'F-1'], root).code, 2, 'attacks 欄位缺失同擋');
  });
});

test('redteam：severity 缺失/非法值 → 比照 high 強制 covered（fail-safe 從嚴）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    const dir = path.join(root, '.flow', 'redteam');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'F-1.json'), JSON.stringify({
      attacks: [{ id: 'A1', severity: 'critical', scenario: '長字串造成 UI 破版' }, ...BENIGN],
      coverage: [],
    }), 'utf8');
    const r = run(['redteam', '--wave', 'F-1'], root);
    assert.equal(r.code, 2, '非法 severity 不能掉出 high 分支');
    assert.match(r.err, /非法值/);
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
      attacks: [{ id: 'A1', severity: 'high' }, ...BENIGN],
      coverage: [{ attackId: 'A1', status: 'covered', testFile: 'tests/empty.ts' }],
    }), 'utf8');
    assert.equal(run(['redteam', '--wave', 'F-1'], root).code, 2, '空殼不算 covered');
    await writeFile(path.join(root, 'tests', 'nokw.ts'), 'const x = 1; console.log(x); // 不含測試框架關鍵字 just code', 'utf8');
    await writeFile(path.join(dir, 'F-1.json'), JSON.stringify({
      attacks: [{ id: 'A1', severity: 'high' }, ...BENIGN],
      coverage: [{ attackId: 'A1', status: 'covered', testFile: 'tests/nokw.ts' }],
    }), 'utf8');
    assert.equal(run(['redteam', '--wave', 'F-1'], root).code, 2, '無測試關鍵字不算 covered');
  });
});

test('redteam：高危關鍵字攻擊（非 high）skipped 無豁免 → exit 2；記豁免檔放行且 by=user；無關文字不誤中（W0-6 floor）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    const dir = path.join(root, '.flow', 'redteam');
    await mkdir(dir, { recursive: true });
    // medium＋auth bypass 情境、被 skipped 且無豁免檔 → severity 自報調不鬆 floor
    await writeFile(path.join(dir, 'F-1.json'), JSON.stringify({
      attacks: [{ id: 'A1', severity: 'medium', scenario: 'auth bypass via token replay' }, ...BENIGN],
      coverage: [{ attackId: 'A1', status: 'skipped', reason: '時程' }],
    }), 'utf8');
    const r = run(['redteam', '--wave', 'F-1'], root);
    assert.equal(r.code, 2, '高危面禁無痕跳過');
    assert.match(r.err, /redteam-waiver-F-1-A1/);
    // 使用者拍板豁免留檔 → 放行（可稽核）；waiver 類 id 預設記 by:'user'（審計語意：使用者拍板、非 AI 自決）
    const d = run(['decision', 'redteam-waiver-F-1-A1', '--choice', 'skip', '--why', '此面向由既有 middleware 統一防護'], root);
    assert.match(d.out, /使用者拍板/);
    assert.equal((await S.readDecision(root, 'redteam-waiver-F-1-A1')).by, 'user');
    assert.equal(run(['redteam', '--wave', 'F-1'], root).code, 0, '豁免檔實存即放行');
    // 無關文字（無高危關鍵字）的 low 攻擊無 coverage → 照舊不擋
    await writeFile(path.join(dir, 'F-1.json'), JSON.stringify({
      attacks: [{ id: 'A2', severity: 'low', scenario: '清單空狀態顯示錯誤' }, ...BENIGN.map(a => ({ ...a, id: a.id + 'x' }))],
      coverage: [],
    }), 'utf8');
    assert.equal(run(['redteam', '--wave', 'F-1'], root).code, 0, '非高危面不強制');
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

test('complete-check：tasks.md 有未完成 [ ] → exit 2；全 [x] 但缺 requirements.md → 仍 exit 2（W0-7）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await mkdir(path.join(root, 'specs'), { recursive: true });
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [x] **F-1**\n- [ ] **F-2**\n', 'utf8');
    assert.equal(run(['complete-check'], root).code, 2, '還有未完成 → 不准 COMPLETE');
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [x] **F-1**\n- [x] **F-2**\n', 'utf8');
    const r = run(['complete-check'], root);
    assert.equal(r.code, 2, '缺 requirements.md ＝ REQ-E2E 謂詞無從對賬，不准 COMPLETE（原本只警告＝歸檔 spec 可靜默關閉整段對賬）');
    assert.match(r.err, /requirements\.md/);
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
// 第 1 波 lens 收斂 fixture：redteam/consistency 各 2 輪零發現（SHALL 在 requirements 定稿「之後」跑——docHash 綁定當下文字）
async function passLenses(root) {
  const fp = path.join(root, 'findings-empty.json');
  await writeFile(fp, JSON.stringify({ findings: [] }), 'utf8');
  for (const lens of ['redteam', 'consistency']) for (let i = 0; i < 2; i++) {
    const r = run(['spec-review', lens, '--file', fp], root);
    assert.equal(r.code, 0, r.err);
  }
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
    assert.equal(run(['project-type', 'api'], root).code, 0, 'W0-5：凍結前先落檔專案類型');
    await passLenses(root);
    const r = run(['spec-ready', '--freeze'], root);
    assert.equal(r.code, 0, r.err);
    const st = await S.readStateJson(root);
    assert.equal(st.phase, 'spec-done');
    assert.equal(st.mode, 'auto', 'read-modify-write 保留既有欄位');
    assert.ok((await S.readJournal(root)).some(e => e.ev === 'spec.frozen'), 'journal 留 spec.frozen 審計');
  });
});

test('spec-review：ledger 由 CLI 落檔——round 自動遞增、docHash 綁定現行 requirements（模型不可自填）；壞形狀 exit 1（W1）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);
    const fp = path.join(root, 'f.json');
    await writeFile(fp, JSON.stringify({ findings: [{ id: 'SR-RT-001', severity: 'high', claim: 'REQ-001 邊界未定義' }], docHash: '偽造的' }), 'utf8');
    assert.equal(run(['spec-review', 'redteam', '--file', fp], root).code, 0);
    const [led] = await S.listSpecReviewLedgers(root);
    assert.equal(led.round, 1);
    assert.equal(led.docHash, S.sha256Text(READY_REQ), 'docHash 由 CLI 自算、自填的被覆寫');
    await writeFile(fp, JSON.stringify({ findings: [] }), 'utf8');
    assert.equal(run(['spec-review', 'redteam', '--file', fp], root).code, 0);
    assert.equal((await S.listSpecReviewLedgers(root)).filter(l => l.lens === 'redteam').length, 2, 'round 自動遞增');
    await writeFile(fp, JSON.stringify({ findings: [{ id: '沒前綴', severity: 'huge', claim: '' }] }), 'utf8');
    assert.equal(run(['spec-review', 'redteam', '--file', fp], root).code, 1, '壞形狀擋收檔');
    assert.equal(run(['spec-review', '不存在的lens', '--file', fp], root).code, 1);
  });
});

test('spec-review：跨 lens id 撞號 → exit 1 拒收（W1 防一筆終局蒸發兩條質疑）；BOM 檔可收（PS5.1 utf8）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);
    const fp = path.join(root, 'f.json');
    await writeFile(fp, JSON.stringify({ findings: [{ id: 'SR-RT-001', severity: 'high', claim: 'REQ-001 缺併發' }] }), 'utf8');
    assert.equal(run(['spec-review', 'redteam', '--file', fp], root).code, 0);
    // consistency 想用同號（撞 redteam 的 SR-RT-001）——前綴驗證先擋（須 SR-CS-）
    await writeFile(fp, JSON.stringify({ findings: [{ id: 'SR-RT-001', severity: 'low', claim: '別的質疑' }] }), 'utf8');
    assert.equal(run(['spec-review', 'consistency', '--file', fp], root).code, 1, '前綴不符 lens 擋');
    // 正確前綴但跨輪重號（redteam r2 重用 SR-RT-001）——全域查重擋
    await writeFile(fp, JSON.stringify({ findings: [{ id: 'SR-RT-001', severity: 'low', claim: '重號' }] }), 'utf8');
    const clash = run(['spec-review', 'redteam', '--file', fp], root);
    assert.equal(clash.code, 1, '跨輪撞號擋');
    assert.match(clash.err, /撞號/);
    // BOM 檔（PS5.1 -Encoding utf8 產出）可正常收
    await writeFile(fp, '﻿' + JSON.stringify({ findings: [] }), 'utf8');
    assert.equal(run(['spec-review', 'redteam', '--file', fp], root).code, 0, 'BOM 不該炸解析');
  });
});

test('review-resolve/review-check：finding 終局附機器指標，未終局/指標失效 exit 2（W1 發現不能無痕蒸發）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);
    const fp = path.join(root, 'f.json');
    await writeFile(fp, JSON.stringify({ findings: [{ id: 'SR-CS-001', severity: 'medium', claim: 'REQ-001 與 story 對不上' }] }), 'utf8');
    run(['spec-review', 'consistency', '--file', fp], root);
    assert.equal(run(['review-check'], root).code, 2, '未終局擋');
    assert.equal(run(['review-resolve', 'SR-CS-999', '--as', 'open'], root).code, 1, '不存在的 finding 拒收');
    assert.equal(run(['review-resolve', 'SR-CS-001', '--as', 'resolved:REQ-999'], root).code, 2, '指向不存在的 REQ 擋');
    assert.equal(run(['review-resolve', 'SR-CS-001', '--as', 'rejected:D-1'], root).code, 2, 'decision 檔不存在擋');
    run(['decision', 'D-1', '--choice', '不採納', '--why', '超出本迭代範圍'], root);
    assert.equal(run(['review-resolve', 'SR-CS-001', '--as', 'rejected:D-1'], root).code, 0, '洩壓閥：留審計線即可關閉');
    assert.equal(run(['review-check'], root).code, 0, '全終局放行');
  });
});

test('spec-ready --freeze：lens 未跑 → exit 2；審完改文（docHash 漂移）→ exit 2 逼重跑末輪（W1 收斂判準機讀化）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);
    run(['project-type', 'api'], root);
    const r0 = run(['spec-ready', '--freeze'], root);
    assert.equal(r0.code, 2, '沒跑 lens 不准凍結——「多角度 review 過了」不再是散文自報');
    assert.match(r0.err, /lens/);
    await passLenses(root);
    // 審完偷改需求 → 末輪 docHash 對不上現行文字（插在開放問題段之前，別誤觸 open-item 閘門）
    await writeReq(root, READY_REQ.replace('REQ-001：當 X 時，系統應 Y。', 'REQ-001：當 X 時，系統應 Y。\nREQ-002：當 Y 時，系統應 Z。'));
    const r1 = run(['spec-ready', '--freeze'], root);
    assert.equal(r1.code, 2, '零新發現 attest 的是舊文，不算數');
    assert.match(r1.err, /docHash/);
    await passLenses(root);   // 對新文字重跑
    assert.equal(run(['spec-ready', '--freeze'], root).code, 0);
  });
});

test('spec-ready --freeze：末輪有 findings → 未收斂擋；終局＋補跑空末輪後放行（W1 完整迴圈）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);
    run(['project-type', 'api'], root);
    const fp = path.join(root, 'f.json');
    await writeFile(fp, JSON.stringify({ findings: [{ id: 'SR-RT-001', severity: 'high', claim: 'REQ-001 缺併發處置' }] }), 'utf8');
    run(['spec-review', 'redteam', '--file', fp], root);
    await passLenses(root);   // redteam 補到 r3？——passLenses 各跑 2 輪：redteam 變 r2,r3（r3 空）、consistency r1,r2
    const mid = run(['spec-ready', '--freeze'], root);
    assert.equal(mid.code, 2, 'SR-RT-001 未終局，review-check 擋');
    assert.match(mid.err, /SR-RT-001/);
    run(['decision', 'D-skip', '--choice', '不採納', '--why', '單人工具無併發面'], root);
    assert.equal(run(['review-resolve', 'SR-RT-001', '--as', 'rejected:D-skip'], root).code, 0);
    assert.equal(run(['spec-ready', '--freeze'], root).code, 0, '末輪空＋全終局＝機讀收斂');
  });
});

test('spec-ready --freeze：走原型路須有 ui-signoff 定版記錄，缺檔 exit 2（W1 堵「使用者沒點過就凍結」）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);
    run(['project-type', 'web-app'], root);
    await writeMockups(root, '<h2>REQ-E2E-001</h2><a href="login.html">走</a>', { 'login.html': PAGE_OK.replace('../app.js', 'app.js') });
    await writeFile(path.join(root, 'specs', 'ui-mockups', 'app.js'), 'const db = {};', 'utf8');
    await passLenses(root);
    const r = run(['spec-ready', '--freeze'], root);
    assert.equal(r.code, 2, '走查台綠了但沒有定版記錄，不准凍結');
    assert.match(r.err, /ui-signoff/);
    const d = run(['decision', 'ui-signoff', '--choice', '方向 OK', '--why', '使用者照走查台點完拍板'], root);
    assert.match(d.out, /使用者拍板/, 'signoff 類預設 by:user');
    assert.equal(run(['spec-ready', '--freeze'], root).code, 0, r.err);
  });
});

// ── 第 2 波：全鏈路對賬 CLI 端到端 ──

// 凍結一個乾淨 spec（含 lens 收斂＋projectType），回傳 root——W2 各 CLI 測試的共同前置
async function frozenRoot(root, reqMd = READY_REQ) {
  await S.init(root, { project: 'p', tasks: [] });
  await S.writeStateJson(root, { mode: 'manual' });
  await writeReq(root, reqMd);
  run(['project-type', 'api'], root);
  await passLenses(root);
  const r = run(['spec-ready', '--freeze'], root);
  assert.equal(r.code, 0, 'frozenRoot 凍結失敗：' + r.err);
}

test('spec-ready --freeze：落 .flow/trace/req-index.json（REQ 全集＋hash）；凍結後偷改 → 消費閘門 hash 對賬擋（W2-1）', async () => {
  await withRoot(async (root) => {
    await frozenRoot(root);
    const idx = await S.readReqIndex(root);
    assert.ok(idx, 'req-index 落檔');
    assert.ok(idx.reqIds.includes('REQ-001') && idx.reqIds.includes('REQ-E2E-001') && idx.reqIds.includes('REQ-PERF-001'), '全型號 REQ');
    assert.equal(idx.reqHash, S.sha256Text(READY_REQ));
    // 凍結後偷改 requirements.md → plan-check hash 對賬擋
    await writeReq(root, READY_REQ + '\nREQ-002：偷加的。');
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [ ] F-1（對應 REQ-001 REQ-E2E-001 REQ-PERF-001）\n', 'utf8');
    const pc = run(['plan-check'], root);
    assert.equal(pc.code, 2);
    assert.match(pc.err, /凍結快照不符/);
  });
});

test('plan-check：REQ 沒被 task 承接 / manifest 不同步 → exit 2；齊全 → 落 plan-check.json＋phase=plan-done（W2-2）', async () => {
  await withRoot(async (root) => {
    await frozenRoot(root);
    // tasks.md 缺 REQ-PERF-001 承接 → uncovered
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [ ] F-1 註冊（對應 REQ-001 REQ-E2E-001）\n      blockedBy: — | conflictZone: api/\n', 'utf8');
    const r0 = run(['plan-check'], root);
    assert.equal(r0.code, 2, 'REQ-PERF-001 沒被承接');
    assert.match(r0.err, /REQ-PERF-001/);
    // 補齊 REQ 承接，但 manifest 沒同步 F-1 → diff 擋
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [ ] F-1 全部（對應 REQ-001 REQ-E2E-001 REQ-PERF-001）\n      blockedBy: — | conflictZone: api/\n', 'utf8');
    const r1 = run(['plan-check'], root);
    assert.equal(r1.code, 2, 'manifest 沒有 F-1');
    assert.match(r1.err, /F-1/);
    // manifest 同步 → 過，落檔＋phase
    await S.writeManifest(root, { tasks: [{ id: 'F-1', blockedBy: [], conflictZone: ['api/'] }] });
    const r2 = run(['plan-check'], root);
    assert.equal(r2.code, 0, r2.err);
    assert.ok(await S.readPlanCheck(root), 'plan-check.json 落檔');
    assert.equal((await S.readStateJson(root)).phase, 'plan-done');
  });
});

test('run --task：runner 紅→exit 2 落 journal；done 據此擋「跑過但最後紅」；真跑綠後放行（W2-3）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [{ id: 'F-1' }] });
    await S.writeStateJson(root, { verify: 'ok:e2e', tdd: 'green' });
    // npm test 是白名單 runner（避開 node --test 在外層 test runner 內的 NODE_TEST_CONTEXT 衝突）；t.mjs 控制 exit
    await writeFile(path.join(root, 'package.json'), '{"scripts":{"test":"node t.mjs"}}', 'utf8');
    await writeFile(path.join(root, 't.mjs'), 'process.exit(1)', 'utf8');
    // 非 runner 命令（node --version）→ 拒（堵 no-op 洗綠）
    assert.equal(runTask('F-1', ['node', '--version'], root).code, 1, 'no-op 非 runner 拒');
    // runner 紅
    assert.equal(runTask('F-1', ['npm', 'test', '--silent'], root).code, 2, 'runner 紅→exit 2');
    // 有紅 attempt → done 擋（即使 verify/tdd 綠）
    const d = run(['done', 'F-1'], root);
    assert.equal(d.code, 2, '跑過但最後紅→擋 done');
    assert.match(d.err, /最後一次是紅/);
    // 同一 bucket 修綠（t.mjs 改成必過）→ done 放行
    await writeFile(path.join(root, 't.mjs'), 'process.exit(0)', 'utf8');
    assert.equal(runTask('F-1', ['npm', 'test', '--silent'], root).code, 0, '同 bucket 真跑綠');
    assert.equal(run(['done', 'F-1'], root).code, 0, '同 bucket 真跑綠後 done 放行');
  });
});

test('verify-e2e：n/a 須附實存 --decision（W2-3 堵批量 n/a 洗白）；記錄帶 reqHash', async () => {
  await withRoot(async (root) => {
    await frozenRoot(root);
    assert.equal(run(['verify-e2e', 'REQ-E2E-001', '--status', 'n/a', '--evidence', '無法自動化'], root).code, 1, 'n/a 缺 decision');
    assert.equal(run(['verify-e2e', 'REQ-E2E-001', '--status', 'n/a', '--evidence', 'x', '--decision', 'ghost'], root).code, 2, 'decision 不存在');
    run(['decision', 'e2e-na-1', '--choice', '純視覺無法自動化', '--why', 'x'], root);
    assert.equal(run(['verify-e2e', 'REQ-E2E-001', '--status', 'n/a', '--evidence', 'x', '--decision', 'e2e-na-1'], root).code, 0);
    const recs = await S.listVerifyRecords(root);
    assert.equal(recs[0].reqHash, S.sha256Text(READY_REQ), 'pass/na 記錄綁凍結版 hash');
  });
});

test('verify-perf：解析 budget、超標拒記、達標落 pass（W2-4）', async () => {
  await withRoot(async (root) => {
    await frozenRoot(root);
    assert.equal(run(['verify-perf', 'REQ-PERF-001', '--value', '5.0', '--evidence', 'x'], root).code, 2, '5s 超標 2.5s');
    assert.equal(run(['verify-perf', 'REQ-PERF-001', '--value', '2.0', '--evidence', 'lh.json'], root).code, 0, '2s 達標');
    assert.equal(run(['verify-perf', 'REQ-PERF-999', '--value', '1', '--evidence', 'x'], root).code, 2, 'requirements 查無此 PERF');
    assert.equal((await S.readPerfRecord(root, 'REQ-PERF-001')).status, 'pass');
  });
});

test('verify-perf/complete-check：非量測型 REQ-PERF（無 budget）走 perf-waiver、不死鎖（W2-4 死鎖修）', async () => {
  const REQ_NM = ['# 需求', 'REQ-001：當 X 時，系統應 Y。', 'REQ-E2E-001：登入 → 首頁 → 操作 → 斷言。',
    'REQ-PERF-001：系統應不阻塞主線程（設計約束）。', '### 開放問題', '無'].join('\n');
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeStateJson(root, { mode: 'manual' });
    await writeReq(root, REQ_NM);
    run(['project-type', 'api'], root);
    // 非量測型 → freeze 要 perf-waiver
    await passLenses(root);
    assert.equal(run(['spec-ready', '--freeze'], root).code, 2, '非量測型 freeze 前要 perf-waiver');
    run(['decision', 'perf-waiver', '--choice', 'REQ-PERF 非量測型', '--why', '設計約束'], root);
    assert.equal(run(['spec-ready', '--freeze'], root).code, 0, '有 waiver 後凍結');
    // verify-perf 對非量測型 → 指路 perf-waiver、不強記
    assert.equal(run(['verify-perf', 'REQ-PERF-001', '--value', '1', '--evidence', 'x'], root).code, 2, '非量測型不走 verify-perf');
    // complete-check：非量測型認 perf-waiver、不死鎖
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [x] **F-1**\n', 'utf8');
    run(['verify-e2e', 'REQ-E2E-001', '--status', 'pass', '--evidence', 'green'], root);
    run(['decision', 'code-review-waiver', '--choice', '本測不驗藍軍', '--why', 'x'], root);
    assert.equal(run(['complete-check'], root).code, 0, '非量測型有 waiver → complete-check 放行');
  });
});

test('review-code / code-resolve / complete-check：forcing function＋red flag 終局＋重跑防蒸發（C 修正）', async () => {
  await withRoot(async (root) => {
    await frozenRoot(root);
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [x] **F-1**\n', 'utf8');
    run(['verify-e2e', 'REQ-E2E-001', '--status', 'pass', '--evidence', 'green'], root);
    run(['verify-perf', 'REQ-PERF-001', '--value', '2.0', '--evidence', 'lh.json'], root);
    // C-fix#1 forcing function：沒跑 code-review 且無 waiver → 擋（不再放行）
    const noReview = run(['complete-check'], root);
    assert.equal(noReview.code, 2, '沒跑藍軍 code-review → 擋 ship');
    assert.match(noReview.err, /code-review/);
    // 落 code-review：1 red + 1 yellow
    const fp = path.join(root, 'cr.json');
    await writeFile(fp, JSON.stringify({ findings: [
      { id: 'CR-001', severity: 'red', file: 'src/x.ts:42', claim: 'SQLi 字串拼接' },
      { id: 'CR-002', severity: 'yellow', file: 'src/y.ts:1', claim: '神奇數字' },
    ] }), 'utf8');
    assert.equal(run(['review-code', '--file', fp], root).code, 0);
    const r = run(['complete-check'], root);
    assert.equal(r.code, 2, 'red flag 未終局擋 ship');
    assert.match(r.err, /CR-001/);
    assert.equal(run(['code-resolve', 'CR-999', '--as', 'fixed:x'], root).code, 1, '不存在的 CR');
    assert.equal(run(['code-resolve', 'CR-001', '--as', 'fixed:'], root).code, 2, 'fixed 缺證據');
    assert.equal(run(['code-resolve', 'CR-001', '--as', 'waiver:ghost'], root).code, 2, 'decision 不存在');
    assert.equal(run(['code-resolve', 'CR-001', '--as', 'fixed:src/x.ts:42 改 parameterized'], root).code, 0);
    assert.equal(run(['complete-check'], root).code, 0, 'red 全終局後放行（yellow 不管）');
  });
});

test('review-code 重跑：同號但內容全新的 red 不繼承舊終局；未終局舊 red 不因覆寫蒸發（C 修 B+C 洞）', async () => {
  await withRoot(async (root) => {
    await frozenRoot(root);
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [x] **F-1**\n', 'utf8');
    run(['verify-e2e', 'REQ-E2E-001', '--status', 'pass', '--evidence', 'green'], root);
    run(['verify-perf', 'REQ-PERF-001', '--value', '2.0', '--evidence', 'lh.json'], root);
    const fp = path.join(root, 'cr.json');
    // Review1：CR-001 SQLi（終局）＋CR-002 auth bypass（未終局）
    await writeFile(fp, JSON.stringify({ findings: [
      { id: 'CR-001', severity: 'red', file: 'src/a.ts:1', claim: 'SQLi' },
      { id: 'CR-002', severity: 'red', file: 'src/b.ts:2', claim: 'auth bypass 未修' },
    ] }), 'utf8');
    run(['review-code', '--file', fp], root);
    run(['code-resolve', 'CR-001', '--as', 'fixed:src/a.ts parameterized'], root);
    // Review2：獨立 reviewer 重跑，只回一條「同號 CR-001 但內容全新（XSS）」
    await writeFile(fp, JSON.stringify({ findings: [{ id: 'CR-001', severity: 'red', file: 'src/c.ts:3', claim: 'XSS 全新未審' }] }), 'utf8');
    const re = run(['review-code', '--file', fp], root);
    assert.match(re.out, /保留 1 條/, 'CR-002 未終局 → 覆寫時保留');
    const r = run(['complete-check'], root);
    assert.equal(r.code, 2, '新 XSS 不繼承舊 CR-001 的 fixed、且 CR-002 未蒸發 → 擋');
    // 兩條都終局才放行
    run(['code-resolve', 'CR-001', '--as', 'fixed:src/c.ts XSS escape'], root);   // 新 CR-001（XSS）
    run(['decision', 'cr-002-wv', '--choice', '不修', '--why', '既有 middleware 已擋'], root);
    run(['code-resolve', 'CR-002', '--as', 'waiver:cr-002-wv'], root);            // 保留的舊 CR-002
    assert.equal(run(['complete-check'], root).code, 0, '兩條都終局後放行');
  });
});

test('plan-check：官方 tasks-template 範例原樣 → 過（W2-2 不擋 golden path）', async () => {
  const REQ_T = ['# 需求', 'REQ-001：當 X 時，系統應 Y。',
    'REQ-E2E-001：登入 → 首頁 → 操作 → 斷言。', 'REQ-E2E-002：登入 → 商品 → 下單 → 斷言。', 'REQ-E2E-003：登入 → 搜尋 → 斷言。',
    'REQ-PERF-001：LCP < 2.5s（p95）。', 'REQ-PERF-002：GET /api p95 < 300ms。', '### 開放問題', '無'].join('\n');
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeStateJson(root, { mode: 'manual' });
    await writeReq(root, REQ_T);
    run(['project-type', 'api'], root);
    await passLenses(root);
    assert.equal(run(['spec-ready', '--freeze'], root).code, 0);
    // 照 tasks-template 格式（含 X-1 用 REQ-PERF-* glob、對應 REQ-E2E 在 checkbox 行）
    await writeFile(path.join(root, 'specs', 'tasks.md'), [
      '- [ ] F-1 註冊登入（對應 REQ-E2E-001）',
      '      blockedBy: — | conflictZone: features/auth',
      '- [ ] F-2 下單（對應 REQ-E2E-002、REQ-PERF-002）',
      '      blockedBy: F-1 | conflictZone: features/order',
      '- [ ] F-3 搜尋（對應 REQ-E2E-003）',
      '      blockedBy: — | conflictZone: features/search',
      '- [ ] X-1 效能整體驗收（REQ-PERF-*）',
    ].join('\n'), 'utf8');
    await S.writeManifest(root, { tasks: [
      { id: 'F-1', blockedBy: [], conflictZone: ['features/auth'] },
      { id: 'F-2', blockedBy: ['F-1'], conflictZone: ['features/order'] },
      { id: 'F-3', blockedBy: [], conflictZone: ['features/search'] },
      { id: 'X-1', blockedBy: [], conflictZone: [] },
    ] });
    const r = run(['plan-check'], root);
    assert.equal(r.code, 0, '官方範本格式應過 plan-check：' + r.err);
  });
});

test('project-type：非法值 → exit 1；合法值寫進 manifest+state.json（W0-5 正門）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    assert.equal(run(['project-type', 'webapp'], root).code, 1, 'enum 白名單外拒收');
    const r = run(['project-type', 'web-app'], root);
    assert.equal(r.code, 0, r.err);
    assert.equal((await S.readManifest(root)).projectType, 'web-app', '寫 git-tracked manifest');
    assert.equal((await S.readStateJson(root)).projectType, 'web-app', '寫 state.json 相容 bridge');
  });
});

test('spec-ready --freeze：缺 projectType → exit 2；web 類無原型無豁免 → exit 2；記 mockup-waiver → 凍結（W0-5）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);
    await passLenses(root);
    const r0 = run(['spec-ready', '--freeze'], root);
    assert.equal(r0.code, 2, '沒落檔專案類型不准凍結');
    assert.match(r0.err, /project-type/);
    run(['project-type', 'web-app'], root);
    const r1 = run(['spec-ready', '--freeze'], root);
    assert.equal(r1.code, 2, 'web 類「不建 ui-mockups 目錄＝靜默豁免」已封死');
    assert.match(r1.err, /mockup-waiver/);
    run(['decision', 'mockup-waiver', '--choice', '跳過互動原型', '--why', '使用者明說跳過'], root);
    const r2 = run(['spec-ready', '--freeze'], root);
    assert.equal(r2.code, 0, r2.err);
    assert.equal((await S.readStateJson(root)).phase, 'spec-done', '豁免留檔後才准凍結');
  });
});

test('spec-ready --freeze：manifest 直寫非 enum 值（webapp）→ exit 2（消費端也驗 enum，堵「自創值＝歸類非 web 免原型」）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);
    const manifest = await S.readManifest(root);
    await S.writeManifest(root, { ...manifest, projectType: 'webapp' });   // 繞過 CLI 正門手寫
    const r = run(['spec-ready', '--freeze'], root);
    assert.equal(r.code, 2, '白名單外的值不能靜默歸類為非 web');
    assert.match(r.err, /不在合法清單/);
  });
});

test('complete-check：requirements.md 實存但 0 條 REQ-E2E（被收束成殼）→ exit 2（W0-7 補強）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await mkdir(path.join(root, 'specs'), { recursive: true });
    await writeFile(path.join(root, 'specs', 'tasks.md'), '- [x] **F-1**\n', 'utf8');
    await writeReq(root, '# 需求（已收束）\n完整版見 archive/requirements-v1.md\n');
    const r = run(['complete-check'], root);
    assert.equal(r.code, 2, '0/0 vacuous 全綠＝完成謂詞被歸檔關閉，硬擋');
    assert.match(r.err, /查無任何 REQ-E2E/);
  });
});

test('spec-ready：REQ-PERF 標 N/A 無 perf-waiver → exit 2；使用者拍板留檔後放行（W0-3 堵 N/A 洗白）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ.replace('REQ-PERF-001：dashboard LCP < 2.5s（p95）。', 'REQ-PERF-001：N/A'));
    const r = run(['spec-ready'], root);
    assert.equal(r.code, 2, 'N/A 一句話不能洗掉效能驗收');
    assert.match(r.err, /perf-waiver/);
    run(['decision', 'perf-waiver', '--choice', 'REQ-PERF N/A', '--why', '內部工具無效能敏感路徑'], root);
    assert.equal(run(['spec-ready'], root).code, 0, '豁免檔實存即放行');
  });
});

test('spec-ready：requirements 缺「### 開放問題」段 → exit 2（W0-1 堵恆過洞）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ.replace('\n### 開放問題\n無', ''));
    const r = run(['spec-ready'], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /開放問題/);
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

// 過得了 W0-8 空殼頁機檢的最小合法頁（引 app.js＋含互動元素）
const PAGE_OK = '<html><script src="../app.js"></script><button>操作</button></html>';

test('mockup-check：走查台連結 404 → exit 2；補「非空殼」檔即綠', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);
    await writeMockups(root, '<h2>REQ-E2E-001</h2><a href="pages/login.html">走</a>');
    const r = run(['mockup-check'], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /404/);
    await mkdir(path.join(root, 'specs', 'ui-mockups', 'pages'), { recursive: true });
    await writeFile(path.join(root, 'specs', 'ui-mockups', 'pages', 'login.html'), PAGE_OK, 'utf8');
    // 頁面引用 ../app.js → 檔案也要實存（引用缺檔的 script 會被 W0-8 擋）
    await writeFile(path.join(root, 'specs', 'ui-mockups', 'app.js'), 'const db = JSON.parse(localStorage.getItem("db") || "{}");', 'utf8');
    const r2 = run(['mockup-check'], root);
    assert.equal(r2.code, 0, r2.err);
    assert.match(r2.out, /通過/);
  });
});

test('mockup-check：走查台零本地入口連結 → exit 2（只列 id 文字＝journey 沒得點，整鏈空轉）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);
    await writeMockups(root, '<h2>REQ-E2E-001 卡</h2><p>步驟描述…（沒有任何 <b>連結</b>）</p>');
    const r = run(['mockup-check'], root);
    assert.equal(r.code, 2, '零 href＝404/空殼檢查整鏈空轉，硬擋');
    assert.match(r.err, /零本地入口連結/);
  });
});

test('mockup-check：頁面引用的 script 不存在 → exit 2（掛了 <script src> 但檔案缺＝CRUD 無後果）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);
    await writeMockups(root, '<h2>REQ-E2E-001</h2><a href="login.html">走</a>',
      { 'login.html': '<html><script src="app.js"></script><button>登入</button></html>' });   // app.js 沒產
    const r = run(['mockup-check'], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /script 不存在/);
  });
});

test('mockup-check：連到的頁面是空殼（無 app.js/互動元素）→ exit 2 點名（W0-8）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);
    await writeMockups(root, '<h2>REQ-E2E-001</h2><a href="login.html">走</a>', { 'login.html': '<html><h1>Login</h1></html>' });
    const r = run(['mockup-check'], root);
    assert.equal(r.code, 2, '有卡但頁面空殼＝假原型');
    assert.match(r.err, /app\.js/);
    assert.match(r.err, /互動元素/);
  });
});

test('spec-ready --freeze：ui-mockups 存在但走查台缺卡 → exit 2 不凍結；非 web 型別無目錄 → 照常凍結', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    // 002 插在開放問題段之前（append 檔尾會落進該段變成 open item，測錯閘門）
    await writeReq(root, READY_REQ.replace('### 開放問題', 'REQ-E2E-002：登入 → 商品頁 → 下單 → 斷言訂單成立。\n### 開放問題'));
    run(['project-type', 'web-app'], root);
    await writeMockups(root, '<h2>REQ-E2E-001</h2>');   // 缺 002 的走查卡
    const r = run(['spec-ready', '--freeze'], root);
    assert.equal(r.code, 2);
    assert.match(r.err, /REQ-E2E-002/);
    assert.notEqual((await S.readStateJson(root)).phase, 'spec-done', '走查台不完整不准凍結');
  });
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await writeReq(root, READY_REQ);
    run(['project-type', 'api'], root);
    await passLenses(root);
    const r = run(['spec-ready', '--freeze'], root);   // 非 web：enum 記錄本身即豁免，無 ui-mockups/ 照常凍結
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
    // 記了 REQ-E2E pass 但 REQ-PERF 未達標 → 仍 exit 2（W2-4）
    run(['verify-e2e', 'REQ-E2E-001', '--status', 'pass', '--evidence', 'green'], root);
    assert.equal(run(['complete-check'], root).code, 2, 'REQ-PERF 未達標仍擋');
    // 補 REQ-PERF 達標 → 放行（本測不驗藍軍，補 code-review-waiver）
    run(['verify-perf', 'REQ-PERF-001', '--value', '2.0', '--evidence', 'lighthouse.json'], root);
    run(['decision', 'code-review-waiver', '--choice', '本測不驗藍軍', '--why', 'x'], root);
    assert.equal(run(['complete-check'], root).code, 0, '補齊 REQ-E2E＋REQ-PERF 後放行');
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
