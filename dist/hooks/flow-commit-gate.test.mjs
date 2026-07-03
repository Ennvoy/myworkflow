// flow-commit-gate.test.mjs — commit 閘門黑箱測試（spawn node hook、餵 stdin JSON、斷言 exit code/stderr）。
// 釘住三道閘門的 fail 方向：secrets（閘門〇）/ 驗證垃圾（閘門一，含 --amend）/ 先標再 commit（閘門二，
// 含 PowerShell here-string 解析——曾被多行 commit message 靜默繞過的回歸案例）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, 'flow-commit-gate.mjs');

function runHook(input) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr || '' };
}
async function withFlowRepo(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowgate-'));
  try {
    execFileSync('git', ['-C', root, 'init', '-q']);
    await mkdir(path.join(root, '.flow', 'ledger'), { recursive: true });
    await writeFile(path.join(root, '.flow', 'manifest.json'),
      JSON.stringify({ tasks: [{ id: 'F-9-W0-1' }] }), 'utf8');
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const bash = (cmd, cwd) => ({ tool_name: 'Bash', tool_input: { command: cmd }, cwd });
const pwsh = (cmd, cwd) => ({ tool_name: 'PowerShell', tool_input: { command: cmd }, cwd });

test('非 git commit 指令 → 放行', async () => {
  await withFlowRepo(async (root) => {
    assert.equal(runHook(bash('git status', root)).code, 0);
    assert.equal(runHook(bash('ls -la', root)).code, 0);
  });
});

test('非 Flow 專案（無 .flow）→ 放行（fail-open）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowgate-'));
  try {
    assert.equal(runHook(bash('git commit -m "feat: x"', root)).code, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('非 Bash/PowerShell 工具 → 放行', async () => {
  await withFlowRepo(async (root) => {
    assert.equal(runHook({ tool_name: 'Write', tool_input: {}, cwd: root }).code, 0);
  });
});

test('閘門二：Bash 點名未 delivered task → exit 2（先標、再 commit）', async () => {
  await withFlowRepo(async (root) => {
    const r = runHook(bash('git commit -m "feat(F-9-W0-1): add thing"', root));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /F-9-W0-1/);
    assert.match(r.stderr, /flow-state/);
  });
});

test('閘門二：PowerShell here-string 點名未 delivered task → exit 2（多行訊息繞過的回歸）', async () => {
  await withFlowRepo(async (root) => {
    const cmd = "git commit -m @'\nfeat(F-9-W0-1): add thing\n\nbody line\n'@";
    const r = runHook(pwsh(cmd, root));
    assert.equal(r.code, 2, 'here-string 內點名的 task id 必須被解析到');
    assert.match(r.stderr, /F-9-W0-1/);
  });
});

test('閘門二：點名已 delivered task → 放行', async () => {
  await withFlowRepo(async (root) => {
    await writeFile(path.join(root, '.flow', 'ledger', 'F-9-W0-1.json'),
      JSON.stringify({ id: 'F-9-W0-1', state: 'delivered' }), 'utf8');
    assert.equal(runHook(bash('git commit -m "feat(F-9-W0-1): add thing"', root)).code, 0);
    assert.equal(runHook(pwsh("git commit -m @'\nfeat(F-9-W0-1): x\n'@", root)).code, 0);
  });
});

test('閘門二：訊息沒點名任何 task → 放行（docs/chore commit 不誤擋）', async () => {
  await withFlowRepo(async (root) => {
    assert.equal(runHook(bash('git commit -m "chore: tidy README"', root)).code, 0);
  });
});

test('閘門〇：staged 含 .env → exit 2（secrets 不進歷史），--amend 也一樣', async () => {
  await withFlowRepo(async (root) => {
    await writeFile(path.join(root, '.env'), 'API_KEY=sk-real-secret\n', 'utf8');
    execFileSync('git', ['-C', root, 'add', '.env']);
    const r = runHook(bash('git commit -m "chore: config"', root));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /secrets/);
    assert.match(r.stderr, /\.env/);
    // --amend 是被擋後最自然的逃生門 → 閘門〇仍適用
    assert.equal(runHook(bash('git commit --amend -m "chore: config"', root)).code, 2);
  });
});

test('閘門〇：.env.example / 公鑰樣板 → 放行', async () => {
  await withFlowRepo(async (root) => {
    await writeFile(path.join(root, '.env.example'), 'API_KEY=fill-me\n', 'utf8');
    await writeFile(path.join(root, 'id_rsa.pub'), 'ssh-rsa AAAA fake\n', 'utf8');
    execFileSync('git', ['-C', root, 'add', '.env.example', 'id_rsa.pub']);
    assert.equal(runHook(bash('git commit -m "chore: add env template"', root)).code, 0);
  });
});

test('閘門〇：*.key 私鑰 / service-account JSON → exit 2（最常誤 commit 的私鑰型態）', async () => {
  await withFlowRepo(async (root) => {
    await writeFile(path.join(root, 'server.key'), '-----BEGIN PRIVATE KEY-----\nx\n', 'utf8');
    execFileSync('git', ['-C', root, 'add', 'server.key']);
    assert.equal(runHook(bash('git commit -m "chore: x"', root)).code, 2, '*.key 要擋');
    execFileSync('git', ['-C', root, 'rm', '--cached', '-q', 'server.key']);
    await writeFile(path.join(root, 'service-account.json'), '{"private_key":"x"}', 'utf8');
    execFileSync('git', ['-C', root, 'add', 'service-account.json']);
    assert.equal(runHook(bash('git commit -m "chore: x"', root)).code, 2, 'service account 金鑰要擋');
  });
});

test('閘門〇：.npmrc 看內容——純 registry 放行、含 _authToken 擋', async () => {
  await withFlowRepo(async (root) => {
    await writeFile(path.join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\n', 'utf8');
    execFileSync('git', ['-C', root, 'add', '.npmrc']);
    assert.equal(runHook(bash('git commit -m "chore: registry"', root)).code, 0, '純設定不誤擋');
    await writeFile(path.join(root, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_secret\n', 'utf8');
    execFileSync('git', ['-C', root, 'add', '.npmrc']);
    assert.equal(runHook(bash('git commit -m "chore: registry"', root)).code, 2, '含 token 要擋');
  });
});

test('閘門一：staged 含驗證垃圾（.playwright-mcp）→ exit 2，--amend 也一樣（amend 逃生門回歸）', async () => {
  await withFlowRepo(async (root) => {
    await mkdir(path.join(root, '.playwright-mcp'), { recursive: true });
    await writeFile(path.join(root, '.playwright-mcp', 'console-1.log'), 'noise\n', 'utf8');
    execFileSync('git', ['-C', root, 'add', '-f', '.playwright-mcp/console-1.log']);
    const r = runHook(bash('git commit -m "feat: thing"', root));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /驗證垃圾/);
    // 被擋後 git commit --amend 折進上一個 commit 是最自然的 workaround → 閘門一仍適用
    assert.equal(runHook(bash('git commit --amend -m "feat: thing"', root)).code, 2);
  });
});

test('--amend：純 --no-edit（無新訊息）放行；帶新 -m 點名未交付 task 照擋閘門二', async () => {
  await withFlowRepo(async (root) => {
    assert.equal(runHook(bash('git commit --amend --no-edit', root)).code, 0, '無新訊息 → 解析為空自然放行');
    const r = runHook(bash('git commit --amend -m "feat(F-9-W0-1): x"', root));
    assert.equal(r.code, 2, '帶新 -m 把未交付 task 折進上一個 commit 同樣違反「先標、再 commit」');
  });
});

test('壞輸入（非 JSON / 空）→ 放行不炸', () => {
  const r1 = spawnSync(process.execPath, [HOOK], { input: 'not json at all', encoding: 'utf8' });
  assert.equal(r1.status, 0);
  const r2 = spawnSync(process.execPath, [HOOK], { input: '', encoding: 'utf8' });
  assert.equal(r2.status, 0);
});

// ── W3-3：模型端補堵繞過 pre-commit 兜底的兩條旗標 ──
test('W3-3：git commit --no-verify → exit 2（模型不准關掉 pre-commit 兜底）', async () => {
  await withFlowRepo(async (root) => {
    const r = runHook(bash('git commit --no-verify -m "feat: x"', root));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no-verify|pre-commit/);
  });
});

test('W3-3：git -c core.hooksPath=/dev/null commit → exit 2', async () => {
  await withFlowRepo(async (root) => {
    const r = runHook(bash('git -c core.hooksPath=/dev/null commit -m "feat: x"', root));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /core\.hooksPath|pre-commit/);
  });
});

test('W3-3：commit message 內文含「--no-verify」字串 → 不誤擋（挖掉引號後才測旗標）', async () => {
  await withFlowRepo(async (root) => {
    const r = runHook(bash('git commit -m "docs: 說明 --no-verify 這個旗標"', root));
    assert.equal(r.code, 0, '引號內的 --no-verify 是 message 內容、非旗標，不該擋');
  });
});

// ── 第 3 波對抗驗證修復回歸（旗標繞過 / secrets / 交叉引用）──
test('#1：git commit "--no-verify"（引號包旗標）→ exit 2（去引號字元後仍測得到）', async () => {
  await withFlowRepo(async (root) => {
    assert.equal(runHook(bash('git commit "--no-verify" -m "wip"', root)).code, 2);
  });
});

test('#1：git -c "core.hooksPath=/dev/null" commit → exit 2', async () => {
  await withFlowRepo(async (root) => {
    assert.equal(runHook(bash('git -c "core.hooksPath=/dev/null" commit -m "wip"', root)).code, 2);
  });
});

test('#2：git commit -n（--no-verify 短式）→ exit 2', async () => {
  await withFlowRepo(async (root) => {
    assert.equal(runHook(bash('git commit -n -m "wip"', root)).code, 2);
  });
});

test('#3：git -c core.hookspath=x commit（config key 全小寫）→ exit 2', async () => {
  await withFlowRepo(async (root) => {
    assert.equal(runHook(bash('git -c core.hookspath=/dev/null commit -m "wip"', root)).code, 2);
  });
});

test('#3：git config core.hooksPath x; git commit（config 子命令持久改向）→ exit 2', async () => {
  await withFlowRepo(async (root) => {
    assert.equal(runHook(bash('git config core.hooksPath /dev/null; git commit -m "wip"', root)).code, 2);
  });
});

test('#12：commit message 含轉義引號＋--no-verify 文字 → 不誤擋（挖 -m 值吞轉義）', async () => {
  await withFlowRepo(async (root) => {
    assert.equal(runHook(bash('git commit -m "fix escaped \\" --no-verify handling "', root)).code, 0);
  });
});

test('#4：staged production.env（無前導點 dotenv 變體）→ exit 2', async () => {
  await withFlowRepo(async (root) => {
    await writeFile(path.join(root, 'production.env'), 'DB_PASS=secret123\n', 'utf8');
    execFileSync('git', ['-C', root, 'add', '-f', 'production.env']);
    assert.equal(runHook(bash('git commit -m "cfg"', root)).code, 2);
  });
});

test('#6：.npmrc 用 ${NPM_TOKEN}（env 引用、安全寫法）→ 不誤擋', async () => {
  await withFlowRepo(async (root) => {
    await writeFile(path.join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n', 'utf8');
    execFileSync('git', ['-C', root, 'add', '-f', '.npmrc']);
    assert.equal(runHook(bash('git commit -m "cfg"', root)).code, 0);
  });
});

test('#8：F-1 已交付、訊息交叉引用未交付 F-2（unblocks）→ 不誤擋；直接點名 F-2 → 擋', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowgate8-'));
  try {
    execFileSync('git', ['-C', root, 'init', '-q']);
    await mkdir(path.join(root, '.flow', 'ledger'), { recursive: true });
    await writeFile(path.join(root, '.flow', 'manifest.json'), JSON.stringify({ tasks: [{ id: 'F-1' }, { id: 'F-2' }] }), 'utf8');
    await writeFile(path.join(root, '.flow', 'ledger', 'F-1.json'), JSON.stringify({ id: 'F-1', state: 'delivered' }), 'utf8');
    assert.equal(runHook(bash('git commit -m "F-1 done (unblocks F-2)"', root)).code, 0, '交叉引用不誤擋');
    assert.equal(runHook(bash('git commit -m "F-2 wip"', root)).code, 2, '直接點名未交付仍擋');
  } finally { await rm(root, { recursive: true, force: true }); }
});
