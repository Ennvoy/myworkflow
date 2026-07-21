// merge-settings.test.mjs — settings.json 合併器黑箱測試（spawn node、實檔進出）。
// 釘住四個行為：新裝全加、重跑冪等、範本演進可「刪」（H3 stale prune，event 綁定比對）、使用者自有 hook 一概不動。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MERGE = fileURLToPath(new URL('./merge-settings.mjs', import.meta.url));

const FRAG = {
  hooks: {
    PreToolUse: [
      { matcher: 'Write|Edit|Bash|PowerShell', hooks: [{ type: 'command', command: 'node "{{CLAUDE_HOME}}/hooks/flow-dispatch.mjs"' }] },
    ],
    SessionStart: [
      { hooks: [{ type: 'command', command: 'node "{{CLAUDE_HOME}}/hooks/flow-size-check.mjs"' }] },
    ],
  },
};

async function withTmp(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mergeset-'));
  try {
    const home = path.join(root, 'claude-home').replace(/\\/g, '/');
    const fragPath = path.join(root, 'settings.flow.json');
    const settingsPath = path.join(root, 'settings.json');
    await writeFile(fragPath, JSON.stringify(FRAG), 'utf8');
    const run = () => spawnSync(process.execPath, [MERGE, settingsPath, fragPath, home], { encoding: 'utf8' });
    const readSettings = async () => JSON.parse(await readFile(settingsPath, 'utf8'));
    const cmd = (name) => `node "${home}/hooks/${name}"`;
    await fn({ root, home, settingsPath, fragPath, run, readSettings, cmd });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('新裝：settings.json 不存在 → fragment 全數加入', async () => {
  await withTmp(async (t) => {
    const r = t.run();
    assert.equal(r.status, 0, r.stderr);
    const s = await t.readSettings();
    assert.equal(s.hooks.PreToolUse[0].hooks[0].command, t.cmd('flow-dispatch.mjs'));
    assert.equal(s.hooks.SessionStart[0].hooks[0].command, t.cmd('flow-size-check.mjs'));
  });
});

test('冪等：重跑不重複加、內容不變', async () => {
  await withTmp(async (t) => {
    t.run();
    const first = await t.readSettings();
    const r2 = t.run();
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /\+0 added/);
    assert.deepEqual(await t.readSettings(), first);
  });
});

test('H3 prune：舊版殘留（fragment 已無的 flow 註冊）被剪掉，event 綁定比對', async () => {
  await withTmp(async (t) => {
    // 模擬舊版安裝後遺：獨立 design-base-hint 註冊＋size-check 掛在 UserPromptSubmit（fragment 都沒有）
    await writeFile(t.settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Write', hooks: [{ type: 'command', command: t.cmd('flow-design-base-hint.mjs') }] },
        ],
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: t.cmd('flow-size-check.mjs') }] },
        ],
        SessionStart: [
          { hooks: [{ type: 'command', command: t.cmd('flow-size-check.mjs') }] },
        ],
      },
    }), 'utf8');
    const r = t.run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 stale pruned/);
    const s = await t.readSettings();
    assert.equal(s.hooks.UserPromptSubmit, undefined, 'UserPromptSubmit 掛點整段剪掉');
    const preCmds = s.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    assert.ok(!preCmds.includes(t.cmd('flow-design-base-hint.mjs')), '獨立 design-hint 註冊剪掉');
    assert.ok(preCmds.includes(t.cmd('flow-dispatch.mjs')), 'fragment 現行註冊加入');
    // size-check 在 SessionStart 仍在名單 → 保留（同 command 不同 event，只剪除名單外那筆）
    assert.equal(s.hooks.SessionStart.flatMap((e) => e.hooks).filter((h) => h.command === t.cmd('flow-size-check.mjs')).length, 1);
  });
});

test('使用者自有 hook 不動：獨立 entry 保留；與 stale flow hook 同 entry 不連坐', async () => {
  await withTmp(async (t) => {
    await writeFile(t.settingsPath, JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: 'Write', hooks: [
            { type: 'command', command: 'node my-own-formatter.mjs' },
            { type: 'command', command: t.cmd('flow-old-gone.mjs') },
          ] },
        ],
        Stop: [
          { hooks: [{ type: 'command', command: 'say done' }] },
        ],
      },
    }), 'utf8');
    const r = t.run();
    assert.equal(r.status, 0, r.stderr);
    const s = await t.readSettings();
    const post = s.hooks.PostToolUse[0].hooks.map((h) => h.command);
    assert.deepEqual(post, ['node my-own-formatter.mjs'], 'stale flow hook 剪掉、同 entry 使用者 hook 留下');
    assert.equal(s.hooks.Stop[0].hooks[0].command, 'say done', '使用者自有 entry 原樣保留');
  });
});

test('settings.json 壞 JSON → exit 3、檔案原樣不動', async () => {
  await withTmp(async (t) => {
    await writeFile(t.settingsPath, '{broken', 'utf8');
    const r = t.run();
    assert.equal(r.status, 3);
    assert.equal(await readFile(t.settingsPath, 'utf8'), '{broken');
  });
});
