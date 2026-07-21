// flow-spec-gate.test.mjs — 需求凍結閘門「窗戶感應器」hook（node --test）
// 驗：raw 寫 phase=spec-done 進 .flow/state.json → exit 2；正門子命令/其他檔/已凍結/非 Flow/壞 JSON → 放行(fail-open)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../skills/flow-toolkit/statelib.mjs';

const HOOK = fileURLToPath(new URL('./flow-spec-gate.mjs', import.meta.url));
const run = input => spawnSync('node', [HOOK], { input: JSON.stringify(input), encoding: 'utf8' }).status;

async function withFlow(fn, state = { mode: 'auto', phase: 'spec' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'specgate-'));
  await S.init(root, { project: 'p', tasks: [] });
  await S.writeStateJson(root, state);
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const write = (root, file_path, content) => ({ tool_name: 'Write', tool_input: { file_path, content }, cwd: root });
const edit = (root, file_path, new_string) => ({ tool_name: 'Edit', tool_input: { file_path, new_string }, cwd: root });
const bash = (root, command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: root });
const SPEC_DONE = JSON.stringify({ mode: 'auto', phase: 'spec-done' });

test('Write raw 寫 phase=spec-done 進 state.json → exit 2（擋後門裸寫）', async () => {
  await withFlow(async (root) => {
    assert.equal(run(write(root, path.join(root, '.flow', 'state.json'), SPEC_DONE)), 2);
  });
});

test('Edit 把 new_string 改成 spec-done → exit 2', async () => {
  await withFlow(async (root) => {
    assert.equal(run(edit(root, path.join(root, '.flow', 'state.json'), '"phase": "spec-done"')), 2);
  });
});

test('Bash 用 Set-Content/echo 寫 spec-done 進 state.json → exit 2', async () => {
  await withFlow(async (root) => {
    assert.equal(run(bash(root, `echo '{"phase":"spec-done"}' > .flow/state.json`)), 2);
  });
});

test('正門：flow-state spec-ready --freeze（命令不含 state.json 路徑/spec-done 字樣）→ 放行', async () => {
  await withFlow(async (root) => {
    assert.equal(run(bash(root, 'node ~/.claude/skills/flow-toolkit/flow-state.mjs spec-ready --freeze')), 0);
  });
});

test('寫別的 phase（非受守/其他檔）→ 放行', async () => {
  await withFlow(async (root) => {
    assert.equal(run(write(root, path.join(root, '.flow', 'state.json'), JSON.stringify({ phase: 'build-done' }))), 0, '非受守 phase 不擋');
    assert.equal(run(write(root, path.join(root, 'specs', 'requirements.md'), '...spec-done...')), 0, '別的檔不擋');
  });
});

test('裸寫 phase=plan-done → exit 2；plan-check 正門/已是 plan-done 再存 → 放行（W2-2）', async () => {
  await withFlow(async (root) => {
    assert.equal(run(write(root, path.join(root, '.flow', 'state.json'), JSON.stringify({ phase: 'plan-done' }))), 2, '裸寫 plan-done 擋');
    assert.equal(run(bash(root, 'node ~/.claude/skills/flow-toolkit/flow-state.mjs plan-check')), 0, 'plan-check 正門放行');
  });
  await withFlow(async (root) => {
    assert.equal(run(write(root, path.join(root, '.flow', 'state.json'), JSON.stringify({ phase: 'plan-done' }))), 0, '已是 plan-done 再存放行');
  }, { phase: 'plan-done' });
});

test('current phase 已是 spec-done → 再存放行（只擋轉移那一刻）', async () => {
  await withFlow(async (root) => {
    assert.equal(run(write(root, path.join(root, '.flow', 'state.json'), JSON.stringify({ phase: 'spec-done', mode: 'auto' }))), 0);
  }, { mode: 'auto', phase: 'spec-done' });
});

test('spec-review ledger 閘門：Write/Edit 裸寫擋、Bash 寫入/刪除擋、唯讀/staging/CLI 放行（W1 分讀寫）', async () => {
  await withFlow(async (root) => {
    // Write/Edit 工具本質是寫 → 命中路徑即擋
    assert.equal(run(write(root, path.join(root, '.flow', 'spec-review', 'redteam-r1.json'), '{"findings":[]}')), 2, 'Write 裸寫擋');
    assert.equal(run(edit(root, path.join(root, '.flow', 'spec-review', 'resolutions.json'), '{}')), 2, 'Edit 裸寫 resolutions 擋');
    // Bash 有寫入/刪除意圖 → 擋
    assert.equal(run(bash(root, `echo '{"findings":[]}' > .flow/spec-review/redteam-r2.json`)), 2, '重導寫擋');
    assert.equal(run(bash(root, 'rm -rf .flow/spec-review')), 2, '整目錄刪擋（無尾斜線也認）');
    assert.equal(run(bash(root, 'mv .flow/spec-review/redteam-r1.json specs/archive/')), 2, '搬走 ledger 擋');
    assert.equal(run(bash(root, 'printf "{}" > .flow/spec-review/x.json && node flow-state.mjs spec-review redteam --file f.json')), 2, 'ride-along 重導不再搭便車');
    // 唯讀/staging/CLI 正門 → 放行（裸寫防的是竄改內容，這些動不了）
    assert.equal(run(bash(root, 'cat .flow/spec-review/redteam-r1.json')), 0, 'cat 唯讀放行');
    assert.equal(run(bash(root, 'ls .flow/spec-review/')), 0, 'ls 放行');
    assert.equal(run(bash(root, 'git add specs/requirements.md .flow/spec-review/redteam-r1.json')), 0, 'git add 逐檔 staging 放行（v0.20.0 ledger 進版控）');
    assert.equal(run(bash(root, 'git diff HEAD -- .flow/spec-review/')), 0, 'git diff 放行');
    assert.equal(run(bash(root, 'node ~/.claude/skills/flow-toolkit/flow-state.mjs spec-review redteam --file /tmp/f.json')), 0, 'CLI 正門放行（無重導進目錄）');
    assert.equal(run(bash(root, 'cat .flow/spec-review/redteam-r1.json && node flow-state.mjs review-resolve SR-RT-001 --as open')), 0, '讀+CLI 複合放行');
    // trace/verify 同守（W2）
    assert.equal(run(write(root, path.join(root, '.flow', 'trace', 'req-index.json'), '{}')), 2, 'Write 裸寫 trace 擋');
    assert.equal(run(bash(root, `echo '{}' > .flow/verify/REQ-E2E-001.json`)), 2, 'Bash 重導寫 verify 擋');
    assert.equal(run(bash(root, 'git add .flow/trace .flow/verify')), 0, 'git add trace/verify 放行');
    assert.equal(run(bash(root, 'cat .flow/trace/req-index.json')), 0, '讀 trace 放行');
    // code-review 同守（C）
    assert.equal(run(write(root, path.join(root, '.flow', 'code-review', 'findings.json'), '{}')), 2, 'Write 裸寫 code-review 擋');
    assert.equal(run(bash(root, 'node flow-state.mjs review-code --file cr.json')), 0, 'review-code 正門放行');
  });
});

test('fd 編號重導向（1>/2>）寫 ledger → 擋；fd 合併/丟棄 → 唯讀放行（H1 繞洞回歸）', async () => {
  await withFlow(async (root) => {
    assert.equal(run(bash(root, `echo '{"status":"pass"}' 1> .flow/verify/REQ-E2E-001.json`)), 2, '1> 重導寫 verify 擋');
    assert.equal(run(bash(root, `some-tool 2> .flow/spec-review/x.md`)), 2, '2> 重導寫 spec-review 擋');
    assert.equal(run(bash(root, `node x.mjs 2>> .flow/trace/err.log`)), 2, '2>> append 擋');
    assert.equal(run(bash(root, 'cat .flow/verify/REQ-E2E-001.json 2>/dev/null')), 0, '2>/dev/null 丟棄仍屬唯讀');
    assert.equal(run(bash(root, 'cat .flow/spec-review/r.json 2>&1')), 0, '2>&1 fd 合併仍屬唯讀');
    assert.equal(run(bash(root, 'Get-Content .flow/trace/req-index.json 2> $null')), 0, 'PS 2> $null 唯讀放行');
    assert.equal(run(bash(root, 'type .flow\\verify\\x.json 2>NUL')), 0, 'Windows 2>NUL 唯讀放行');
  });
});

test('非 Flow / 壞 JSON / 非相關工具 → fail-open exit 0', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'noflow-'));
  assert.equal(run(write(tmp, path.join(tmp, '.flow', 'state.json'), SPEC_DONE)), 0, '無 .flow → 放行');
  await rm(tmp, { recursive: true, force: true });
  assert.equal(spawnSync('node', [HOOK], { input: '{bad', encoding: 'utf8' }).status, 0, '壞 JSON 放行');
  await withFlow(async (root) => {
    assert.equal(run({ tool_name: 'TaskUpdate', tool_input: {}, cwd: root }), 0, '非 Write/Edit/Bash/PS 放行');
  });
});

// ── Batch 2：C-10 verify/tdd 裸寫、C-4 unicode/註解繞過 ──

test('C-10：Write raw 寫 verify/tdd 進 state.json → exit 2；正門 verify-ok/run 命令放行', async () => {
  await withFlow(async (root) => {
    const sp = path.join(root, '.flow', 'state.json');
    assert.equal(run(write(root, sp, JSON.stringify({ verify: 'ok:fake', tdd: 'green' }))), 2, '裸寫 verify/tdd');
    assert.equal(run(edit(root, sp, '"tdd": "green"')), 2, 'Edit 改 tdd');
    // 正門命令（bash 呼叫 flow-state verify-ok / run）不含 verify:"..." JSON → 不誤擋
    assert.equal(run(bash(root, 'node ~/.claude/skills/flow-toolkit/flow-state.mjs verify-ok F-1 --ref trace.zip --tdd green')), 0, 'verify-ok 正門放行');
    assert.equal(run(bash(root, 'node flow-state.mjs run --task F-1 -- npm test')), 0, 'run 正門放行');
  });
});

test('C-4：unicode 轉義 phase 值繞過 → 仍擋；尾綴註解冒充正門 → 不放行', async () => {
  await withFlow(async (root) => {
    const sp = path.join(root, '.flow', 'state.json');
    // \u escape 的 spec-done（"spec-done" 每字元轉義片段）
    assert.equal(run(write(root, sp, '{"phase":"spec-\u0064one"}')), 2, 'unicode 轉義 phase 仍被解回並擋');
    // echo 寫 state.json + 尾綴註解假裝有跑 spec-ready 正門 → 不該放行
    assert.equal(run(bash(root, `echo '{"phase":"spec-done"}' > .flow/state.json  # flow-state spec-ready --freeze`)), 2, '註解冒充正門不放行');
  });
});
