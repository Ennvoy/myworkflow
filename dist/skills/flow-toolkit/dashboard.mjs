// dashboard.mjs — Flow 監控看板伺服器（純監控、唯讀）。
// 讀「當前專案」的 specs/tasks.md + .flow/（state.json/ledger，經 statelib）+ git → 投影給 board.html。
// 全域裝一次（~/.claude/skills/flow-toolkit），跑時讀 cwd（或 argv[2]）的專案。決策一律回 Claude 彈窗。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from './statelib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] || process.cwd();   // 當前專案根
const PORT = +(process.argv[3]) || 4317;          // 偏好 port；占用自動 +1（多專案並行不撞）

const SECTION_RE = /^#{1,3}\s*(Prelude|Features|Cross-?cutting|Backlog)/i;
const TASK_RE = /^\s*[-*]\s*\[([ xX])\]\s*(.+)$/;
const ID_RE = /^([A-Z][A-Za-z]*-[\w.]+)\b\s*(.*)$/;

// 容錯解析 tasks.md：抓所有 [ ]/[x] + 最近章節 + blockedBy 續行。無標準三層標題就平鋪（section=''）。
function parseTasks(md) {
  const out = [];
  let section = '', last = null;
  for (const raw of md.split(/\r?\n/)) {
    const sec = raw.match(SECTION_RE);
    if (sec) {
      const s = sec[1].toLowerCase();
      section = s.startsWith('cross') ? 'cross-cutting' : s;
      last = null; continue;
    }
    const tm = raw.match(TASK_RE);
    if (tm) {
      const checked = tm[1].toLowerCase() === 'x';
      const rest = tm[2].trim().replace(/\*\*/g, '');
      const idm = rest.match(ID_RE);
      const id = idm ? idm[1] : rest.slice(0, 18);
      const name = idm ? (idm[2].trim() || id) : rest;
      last = { id, name, section, checked, blockedBy: [] };
      out.push(last);
      continue;
    }
    if (last) {
      const bb = raw.match(/blockedBy\s*[:：]\s*(.+)/i);
      if (bb) last.blockedBy = bb[1].split(/[,，、]/).map(s => s.trim().replace(/\bconflictZone\b.*/i, '').trim())
        .filter(s => s && s !== '—' && s !== '-');
    }
  }
  return out;
}

function gitHead(root) {
  try { return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return '—'; }
}

async function projectView() {
  const tasksMd = path.join(ROOT, 'specs', 'tasks.md');
  const features = existsSync(tasksMd) ? parseTasks(await readFile(tasksMd, 'utf8')) : [];

  let state = {}, ledger = {}, phase = '?';
  try { state = await S.readStateJson(ROOT); } catch {}
  if (existsSync(path.join(ROOT, '.flow'))) {
    try {
      const v = await S.reconstruct(ROOT);
      for (const l of Object.values(v.tasks)) if (l && l.id) ledger[l.id] = l;
      phase = (v.manifest && v.manifest.phase) || state.phase || '?';
    } catch {}
  }
  if (phase === '?') phase = state.phase || '?';

  const byId = Object.fromEntries(features.map(f => [f.id, f]));
  const live = v => v && !/^none$/i.test(String(v));
  const isDone = f => f.checked || (ledger[f.id] && ledger[f.id].state === 'delivered');

  const projected = features.map(f => {
    const l = ledger[f.id] || {};
    let st;
    if (isDone(f)) st = 'delivered';
    else if (state.task === f.id) st = live(state.verify) ? 'verifying' : 'building';
    else if (l.state && l.state !== 'pending') st = l.state;
    else if (f.blockedBy.some(d => byId[d] && !isDone(byId[d]))) st = 'blocked';
    else st = 'pending';
    const o = { id: f.id, name: f.name, section: f.section || '', state: st };
    if (st === 'blocked') o.blockedBy = f.blockedBy.find(d => byId[d] && !isDone(byId[d])) || '';
    if (state.task === f.id) {
      if (live(state.tdd)) o.tdd = state.tdd;
      if (live(state.verify)) o.verify = state.verify;
    }
    if (l.commit) o.commit = l.commit;
    else if (state.task === f.id && live(state.commit) && !/^nochange$/i.test(state.commit)) o.commit = state.commit;
    if (l.note) o.note = l.note;
    if (l.decision) o.decision = l.decision;
    return o;
  });

  // 完成謂詞：tasks.md 算得出的部分（P/F 全交付、X-* 清空）；e2e/perf 需真驗證 → null（看板不假裝綠）
  const pf = features.filter(f => f.section === 'prelude' || f.section === 'features');
  const xc = features.filter(f => f.section === 'cross-cutting');
  const predicate = {
    pf: pf.length > 0 && pf.every(isDone), pfRemain: pf.filter(f => !isDone(f)).length,
    xcut: xc.every(isDone), xcutRemain: xc.filter(f => !isDone(f)).length,
    e2e: null, perf: null,
  };

  return {
    project: path.basename(ROOT), phase,
    updatedCommit: gitHead(ROOT),
    current: state.task ? state : null,
    features: projected, predicate,
  };
}

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (req.method === 'GET' && (p === '/' || p === '/board.html'))
      return send(res, 200, await readFile(path.join(__dirname, 'board.html'), 'utf8'), 'text/html; charset=utf-8');
    if (req.method === 'GET' && p === '/status.json')
      return send(res, 200, JSON.stringify(await projectView()), 'application/json; charset=utf-8');
    if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    send(res, 404, 'not found');
  } catch (e) { send(res, 500, 'error: ' + e.message); }
});

let _att = 0;
function listenAuto(p) {
  const onErr = e => {
    if (e.code === 'EADDRINUSE' && _att < 50) { _att++; server.removeListener('error', onErr); listenAuto(p + 1); }
    else { console.error('listen failed:', e.message); process.exit(1); }
  };
  server.once('error', onErr);
  server.listen(p, '127.0.0.1', () => {
    server.removeListener('error', onErr);
    try { mkdirSync(path.join(ROOT, '.flow'), { recursive: true }); writeFileSync(path.join(ROOT, '.flow', 'monitor.port'), String(p), 'utf8'); } catch {}
    console.log(`flow monitor on http://127.0.0.1:${p}  (project: ${ROOT})`);
  });
}
listenAuto(PORT);
