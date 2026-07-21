// flow-uninstall.test.mjs — settings.json 反向合併黑箱測試。
// 釘住 H3 修正：只摘 Flow hook「註冊」、不連坐整條 entry——使用者併進同 entry 的 hook 必須活下來。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UNINSTALL = fileURLToPath(new URL('./flow-uninstall.mjs', import.meta.url));

async function withTmp(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flowunin-'));
  try {
    const settingsPath = path.join(root, 'settings.json');
    const mdPath = path.join(root, 'CLAUDE.md');
    const run = () => spawnSync(process.execPath, [UNINSTALL, settingsPath, mdPath], { encoding: 'utf8' });
    await fn({ root, settingsPath, mdPath, run });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('純 Flow entry 移除、事件掏空清掉；使用者 entry 保留', async () => {
  await withTmp(async (t) => {
    await writeFile(t.settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node "h/flow-dispatch.mjs"' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      },
      otherSetting: true,
    }), 'utf8');
    const r = t.run();
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(await readFile(t.settingsPath, 'utf8'));
    assert.equal(s.hooks.PreToolUse, undefined, 'Flow-only 事件整段清掉');
    assert.equal(s.hooks.Stop[0].hooks[0].command, 'say done', '使用者 entry 保留');
    assert.equal(s.otherSetting, true, '非 hooks 設定不動');
  });
});

test('H3：使用者 hook 與 Flow hook 同 entry → 只摘 Flow 註冊、不連坐', async () => {
  await withTmp(async (t) => {
    await writeFile(t.settingsPath, JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: 'Write', hooks: [
          { type: 'command', command: 'node my-formatter.mjs' },
          { type: 'command', command: 'node "h/flow-size-check.mjs"' },
        ] }],
      },
    }), 'utf8');
    const r = t.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /removed 1 Flow hook/);
    const s = JSON.parse(await readFile(t.settingsPath, 'utf8'));
    assert.deepEqual(s.hooks.PostToolUse[0].hooks.map((h) => h.command), ['node my-formatter.mjs']);
  });
});

test('壞 JSON → exit 3 原樣不動；無 settings/CLAUDE.md → no-op exit 0', async () => {
  await withTmp(async (t) => {
    await writeFile(t.settingsPath, '{nope', 'utf8');
    assert.equal(t.run().status, 3);
    assert.equal(await readFile(t.settingsPath, 'utf8'), '{nope');
  });
  await withTmp(async (t) => {
    assert.equal(t.run().status, 0, '兩檔皆不存在 → 冪等 no-op');
  });
});
