// precommit-install.test.mjs — W3-3 git 原生 pre-commit 兜底的安裝紀律 + 執行體測試（node --test）。
// 釘住：① 全新裝含條件式守衛（卸載後不 brick commit）；② 冪等；③ append 不 clobber 既有 hook；
//       ④ core.hooksPath 改向（husky）→ 醒目 skip 不硬裝；⑤ 非 git → skip；⑥ flow-precommit 真擋 secrets、非 flow 放行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPrecommit } from './precommit-install.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PRECOMMIT = path.join(here, 'flow-precommit.mjs');

async function withRepo(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowpc-'));
  try { execFileSync('git', ['init', '-q'], { cwd: root }); await fn(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('installPrecommit：全新 repo → 裝 pre-commit、含 marker＋卸載守衛', async () => {
  await withRepo(async (root) => {
    const r = installPrecommit(root);
    assert.equal(r.installed, true);
    const hook = await readFile(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8');
    assert.match(hook, /flow-gate/, '有 marker 區塊');
    assert.match(hook, /\[ -f .* \] && command -v node .*then node/, '含檔案存在＋node 存在守衛（卸載/node 缺席自動 no-op，不 brick commit）');
    assert.match(hook, /flow-precommit\.mjs/);
  });
});

test('installPrecommit：冪等——再裝一次 alreadyInstalled、內容 byte 不變', async () => {
  await withRepo(async (root) => {
    installPrecommit(root);
    const before = await readFile(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8');
    const r2 = installPrecommit(root);
    assert.equal(r2.alreadyInstalled, true);
    assert.equal(await readFile(path.join(root, '.git', 'hooks', 'pre-commit'), 'utf8'), before);
  });
});

test('installPrecommit：既有 pre-commit → append marker、不 clobber 既有內容', async () => {
  await withRepo(async (root) => {
    const target = path.join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(target, '#!/bin/sh\necho "my existing hook"\n', 'utf8');
    const r = installPrecommit(root);
    assert.equal(r.installed, true);
    const hook = await readFile(target, 'utf8');
    assert.match(hook, /my existing hook/, '既有內容保留');
    assert.match(hook, /flow-gate/, 'marker append 在後');
  });
});

test('installPrecommit：core.hooksPath 改向（husky/lefthook）→ skip、警告不硬裝', async () => {
  await withRepo(async (root) => {
    execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: root });
    const r = installPrecommit(root);
    assert.equal(r.skipped, 'custom-hookspath');
    assert.match(r.warn, /husky|lefthook|core\.hooksPath/);
    const stdHook = path.join(root, '.git', 'hooks', 'pre-commit');
    const body = existsSync(stdHook) ? await readFile(stdHook, 'utf8') : '';
    assert.ok(!/flow-gate/.test(body), '沒偷偷裝進不會執行的標準 .git/hooks');
  });
});

test('installPrecommit：非 git repo → skip not-git', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flownogit-'));
  try { assert.equal(installPrecommit(root).skipped, 'not-git'); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('flow-precommit：flow 專案 staged 含 .env → exit 1 擋 commit', async () => {
  await withRepo(async (root) => {
    await mkdir(path.join(root, '.flow'), { recursive: true });
    await writeFile(path.join(root, '.env'), 'SECRET=xxx\n', 'utf8');
    execFileSync('git', ['add', '-f', '.env'], { cwd: root });
    const r = spawnSync(process.execPath, [PRECOMMIT], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 1, '.env 進 staging 被擋');
    assert.match(r.stderr, /secrets|\.env/);
  });
});

test('flow-precommit：非 flow 專案（無 .flow）→ exit 0 放行（不亂管無關 repo）', async () => {
  await withRepo(async (root) => {
    await writeFile(path.join(root, '.env'), 'SECRET=xxx\n', 'utf8');
    execFileSync('git', ['add', '-f', '.env'], { cwd: root });
    const r = spawnSync(process.execPath, [PRECOMMIT], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, '無 .flow → 不管');
  });
});

test('flow-precommit：flow 專案但 staged 乾淨 → exit 0 放行', async () => {
  await withRepo(async (root) => {
    await mkdir(path.join(root, '.flow'), { recursive: true });
    await writeFile(path.join(root, 'src.js'), 'export const x = 1;\n', 'utf8');
    execFileSync('git', ['add', 'src.js'], { cwd: root });
    const r = spawnSync(process.execPath, [PRECOMMIT], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, '正常檔不擋');
  });
});

// ── 第 3 波對抗驗證修復回歸 ──
test('#9：既有 python shebang pre-commit → skip foreign-interpreter（不 append 免 brick）', async () => {
  await withRepo(async (root) => {
    const target = path.join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(target, '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n', 'utf8');
    const r = installPrecommit(root);
    assert.equal(r.skipped, 'foreign-interpreter');
    assert.match(r.warn, /python|非 sh/);
    assert.ok(!/flow-gate/.test(await readFile(target, 'utf8')), '沒 append sh 區塊（避免 python 直譯器語法錯 brick）');
  });
});

test('#13：flow-precommit 在 core 模組缺失（半卸載）時 exit 0 放行（fail-open，不 brick）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flowpcfo-'));
  try {
    await mkdir(path.join(dir, '.flow'), { recursive: true });
    // 複製 flow-precommit.mjs 但不複製 commit-gate-core.mjs → 動態 import 失敗 → catch → exit 0
    await writeFile(path.join(dir, 'flow-precommit.mjs'), await readFile(PRECOMMIT, 'utf8'), 'utf8');
    const r = spawnSync(process.execPath, [path.join(dir, 'flow-precommit.mjs')], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, 'core 缺失落 catch → 放行');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
