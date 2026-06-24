// flow-size-check.test.mjs — context 預算偵測 hook（node --test）
// 驗判據②：讀 transcript_path 真實 usage，>~120k 注入收束提醒；低用量/無 transcript 不誤觸；判據①size 仍運作。
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

async function writeTranscript(root, usedInput) {
  const p = path.join(root, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user' } }),
    JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: usedInput, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 40 } } }),
  ];
  await writeFile(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

test('高 context 用量（>120k）→ 注入收束提醒', async () => {
  await withProject(async (root) => {
    const tp = await writeTranscript(root, 130000);
    const out = runHook({ hook_event_name: 'SessionStart', cwd: root, transcript_path: tp });
    assert.match(out, /context 利用率/);
    assert.match(out, /flow-compact/);
  });
});

test('低 context 用量（<120k）→ 不注入', async () => {
  await withProject(async (root) => {
    const tp = await writeTranscript(root, 30000);
    const out = runHook({ hook_event_name: 'SessionStart', cwd: root, transcript_path: tp });
    assert.equal(out.trim(), '');
  });
});

test('無 transcript_path → ctx 判據靜默；size 判據仍運作', async () => {
  await withProject(async (root) => {
    // specs 檔 >50KB
    await writeFile(path.join(root, 'specs', 'requirements.md'), 'x'.repeat(60 * 1024), 'utf8');
    const out = runHook({ hook_event_name: 'SessionStart', cwd: root });
    assert.match(out, /SDD 檔案膨脹/, 'size 判據仍報');
    assert.ok(!out.includes('context 利用率'), '無 transcript → 不報 ctx');
  });
});

test('用量算 input+cache_read+cache_creation（cache 佔視窗也算）', async () => {
  await withProject(async (root) => {
    const p = path.join(root, 'transcript.jsonl');
    await writeFile(p, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 20000, cache_read_input_tokens: 110000, cache_creation_input_tokens: 5000 } } }) + '\n', 'utf8');
    const out = runHook({ hook_event_name: 'SessionStart', cwd: root, transcript_path: p });
    assert.match(out, /context 利用率/, '20k+110k+5k=135k >120k → 觸發');
  });
});

test('非 Flow 專案 → 靜默', () => {
  const out = runHook({ hook_event_name: 'SessionStart', cwd: os.tmpdir() + '/definitely-not-a-flow-proj-xyz' });
  assert.equal(out.trim(), '');
});

test('壞 transcript（半行/壞 JSON）→ fail-open 不炸、不誤報', async () => {
  await withProject(async (root) => {
    const p = path.join(root, 'transcript.jsonl');
    await writeFile(p, '{partial line no close\n{"also": "no usage"}\n', 'utf8');
    const out = runHook({ hook_event_name: 'SessionStart', cwd: root, transcript_path: p });
    assert.equal(out.trim(), '', '無 usage 可讀 → 不報');
  });
});

test('尾端是 0-usage 佔位 turn、前面有真實 usage → 仍報出（修最肥時靜默失效）', async () => {
  await withProject(async (root) => {
    const p = path.join(root, 'transcript.jsonl');
    const lines = [
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5000, cache_read_input_tokens: 140000, cache_creation_input_tokens: 0 } } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { usage: { input_tokens: 200000 } } }), // sub-agent，不該採用
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }), // 佔位 0-usage
    ];
    await writeFile(p, lines.join('\n') + '\n', 'utf8');
    const out = runHook({ hook_event_name: 'SessionStart', cwd: root, transcript_path: p });
    assert.match(out, /context 利用率/, '跳過 0-usage 與 sidechain，找到 145k 真實 usage → 報出');
  });
});
