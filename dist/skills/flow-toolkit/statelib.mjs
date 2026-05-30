// statelib.mjs — Flow .flow/ 耐久狀態的唯一入口。
// 設計：write-ahead journal（先記再做）+ 冷啟動 reconstruct（只讀磁碟即重建現場）。
// append-only journal（用 id|action 當 key）讓 N 個並行 worker 各自的 dangling 都留得住——
// 修掉「單檔 state.json 多 worker 互蓋」硬傷。state.json 保留為當前 task 衍生指標（相容既有 hook）。
import { mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const dir          = root => path.join(root, '.flow');
const ledgerDir    = root => path.join(dir(root), 'ledger');
const decisionsDir = root => path.join(dir(root), 'decisions');
const manifestPath = root => path.join(dir(root), 'manifest.json');
const journalPath  = root => path.join(dir(root), 'journal.ndjson');
const statePath    = root => path.join(dir(root), 'state.json');
const nowISO = () => new Date().toISOString();

async function readJSON(p, fallback) {
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
}
async function writeJSON(p, obj) {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(obj, null, 2), 'utf8');   // 無 BOM，供任何 reader 解析
}

export async function init(root, manifest = {}) {
  await mkdir(ledgerDir(root), { recursive: true });
  await mkdir(decisionsDir(root), { recursive: true });
  const m = { ...manifest, createdAt: manifest.createdAt || nowISO(), updatedAt: nowISO() };
  await writeJSON(manifestPath(root), m);
  if (!existsSync(journalPath(root))) await writeFile(journalPath(root), '', 'utf8');
}

export async function readManifest(root) { return readJSON(manifestPath(root), { tasks: [] }); }
export async function writeManifest(root, manifest) {
  await writeJSON(manifestPath(root), { ...manifest, updatedAt: nowISO() });
}

export async function writeLedger(root, id, obj) {
  await writeJSON(path.join(ledgerDir(root), id + '.json'), { ...obj, id, updatedAt: nowISO() });
}
export async function readLedger(root, id) {
  return readJSON(path.join(ledgerDir(root), id + '.json'), {});
}
export async function listLedger(root) {
  const d = ledgerDir(root);
  if (!existsSync(d)) return [];
  const out = [];
  for (const f of await readdir(d)) if (f.endsWith('.json')) out.push(await readJSON(path.join(d, f), {}));
  return out;
}

export async function appendJournal(root, event) {
  await mkdir(dir(root), { recursive: true });
  await appendFile(journalPath(root), JSON.stringify({ t: nowISO(), ...event }) + '\n', 'utf8');
}
export async function readJournal(root) {
  if (!existsSync(journalPath(root))) return [];
  const raw = await readFile(journalPath(root), 'utf8');
  return raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// 狀態轉移：更新 ledger 快照 + 記 journal（單筆轉移即原子，不需 start/done 包覆）
export async function transition(root, id, from, to, patch = {}) {
  const cur = await readLedger(root, id);
  await writeLedger(root, id, { ...cur, ...patch, state: to });
  await appendJournal(root, { ev: 'task.transition', id, from, to });
}

// 長動作（會跑一陣、可能中途當機）：先記 start、做完記 done。冷啟動時 start-無-done = 待冪等補做。
export async function actionStart(root, id, action) { await appendJournal(root, { ev: 'action.start', id, action }); }
export async function actionDone(root, id, action, result) { await appendJournal(root, { ev: 'action.done', id, action, result }); }

export async function recordDecision(root, id, decision) {
  await writeJSON(path.join(decisionsDir(root), id + '.json'), { id, ...decision, at: decision.at || nowISO() });
  await appendJournal(root, { ev: 'decision', id, choice: decision.choice, by: decision.by });
}
export async function readDecision(root, id) { return readJSON(path.join(decisionsDir(root), id + '.json'), {}); }

// state.json 相容 bridge：當前 task 衍生指標（既有 flow-verify-gate / flow-session-start hook 只讀這個）
export async function writeStateJson(root, state) { await writeJSON(statePath(root), state); }
export async function readStateJson(root) { return readJSON(statePath(root), {}); }

// 冷啟動重建：只讀磁碟 → 還原「現況 + 未完成動作」。任何 agent / 機器跑這個就接上。
export async function reconstruct(root) {
  const manifest = await readManifest(root);
  const tasks = {};
  for (const l of await listLedger(root)) if (l.id) tasks[l.id] = l;
  for (const t of (manifest.tasks || [])) if (!tasks[t.id]) tasks[t.id] = { id: t.id, state: 'pending' };

  const journal = await readJournal(root);
  const open = new Map();   // action.start 沒對應 action.done；key=id|action → 並行各自獨立、不互蓋
  for (const e of journal) {
    if (e.ev === 'action.start') open.set(e.id + '|' + e.action, { id: e.id, action: e.action });
    else if (e.ev === 'action.done') open.delete(e.id + '|' + e.action);
  }
  return { manifest, tasks, dangling: [...open.values()], journalLength: journal.length };
}
