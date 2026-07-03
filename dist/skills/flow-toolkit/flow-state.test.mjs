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
