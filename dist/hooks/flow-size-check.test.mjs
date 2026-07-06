// flow-size-check.test.mjs — SDD 檔案膨脹偵測 hook（node --test）
// 驗判據：specs/*.md 任一 >50KB 注入收束提醒；未超標/非 Flow 專案靜默。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('./flow-size-check.mjs', import.meta.url));
const runHook = input => (spawnSync('node', [HOOK], { input: JSON.stringify(input), encoding: 'utf8' }).stdout || '');

async function withProject(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sizetest-'));
  await mkdir(path.join(root, '.flow'), { recursive: true });
  await mkdir(path.join(root, 'specs'), { recursive: true });
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('specs 檔 >50KB → 注入膨脹提醒', async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, 'specs', 'requirements.md'), 'x'.repeat(60 * 1024), 'utf8');
    const out = runHook({ hook_event_name: 'SessionStart', cwd: root });
    assert.match(out, /SDD 檔案膨脹/);
    assert.match(out, /flow-compact/);
  });
});

test('specs 檔 <50KB → 不注入', async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, 'specs', 'requirements.md'), 'x'.repeat(10 * 1024), 'utf8');
    const out = runHook({ hook_event_name: 'SessionStart', cwd: root });
    assert.equal(out.trim(), '');
  });
});

test('UserPromptSubmit 節流：同大小不重提', async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, 'specs', 'requirements.md'), 'x'.repeat(60 * 1024), 'utf8');
    const first = runHook({ hook_event_name: 'UserPromptSubmit', cwd: root });
    assert.match(first, /SDD 檔案膨脹/, '首次報出');
    const second = runHook({ hook_event_name: 'UserPromptSubmit', cwd: root });
    assert.equal(second.trim(), '', '同大小（未再長 >8KB）→ 節流不重提');
  });
});

test('W4-1 PostToolUse：file_path 為 specs/requirements.md 且 >50KB → 注入膨脹提醒', async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, 'specs', 'requirements.md'), 'x'.repeat(60 * 1024), 'utf8');
    const out = runHook({ hook_event_name: 'PostToolUse', cwd: root, tool_input: { file_path: 'specs/requirements.md' } });
    assert.match(out, /SDD 檔案膨脹/);
  });
});

test('W4-1 PostToolUse：file_path 為 src/app.ts（非 specs .md）→ 快速返回、不掃描', async () => {
  await withProject(async (root) => {
    // 即便 specs 目錄真有膨脹檔，非 specs/.sdd 的 .md 路徑要提早返回，不觸發任何掃描
    await writeFile(path.join(root, 'specs', 'requirements.md'), 'x'.repeat(60 * 1024), 'utf8');
    const out = runHook({ hook_event_name: 'PostToolUse', cwd: root, tool_input: { file_path: 'src/app.ts' } });
    assert.equal(out.trim(), '');
  });
});

test('非 Flow 專案 → 靜默', () => {
  const out = runHook({ hook_event_name: 'SessionStart', cwd: os.tmpdir() + '/definitely-not-a-flow-proj-xyz' });
  assert.equal(out.trim(), '');
});
