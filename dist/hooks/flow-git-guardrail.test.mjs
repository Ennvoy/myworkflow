// flow-git-guardrail.test.mjs — git 危險指令 guardrail 黑箱測試（spawn node hook、餵 stdin JSON）。
// 驗：開/切分支＋破壞性操作一律攔、正常唯讀/低風險用法放行、FLOW_GIT_OK 逃生口、
//     非 Flow 目錄（無 .flow）一樣攔——證明本 hook 刻意沒有 .flow 早退（跟其餘三道閘門的關鍵差異）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, 'flow-git-guardrail.mjs');

function runHook(cmd, cwd, toolName = 'Bash') {
  const input = { tool_name: toolName, tool_input: { command: cmd }, cwd };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr || '' };
}

async function withTmpDir(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitguard-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('攔：開/切分支類', async () => {
  await withTmpDir(async (root) => {
    assert.equal(runHook('git checkout -b feature', root).code, 2, 'checkout -b');
    assert.equal(runHook('git checkout -B feature', root).code, 2, 'checkout -B');
    assert.equal(runHook('git switch -c feature', root).code, 2, 'switch -c');
    assert.equal(runHook('git switch main', root).code, 2, '裸 switch 切到既有分支');
    assert.equal(runHook('git branch new-feature', root).code, 2, 'branch <新名> 建分支');
  });
});

test('攔：破壞性操作類', async () => {
  await withTmpDir(async (root) => {
    assert.equal(runHook('git push --force', root).code, 2, 'push --force');
    assert.equal(runHook('git push -f origin main', root).code, 2, 'push -f');
    assert.equal(runHook('git push --force-with-lease', root).code, 2, 'push --force-with-lease');
    assert.equal(runHook('git reset --hard HEAD~1', root).code, 2, 'reset --hard');
    assert.equal(runHook('git clean -fd', root).code, 2, 'clean -fd');
    assert.equal(runHook('git branch -D old-feature', root).code, 2, 'branch -D');
    assert.equal(runHook('git checkout .', root).code, 2, 'checkout .（裸 checkout 一律攔已涵蓋）');
    assert.equal(runHook('git checkout -- .', root).code, 2, 'checkout -- .');
    assert.equal(runHook('git restore foo.txt', root).code, 2, 'restore 不含 --staged 視為覆寫工作區的破壞性操作');
  });
});

test('放行：正常/低風險操作不誤攔', async () => {
  await withTmpDir(async (root) => {
    assert.equal(runHook('git branch --list', root).code, 0, 'branch --list 純列表');
    assert.equal(runHook('git branch -v', root).code, 0, 'branch -v 純列表');
    assert.equal(runHook('git branch', root).code, 0, '裸 branch 純列表');
    assert.equal(runHook('git restore --staged foo.txt', root).code, 0, 'restore --staged 只是 unstage');
    assert.equal(runHook('git status', root).code, 0, 'status');
    assert.equal(runHook('git add . && git commit -m "checkout old approach" && git push', root).code, 0,
      '普通 commit+push（訊息內文含 "checkout" 字眼不誤判成子命令）');
    assert.equal(runHook('npm test', root).code, 0, '非 git 命令');
  });
});

test('FLOW_GIT_OK 逃生口：帶了就放行，即使命令本身是危險操作', async () => {
  await withTmpDir(async (root) => {
    assert.equal(runHook('FLOW_GIT_OK=1 git checkout -b feature', root).code, 0, 'bash 形式');
    assert.equal(runHook("$env:FLOW_GIT_OK='1'; git push --force", root, 'PowerShell').code, 0, 'PowerShell 形式');
  });
});

test('GUARD-01：global option 前綴穿透（-c k=v／--no-pager／引號含空白的 -C 路徑）', async () => {
  await withTmpDir(async (root) => {
    assert.equal(runHook('git -c core.hooksPath=/dev/null checkout -b x', root).code, 2, '-c k=v 前綴不得繞過');
    assert.equal(runHook('git --no-pager push --force', root).code, 2, '--no-pager 前綴不得繞過');
    assert.equal(runHook('git -C "/my repo" checkout -b x', root).code, 2, '引號含空白的 -C 路徑不得繞過');
    assert.equal(runHook('git -c color.ui=false status', root).code, 0, '前綴 + 唯讀命令仍放行');
  });
});

test('GUARD-02：push +refspec 強推（等同 --force）', async () => {
  await withTmpDir(async (root) => {
    assert.equal(runHook('git push origin +main', root).code, 2, '+main');
    assert.equal(runHook('git push origin +HEAD:refs/heads/main', root).code, 2, '+src:dst');
    assert.equal(runHook('git push origin main', root).code, 0, '正常 push 放行');
  });
});

test('GUARD-06：branch -f/--force 強制移動/刪除 ref', async () => {
  await withTmpDir(async (root) => {
    assert.equal(runHook('git branch -f main HEAD~3', root).code, 2, 'branch -f 強制移動');
    assert.equal(runHook('git branch --delete --force x', root).code, 2, '--delete --force 冗長形強刪');
  });
});

test('GUARD-05：逃生口只認賦值形式——命令內偶發 FLOW_GIT_OK 字樣不停用護欄', async () => {
  await withTmpDir(async (root) => {
    assert.equal(runHook('git checkout -b x # FLOW_GIT_OK', root).code, 2, '非賦值形式不放行');
  });
});

test('非 Flow 目錄（無 .flow）也照攔——本 hook 刻意沒有 .flow 存在性早退', async () => {
  await withTmpDir(async (root) => {
    // withTmpDir 給的 root 本身就沒有 .flow，直接驗證仍攔得住。
    const r = runHook('git checkout -b feature', root);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /git guardrail/);
  });
});

test('git -C <path> 前綴：子命令判斷仍要穿透前綴抓到', async () => {
  await withTmpDir(async (root) => {
    assert.equal(runHook(`git -C ${root} checkout -b feature`, root).code, 2, '-C 前綴 + checkout -b');
    assert.equal(runHook(`git -C ${root} status`, root).code, 0, '-C 前綴 + 唯讀命令放行');
  });
});

test('&&/; 串接中段出現的 git 子命令也要抓到', async () => {
  await withTmpDir(async (root) => {
    assert.equal(runHook('cd repo && git switch -c feature', root).code, 2, '&& 串接中段的 switch -c');
    assert.equal(runHook('git status; git reset --hard', root).code, 2, '; 串接中段的 reset --hard');
  });
});

test('block 訊息內含逃生口指引（FLOW_GIT_OK）', async () => {
  await withTmpDir(async (root) => {
    const r = runHook('git branch -D old-feature', root);
    assert.match(r.stderr, /FLOW_GIT_OK/);
    assert.match(r.stderr, /AskUserQuestion/);
  });
});

test('壞輸入 / 非 Bash|PowerShell 工具 → fail-open exit 0', async () => {
  const bad = spawnSync(process.execPath, [HOOK], { input: '{not json', encoding: 'utf8' });
  assert.equal(bad.status, 0);
  const other = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'x', content: 'git checkout -b y' } }),
    encoding: 'utf8',
  });
  assert.equal(other.status, 0);
});
