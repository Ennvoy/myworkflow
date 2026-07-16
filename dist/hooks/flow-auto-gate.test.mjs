// flow-auto-gate.test.mjs — 自駕硬閘門 hook（node --test）
// 驗：mode:auto 時 裝新相依/破壞性 DB/硬 stall → exit 2；bare install/有 WHERE/manual/非 Flow → 放行(fail-open)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../skills/flow-toolkit/statelib.mjs';

const HOOK = fileURLToPath(new URL('./flow-auto-gate.mjs', import.meta.url));
const run = input => spawnSync('node', [HOOK], { input: JSON.stringify(input), encoding: 'utf8' }).status;
async function withAuto(fn, mode = 'auto') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'autogate-'));
  await S.init(root, { project: 'p', tasks: [] });
  await S.writeStateJson(root, { mode, phase: 'building' });
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const bash = (root, command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: root });

test('mode:auto — 裝新相依 → exit 2；bare install / ci → 放行', async () => {
  await withAuto(async (root) => {
    assert.equal(run(bash(root, 'npm install react')), 2, 'npm install <pkg>');
    assert.equal(run(bash(root, 'npm i -D vitest')), 2, 'npm i -D <pkg>');
    assert.equal(run(bash(root, 'yarn add lodash')), 2, 'yarn add');
    assert.equal(run(bash(root, 'pip install flask')), 2, 'pip install <pkg>');
    assert.equal(run(bash(root, 'cargo add serde')), 2, 'cargo add');
    assert.equal(run(bash(root, 'npm install')), 0, 'bare install 還原 lockfile 放行');
    assert.equal(run(bash(root, 'npm ci')), 0, 'npm ci 放行');
    assert.equal(run(bash(root, 'pnpm install --frozen-lockfile')), 0, 'frozen install 放行');
  });
});

test('mode:auto — 破壞性 DB → exit 2；有 WHERE / SELECT → 放行', async () => {
  await withAuto(async (root) => {
    assert.equal(run(bash(root, 'psql -c "DROP TABLE users"')), 2, 'DROP TABLE');
    assert.equal(run(bash(root, 'mysql -e "TRUNCATE orders"')), 2, 'TRUNCATE');
    assert.equal(run(bash(root, 'psql -c "DELETE FROM users"')), 2, '無 WHERE 的 DELETE');
    assert.equal(run(bash(root, 'psql -c "UPDATE users SET active=0"')), 2, '無 WHERE 的 UPDATE');
    assert.equal(run(bash(root, 'psql -c "DELETE FROM users WHERE id=1"')), 0, '有 WHERE 放行');
    assert.equal(run(bash(root, 'psql -c "SELECT * FROM users"')), 0, 'SELECT 放行');
  });
});

test('mode:auto — 軟 STALL 連續被忽略到 hardThreshold → 下次同 runner 硬擋 exit 2', async () => {
  await withAuto(async (root) => {
    const cmd = 'pytest tests/test_x.py';
    const bucket = S.runnerBucket(cmd);
    for (let i = 0; i < 6; i++) await S.recordVerifyAttempt(root, bucket, 'SAMESIG', 1);   // soft3+3=6
    assert.equal(run(bash(root, cmd)), 2, '連 6 輪同失敗 → 硬擋');
    // 不同 runner 不受影響
    assert.equal(run(bash(root, 'pytest tests/test_y.py')), 0, '別條 runner 放行');
  });
});

test('mode:auto — W4-2 .flow/policy.json 預核准放行：無 policy → 仍硬擋；allowlist 命中放行且留審計 decision', async () => {
  await withAuto(async (root) => {
    const policyPath = path.join(root, '.flow', 'policy.json');
    assert.equal(run(bash(root, 'npm install lodash')), 2, '無 .flow/policy.json → 維持硬擋');
    await writeFile(policyPath, JSON.stringify({ deps: { allow: ['lodash'] } }), 'utf8');
    assert.equal(run(bash(root, 'npm install lodash')), 0, 'allowlist 命中 → 放行');
    const decisions = await readdir(path.join(root, '.flow', 'decisions'));
    assert.ok(decisions.some(f => /^dep-auto-.*\.json$/.test(f)), '放行留審計 decision（dep-auto-*.json）');
  });
});

test('mode:auto — W4-2 allowlist 尾 * 前綴＋去版本後綴；命令內全部套件都命中才放行', async () => {
  await withAuto(async (root) => {
    const policyPath = path.join(root, '.flow', 'policy.json');
    await writeFile(policyPath, JSON.stringify({ deps: { allow: ['@types/*'] } }), 'utf8');
    assert.equal(run(bash(root, 'pnpm add @types/node@20')), 0, '尾 * 前綴＋去版本後綴命中 → 放行');
    assert.equal(run(bash(root, 'pnpm add left-pad')), 2, '不在清單 → 仍擋');
    await writeFile(policyPath, JSON.stringify({ deps: { allow: ['lodash'] } }), 'utf8');
    assert.equal(run(bash(root, 'npm install lodash left-pad')), 2, 'left-pad 不在清單 → 全部命中才放行，整體仍擋');
  });
});

test('mode:auto — W4-2 policy.json 壞 JSON → 讀不到＝無白名單，仍硬擋', async () => {
  await withAuto(async (root) => {
    await writeFile(path.join(root, '.flow', 'policy.json'), '{bad json', 'utf8');
    assert.equal(run(bash(root, 'npm install lodash')), 2, '壞 JSON 讀不到 policy → 視同無白名單');
  });
});

test('mode:manual — 一律放行（不干擾非自駕）', async () => {
  await withAuto(async (root) => {
    assert.equal(run(bash(root, 'npm install react')), 0);
    assert.equal(run(bash(root, 'psql -c "DROP TABLE users"')), 0);
  }, 'manual');
});

test('非 Flow / 壞 JSON / 非 Bash 工具 → fail-open exit 0', async () => {
  await withAuto(async (root) => {
    assert.equal(run({ tool_name: 'Write', tool_input: {}, cwd: root }), 0, '非 Bash 放行');
  });
  // 無 .flow
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'noflow-'));
  assert.equal(run(bash(tmp, 'npm install react')), 0, '非 Flow 放行');
  await rm(tmp, { recursive: true, force: true });
  assert.equal(spawnSync('node', [HOOK], { input: '{bad', encoding: 'utf8' }).status, 0, '壞 JSON 放行');
});

// ── C-5：自駕下編輯相依 manifest → exit 2；非 manifest 編輯 / manual → 放行 ──
test('C-5：mode:auto 編輯 package.json/requirements.txt → exit 2；非 manifest 編輯放行', async () => {
  await withAuto(async (root) => {
    const edit = (fp) => ({ tool_name: 'Edit', tool_input: { file_path: path.join(root, fp) }, cwd: root });
    const write = (fp) => ({ tool_name: 'Write', tool_input: { file_path: path.join(root, fp) }, cwd: root });
    assert.equal(run(edit('package.json')), 2, '編輯 package.json＝改相依');
    assert.equal(run(write('requirements.txt')), 2, '寫 requirements.txt');
    assert.equal(run(edit('pnpm-lock.yaml')), 2, 'lockfile');
    assert.equal(run(edit('src/app.ts')), 0, '一般原始碼編輯放行');
    assert.equal(run(write('README.md')), 0, '文件放行');
  });
});

test('C-5：mode:manual 編輯 package.json → 放行（不干擾非自駕）', async () => {
  await withAuto(async (root) => {
    assert.equal(run({ tool_name: 'Edit', tool_input: { file_path: path.join(root, 'package.json') }, cwd: root }), 0);
  }, 'manual');
});

// ── C-45：detect/extract 單一表；pip restore 不誤攔；chained 命令 fail-safe ──
test('C-45：pip install -r（還原）放行；cargo/npm 裝新相依擋；chained && 命令 allowlist 仍 fail-safe 硬擋', async () => {
  await withAuto(async (root) => {
    assert.equal(run(bash(root, 'pip install -r requirements.txt')), 0, 'pip -r 還原＝非新相依，放行');
    assert.equal(run(bash(root, 'pip install flask')), 2, 'pip 裝具名套件＝新相依');
    // policy 放行 lodash，但 chained 命令 → extract 抓到 && 後的 token → allowlist miss → 硬擋（fail-safe，不放 evil 跟著跑）
    await writeFile(path.join(root, '.flow', 'policy.json'), JSON.stringify({ deps: { allow: ['lodash'] } }), 'utf8');
    assert.equal(run(bash(root, 'npm install lodash')), 0, '單一 allowed 套件放行');
    assert.equal(run(bash(root, 'npm install lodash && npm install evil')), 2, 'chained 命令不因 lodash 命中就放行整串');
  });
});
