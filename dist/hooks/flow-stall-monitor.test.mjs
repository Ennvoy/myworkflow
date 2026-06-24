// flow-stall-monitor.test.mjs — stall 斷路器 hook（node --test）
// 驗：runner 失敗連 N 輪注入 STALL（用真實 tool_output 形狀 + 命令分桶，不靠 state.task）；
//     成功重置、跨 bucket 交錯不沖掉、無 exit code fallback、非 runner/非 Flow/壞 JSON 一律 fail-open。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../skills/flow-toolkit/statelib.mjs';

const HOOK = fileURLToPath(new URL('./flow-stall-monitor.mjs', import.meta.url));
const runHook = input => {
  const r = spawnSync('node', [HOOK], { input: JSON.stringify(input), encoding: 'utf8' });
  return { stdout: r.stdout || '', status: r.status };
};
async function withRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stalltest-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
// 真實 Claude Code PostToolUse Bash 形狀：tool_output:{stdout,stderr,exit_code}（不靠 task 欄）
const fail = (root, cmd = 'pytest tests/test_x.py', stderr = 'FAILED test_x - AssertionError: 1 != 2') => ({
  tool_name: 'Bash', tool_input: { command: cmd },
  tool_output: { stdout: '==== test session starts ====', stderr, exit_code: 1 }, cwd: root,
});
const pass = (root, cmd = 'pytest tests/test_x.py') => ({
  tool_name: 'Bash', tool_input: { command: cmd },
  tool_output: { stdout: '2 passed', stderr: '', exit_code: 0 }, cwd: root,
});

test('runner 失敗連 3 輪（tool_output 形狀、命令分桶、無 task 欄）→ 第 3 輪注入 STALL', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeStateJson(root, { phase: 'building' });   // 刻意不寫 task（生產真實形狀）
    assert.ok(!runHook(fail(root)).stdout.includes('STALL'), '第 1 輪');
    assert.ok(!runHook(fail(root)).stdout.includes('STALL'), '第 2 輪');
    const r3 = runHook(fail(root));
    assert.ok(r3.stdout.includes('STALL'), '第 3 輪注入 STALL');
    assert.match(r3.stdout, /additionalContext/);
    assert.equal(r3.status, 0);
  });
});

test('生產形狀回歸：跨 bucket 交錯失敗不沖掉卡死那條的連敗（修 _current 串味）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeStateJson(root, { phase: 'building' });   // 無 task → 舊版全擠 _current 會被 B 沖掉
    runHook(fail(root, 'pytest tests/test_a.py'));         // A#1
    runHook(fail(root, 'pytest tests/test_b.py'));         // B（不同 bucket，不該沖掉 A）
    runHook(fail(root, 'pytest tests/test_a.py'));         // A#2
    const rA3 = runHook(fail(root, 'pytest tests/test_a.py')); // A#3
    assert.ok(rA3.stdout.includes('STALL'), 'A 連 3 次即觸發，B 的交錯不沖掉');
  });
});

test('成功（exit 0）記 ok 重置：fail,fail,pass,fail → 不觸發', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    runHook(fail(root));
    runHook(fail(root));
    runHook(pass(root));                                   // 成功重置
    const r = runHook(fail(root));
    assert.ok(!r.stdout.includes('STALL'), '成功後連敗歸 1，不該觸發');
  });
});

test('失敗訊息變化（換 sig，有進展）→ 不觸發', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    runHook(fail(root, 'pytest tests/test_x.py', 'FAILED test_x - AssertionError: 1 != 2'));
    runHook(fail(root, 'pytest tests/test_x.py', 'FAILED test_x - AssertionError: 1 != 2'));
    const r = runHook(fail(root, 'pytest tests/test_x.py', 'FAILED test_x - ImportError: other'));
    assert.ok(!r.stdout.includes('STALL'), '末輪換了失敗 → 連敗歸 1');
  });
});

test('tool_response 舊欄位名也吃（向後相容）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    const p = { tool_name: 'Bash', tool_input: { command: 'pytest x.py' }, tool_response: { stderr: 'FAILED - AssertionError', exit_code: 1 }, cwd: root };
    runHook(p); runHook(p);
    assert.ok(runHook(p).stdout.includes('STALL'), 'tool_response 欄位仍能讀到');
  });
});

test('無數值 exit code → 退而掃失敗標記：FAILED 連 3 觸發、「0 failed」不誤觸', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    const noCode = (stderr) => ({ tool_name: 'Bash', tool_input: { command: 'pytest q.py' }, tool_output: { stderr }, cwd: root });
    runHook(noCode('FAILED test_q - AssertionError')); runHook(noCode('FAILED test_q - AssertionError'));
    assert.ok(runHook(noCode('FAILED test_q - AssertionError')).stdout.includes('STALL'), '無 exit code 但 FAILED → 累計觸發');
  });
});

test('無 exit code 且輸出含「0 failed」→ 視為綠、不觸發（收偽陽）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    const green = () => ({ tool_name: 'Bash', tool_input: { command: 'pytest g.py' }, tool_output: { stdout: '5 passed, 0 failed' }, cwd: root });
    for (let i = 0; i < 4; i++) assert.ok(!runHook(green()).stdout.includes('STALL'));
  });
});

test('非 runner 命令 / runner 成功 → 不注入', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    for (let i = 0; i < 4; i++) {
      assert.equal(runHook({ tool_name: 'Bash', tool_input: { command: 'git status' }, tool_output: { exit_code: 1 }, cwd: root }).stdout.trim(), '');
      assert.equal(runHook(pass(root)).stdout.trim(), '');
    }
  });
});

test('非 Flow 專案（無 .flow）/ 壞 JSON / 空輸入 → fail-open exit 0', async () => {
  await withRoot(async (root) => {
    assert.equal(runHook(fail(root)).status, 0);            // 沒 init → 無 .flow
    assert.equal(runHook(fail(root)).stdout.trim(), '');
  });
  assert.equal(spawnSync('node', [HOOK], { input: '{not json', encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('node', [HOOK], { input: '', encoding: 'utf8' }).status, 0);
});

test('threshold 可由 state.json stallThreshold 覆寫（設 2 → 第 2 輪觸發）', async () => {
  await withRoot(async (root) => {
    await S.init(root, { project: 'p', tasks: [] });
    await S.writeStateJson(root, { stallThreshold: 2 });
    runHook(fail(root));
    assert.ok(runHook(fail(root)).stdout.includes('STALL'), 'threshold=2 → 第 2 輪');
  });
});
