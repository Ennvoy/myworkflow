// clean-verify-artifacts.test.mjs — 驗證垃圾清理白名單行為（node --test）
// 重點：① .playwright-mcp 等 MCP 產物目錄整刪（破案核心）② KEEP 交付物絕不誤刪
//   ③ Tier B 危險類別僅 git untracked 才清（誤刪安全閥）④ commit-gate 判斷只認 Tier A＋產物目錄。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  scan, isHardArtifact, isSoftArtifact, isArtifactDir,
  underArtifactDir, isCommitBlockableArtifact,
} from './clean-verify-artifacts.mjs';

async function withRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cleantest-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const bases = list => new Set(list.map(x => path.basename(x.path)));

// ── 純判斷函數 ──
test('isHardArtifact：絕對垃圾命中、source 與 baseline 不中', () => {
  for (const b of ['x.log', 'console-2026.log', 'a.trace.zip', 'debug-1.png', 'tmp-x.yml', 'scratch-tmp.txt', 'y.tmp', 'm.pyc'])
    assert.equal(isHardArtifact(b), true, b);
  // 歧義前綴（tmp-/temp-/scratch-/debug-）+ source/設定副檔名＝正常檔非垃圾（finding #7：堵誤刪 src/temp-storage.ts）
  for (const b of ['app.ts', 'README.md', 'api.baseline.log', 'data.golden.json', 'foo.spec.ts', 'scratchpad.mjs',
                   'temp-storage.ts', 'scratch-pad.tsx', 'debug-config.json', 'temp-utils.py'])
    assert.equal(isHardArtifact(b), false, b);
});

test('isSoftArtifact：一次性截圖/錄影命中、設計稿與 snapshot 不中', () => {
  for (const b of ['screenshot-1.png', 'snap.jpg', 'capture-9.webp', 'page-2026.png', 'rec.webm'])
    assert.equal(isSoftArtifact(b), true, b);
  for (const b of ['logo.png', 'hero.jpg', 'app.ts', 'ui.snapshot.png'])
    assert.equal(isSoftArtifact(b), false, b);
});

test('isArtifactDir / underArtifactDir：MCP 目錄被認得', () => {
  for (const d of ['.playwright-mcp', 'playwright-mcp-output', 'test-results', '__pycache__'])
    assert.equal(isArtifactDir(d), true, d);
  assert.equal(isArtifactDir('src'), false);
  assert.equal(underArtifactDir('.playwright-mcp/page-x.yml'), true);
  assert.equal(underArtifactDir(path.join('.playwright-mcp', 'console-x.log')), true);
  assert.equal(underArtifactDir('src/app.ts'), false);
});

test('isCommitBlockableArtifact：只認 Tier A＋產物目錄，不誤擋資產/Tier B', () => {
  for (const p of ['.playwright-mcp/page-1.yml', 'foo.log', 'test-results/x.png', 'sub/dir/a.trace.zip'])
    assert.equal(isCommitBlockableArtifact(p), true, p);
  // 散落截圖屬 Tier B → commit-gate 不擋（避免誤擋故意 commit 的資產）；source/baseline/spec 一律放行
  for (const p of ['src/app.ts', 'tests/e2e/x.spec.ts', 'api.baseline.log', 'docs/logo.png', 'screenshot-1.png'])
    assert.equal(isCommitBlockableArtifact(p), false, p);
});

// ── scan 整合 ──
test('scan：.playwright-mcp 整個目錄整刪（含 page-*.yml / console-*.log）', async () => {
  await withRoot(async (root) => {
    await mkdir(path.join(root, '.playwright-mcp'), { recursive: true });
    await writeFile(path.join(root, '.playwright-mcp', 'page-2026.yml'), 'snapshot');
    await writeFile(path.join(root, '.playwright-mcp', 'console-2026.log'), 'logs');
    const { dirs, files } = scan(root, new Set());
    assert.ok([...bases(dirs)].includes('.playwright-mcp'), '.playwright-mcp 應整目錄列入待刪');
    assert.equal([...bases(files)].includes('page-2026.yml'), false, '整目錄刪 → 不逐一重複列裡面的檔');
  });
});

test('scan：Tier A 無條件清、KEEP 交付物不刪', async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, 'verify.log'), '');
    await writeFile(path.join(root, 'api.baseline.log'), '');     // KEEP（baseline）
    await mkdir(path.join(root, 'tests'), { recursive: true });
    await writeFile(path.join(root, 'tests', 'e2e.spec.ts'), ''); // KEEP（spec）
    await writeFile(path.join(root, 'app.ts'), '');               // source
    const { files } = scan(root, new Set());
    const b = bases(files);
    assert.ok(b.has('verify.log'), 'verify.log 應清');
    assert.equal(b.has('api.baseline.log'), false, 'baseline 不刪');
    assert.equal(b.has('e2e.spec.ts'), false, 'spec 不刪');
    assert.equal(b.has('app.ts'), false, 'source 不刪');
  });
});

test('scan：Tier B 僅 untracked 才清（誤刪安全閥）', async () => {
  await withRoot(async (root) => {
    const shotU = path.join(root, 'screenshot-1.png'); // untracked → 清
    const shotT = path.join(root, 'screenshot-2.png'); // 模擬 tracked → 不清
    const asset = path.join(root, 'logo.png');         // 非 Tier B 命名 → 不清
    await writeFile(shotU, '');
    await writeFile(shotT, '');
    await writeFile(asset, '');
    const untracked = new Set([path.resolve(shotU), path.resolve(asset)]); // shotT 不在 → 視為 tracked
    const { files } = scan(root, untracked);
    const b = bases(files);
    assert.ok(b.has('screenshot-1.png'), 'untracked 截圖應清');
    assert.equal(b.has('screenshot-2.png'), false, 'tracked 截圖不清（安全閥）');
    assert.equal(b.has('logo.png'), false, '非截圖命名的資產不清');
  });
});

test('scan：untracked=null（非 git）→ Tier B 全略過、Tier A 仍清', async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, 'x.log'), '');            // Tier A
    await writeFile(path.join(root, 'screenshot-1.png'), ''); // Tier B
    const { files } = scan(root, null);
    const b = bases(files);
    assert.ok(b.has('x.log'), 'Tier A 仍清');
    assert.equal(b.has('screenshot-1.png'), false, '非 git 時 Tier B 保守略過');
  });
});
