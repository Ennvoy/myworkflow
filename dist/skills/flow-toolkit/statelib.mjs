// statelib.mjs — Flow .flow/ 耐久狀態的唯一入口。
// 設計：write-ahead journal（先記再做）+ 冷啟動 reconstruct（只讀磁碟即重建現場）。
// append-only journal（用 id|action 當 key）讓 N 個並行 worker 各自的 dangling 都留得住——
// 修掉「單檔 state.json 多 worker 互蓋」硬傷。state.json 保留為當前 task 衍生指標（相容既有 hook）。
import { mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const dir          = root => path.join(root, '.flow');
const ledgerDir    = root => path.join(dir(root), 'ledger');
const decisionsDir = root => path.join(dir(root), 'decisions');
const manifestPath = root => path.join(dir(root), 'manifest.json');
const journalPath  = root => path.join(dir(root), 'journal.ndjson');
const lessonsPath  = root => path.join(dir(root), 'lessons.ndjson');
const statePath    = root => path.join(dir(root), 'state.json');
const nowISO = () => new Date().toISOString();

// id 直接當檔名（ledger/decisions/<id>.json），故拒含路徑分隔/.. 的 id，防自駕模型傳惡意 id 寫出 .flow 之外。
function safeId(id) {
  const s = String(id ?? '').trim();
  if (!s || /[\/\\]|\.\./.test(s)) { const e = new Error(`不安全或空的 id：「${s}」`); e.code = 'UNSAFE_ID'; throw e; }
  return s;
}

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
  await writeJSON(path.join(ledgerDir(root), safeId(id) + '.json'), { ...obj, id, updatedAt: nowISO() });
}
export async function readLedger(root, id) {
  return readJSON(path.join(ledgerDir(root), safeId(id) + '.json'), {});
}
export async function listLedger(root) {
  const d = ledgerDir(root);
  if (!existsSync(d)) return [];
  const out = [];
  for (const f of await readdir(d)) if (f.endsWith('.json')) out.push(await readJSON(path.join(d, f), {}));
  return out;
}

// ── 逐 REQ-E2E 驗證記錄（.flow/verify/<id>.json）：coverage 對賬的機讀來源 ──
// Evaluator 在某條 REQ-E2E journey 真跑綠後落一筆（flow-state verify-e2e）；ship 出口逐條對賬
// requirements.md 的 REQ-E2E-*。把「所有 REQ-E2E 真綠了」從散文提示升級成確定性節點。
const verifyDir = root => path.join(dir(root), 'verify');
export async function writeVerifyRecord(root, id, rec) {
  await writeJSON(path.join(verifyDir(root), safeId(id) + '.json'), { id, ...rec, at: rec.at || nowISO() });
}
export async function listVerifyRecords(root) {
  const d = verifyDir(root);
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

// ── stall 偵測（doom-loop 斷路器）：runner 辨識 + 失敗指紋 + 連續計數 ──
// 自駕無花費上限時的防失控底線。flow-stall-monitor hook 在 runner 失敗時 recordVerifyAttempt、成功時記 sig='ok' 重置。
// 同 bucket 同 sig 連續 ≥N 即 doom loop。偵測「優先用 runner 真實 exit code、無則 best-effort 掃失敗標記」。
// 分桶 key 用 runnerBucket(命令)、不靠 state.task（生產不寫該欄）——同一條測試的連續失敗自然同桶、不同測試自然分桶。

// runner 含 test + build/typecheck/lint（會回 exit code 的命令型迴圈也要接到）；排除套件管理 install/add 與純印出（偽陽）。
const RUNNER_RE = /\b(pytest|jest|vitest|mocha|playwright|cypress|rspec|phpunit|unittest)\b|\b(go|cargo|dotnet)\s+(test|build)\b|\b(gradlew?|mvn)\b[\s\S]*\b(test|build|verify)\b|\btsc\b|\bnode\s+--test\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check|tsc)\b/i;
export function isRunnerCommand(cmd) {
  const s = String(cmd || '');
  if (/^\s*(echo|printf|cat|grep|rg|ls|which|type)\b/.test(s)) return false;     // 純印出/查找含 runner 字樣不算
  if (/\b(npm|pnpm|yarn|bun|pip|pip3|cargo|go|gem|composer|poetry)\s+(install|add|i|ci|get|remove|uninstall|sync)\b/.test(s)) return false; // 套件管理非 verify runner
  return RUNNER_RE.test(s);
}

// 把 runner 命令正規化成穩定的「失敗分桶 key」：去 flag、小寫、壓空白。
// 同一條測試重跑→同 bucket；不同測試/檔→不同 bucket。cwd 已由 .flow 位置隔離專案。
export function runnerBucket(cmd) {
  return String(cmd || '').split(/\s+/).filter(t => t && !t.startsWith('-')).join(' ').toLowerCase().slice(0, 200) || '_runner';
}

// 失敗指紋去噪：抽「失敗特徵行」（非首行 banner），正規化掉路徑/耗時/行號/seed 等易變 token，
// 讓「同一個失敗」跨輪穩定（不被噪音打散→該斷不斷）、「不同失敗」不被固定 banner 併成同指紋（→偽 stall）。
const normSig = t => String(t || '')
  .replace(/\x1b\[[0-9;]*m/g, '')                          // ANSI 色碼
  .replace(/[A-Za-z]:\\[^\s:]+|(?:\/[\w.\-]+)+\//g, '<p>')  // 絕對/長路徑（Win C:\… / Unix /a/b/）
  .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|m)\b/gi, '<t>')   // 耗時 3.2s / 120ms
  .replace(/:\d+(?::\d+)?\b/g, ':<n>')                      // 行:列號
  .replace(/\b0x[0-9a-f]+\b/gi, '<h>')                      // hex
  .replace(/\b\d{4,}\b/g, '<n>')                            // 長數字（seed/pid/timestamp）
  .toLowerCase().replace(/\s+/g, ' ').trim();
const FAILLINE_RE = /(FAILED|\bFAIL\b|AssertionError|\w+Error\b|Traceback|Exception\b|✗|✘|\bnot ok\b|expect\(|●|×|panic:)/i;
export function verifyFailSig(cmd, output) {
  const lines = String(output || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const feat = lines.filter(l => FAILLINE_RE.test(l));
  const basis = feat.length ? [...new Set(feat)].sort().join('\n') : (lines[0] || '');   // 撈不到特徵行才退回首行
  return createHash('sha1').update(normSig(cmd) + '|' + normSig(basis)).digest('hex').slice(0, 12);
}

// 尾端連續同 sig 的 verify.attempt 數（換 sig＝有變化／成功記 'ok'＝歸 1）。bucket id 精確比對。純函式。
export function stallCount(journal, id) {
  const sigs = (journal || []).filter(e => e && e.ev === 'verify.attempt' && e.id === id).map(e => e.sig);
  if (!sigs.length) return 0;
  const last = sigs[sigs.length - 1];
  if (last === 'ok') return 0;                              // 末筆是成功→無連敗
  let n = 0;
  for (let i = sigs.length - 1; i >= 0 && sigs[i] === last; i--) n++;
  return n;
}
export async function recordVerifyAttempt(root, id, sig, exit) {
  await appendJournal(root, { ev: 'verify.attempt', id, sig, exit });
}

// ── 失敗記憶（防計畫再生撞同一面牆）：append-only、硬上限 N 筆丟最舊；──
// delivered task 的死路由 reconstruct 自動濾掉（不再相關），不需手動標 stale。
const LESSON_CAP = 5;
export async function readLessons(root) {
  const p = lessonsPath(root);
  if (!existsSync(p)) return [];
  const raw = await readFile(p, 'utf8');
  return raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
export async function appendLesson(root, lesson) {
  await mkdir(dir(root), { recursive: true });
  const kept = [...await readLessons(root), {
    id: lesson.id, failedApproach: lesson.failedApproach, why: lesson.why, stale: !!lesson.stale, at: nowISO(),
  }].slice(-LESSON_CAP);
  await writeFile(lessonsPath(root), kept.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8');
  await appendJournal(root, { ev: 'lesson', id: lesson.id });
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
  await writeJSON(path.join(decisionsDir(root), safeId(id) + '.json'), { id, ...decision, at: decision.at || nowISO() });
  await appendJournal(root, { ev: 'decision', id, choice: decision.choice, by: decision.by });
}
export async function readDecision(root, id) { return readJSON(path.join(decisionsDir(root), safeId(id) + '.json'), {}); }

// state.json 相容 bridge：當前 task 衍生指標（既有 flow-verify-gate / flow-session-start hook 只讀這個）
export async function writeStateJson(root, state) { await writeJSON(statePath(root), state); }
export async function readStateJson(root) { return readJSON(statePath(root), {}); }

// ── 凍結前 requirements 就緒度（純函式可測；只看 requirements.md 內容）──
// 自駕安全的源頭：spec 沒問乾淨（### 開放問題 沒清零）就凍結，自駕途中 AI 只能猜＝跑歪。
// 故凍結前 SHALL：① ### 開放問題 段收斂為零（空 /「無」/「N/A」才算零，任一實質列＝未收斂）；
//   ② 至少各 1 條 REQ-（驗收條件）/ REQ-E2E-（端到端 journey＝驗證來源）/ REQ-PERF-（效能 budget＝ship 硬閘門）。
// 「延後決策」不放這段（移到獨立段 + flow-state decision 記錄），故 ### 開放問題 任何實質列都算未收斂。
const SPEC_NONE_RE = /^(無|（無）|\(無\)|none|n\/?a|—|–|-|\.{1,3})$/i;
export function specReadiness(md) {
  const text = String(md || '');
  let inSection = false, level = 0;
  const open = [];
  for (const raw of text.split(/\r?\n/)) {
    const h = raw.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (h) {
      const lv = h[1].length, title = h[2].replace(/\*\*/g, '').trim();
      if (inSection && lv <= level) inSection = false;                 // 同級或更高標題＝段結束
      if (/開放問題|open\s*questions/i.test(title)) { inSection = true; level = lv; }
      continue;
    }
    if (!inSection) continue;
    const body = raw.replace(/\*\*/g, '').replace(/^\s*[-*+]\s*/, '').replace(/^\s*\d+[.)]\s*/, '').trim();
    if (!body || SPEC_NONE_RE.test(body)) continue;                    // 空行 /「無」/「N/A」＝零
    open.push(body);
  }
  const problems = [];
  if (open.length) problems.push(`### 開放問題 還有 ${open.length} 項未收斂——凍結前 SHALL 清零（解決成 REQ/EARS，或移到「延後決策」段並 flow-state decision 記錄）`);
  if (!/\bREQ-/.test(text))       problems.push('查無任何 REQ- 驗收條件（requirements.md 形同空殼）');
  if (!/\bREQ-E2E-/i.test(text))  problems.push('查無 REQ-E2E-*（缺可 demo 的端到端 journey＝Phase 4/5 沒驗證來源）');
  if (!/\bREQ-PERF-/i.test(text)) problems.push('查無 REQ-PERF-*（缺效能 budget；無效能敏感路徑也 SHALL 寫一條 REQ-PERF-001：N/A，表有意識略過）');
  return { open, problems };
}

// ── tasks.md 同步：把「task 完成」收成一個可被 hook/CLI 共用的原子操作 ──
// 修根因：原本「翻 tasks.md [x]」「寫 ledger」「TaskUpdate」是三條各自會被漏掉的散文步驟。
// 這裡把「翻 [x] + ledger→delivered」綁成一次呼叫，flow-state done 與 commit gate 都走它。
const tasksMdPath = root => path.join(root, 'specs', 'tasks.md');
const LINE_RE = /^(\s*[-*]\s*\[)([ xX])(\]\s*)(.+)$/;          // 抓 checkbox 行（保留前後綴以原樣回寫）
const ID_RE   = /^([A-Z][A-Za-z]*(?:-[\w.]+)+)\b/;            // 抽 canonical id（去 ** 後取開頭 ID token）
function lineId(rest) {
  const m = rest.replace(/\*\*/g, '').trim().match(ID_RE);
  return m ? m[1] : null;
}
// id 比對：canonical 完全相等優先，否則容忍一端是另一端的尾段 token（F-1186-W0-5 ↔ W0-5）。
export function idMatches(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith('-' + b) || b.endsWith('-' + a) || a.endsWith('/' + b) || b.endsWith('/' + a);
}
// 純函式：把 id 對應那行 [ ]→[x]（保留 EOL 風格與縮排）。回傳 { text, found, changed }。
export function flipCheckbox(md, id) {
  const eol = md.includes('\r\n') ? '\r\n' : '\n';
  const lines = md.split(/\r?\n/);
  let found = false, changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE_RE);
    if (!m || !idMatches(lineId(m[4]), id)) continue;
    found = true;
    if (m[2] === ' ') { lines[i] = m[1] + 'x' + m[3] + m[4]; changed = true; }
    break;
  }
  return { text: lines.join(eol), found, changed };
}
// 把 raw id 解析成 manifest 的 canonical id（精確優先 → 唯一尾段匹配 → 原樣）。
// 歧義（一個尾段對到多個 canonical）不靜默挑一個：丟錯列候選逼用全名——避免翻錯行/開幽靈 ledger。
export async function resolveId(root, raw) {
  const ids = ((await readManifest(root)).tasks || []).map(t => t.id);
  if (ids.includes(raw)) return raw;
  const hits = ids.filter(id => idMatches(id, raw));
  if (hits.length > 1) {
    const e = new Error(`id「${raw}」有歧義，對到多個 task：${hits.join(', ')}——請改用完整 canonical id。`);
    e.code = 'AMBIGUOUS_ID';
    e.candidates = hits;
    throw e;
  }
  return hits.length === 1 ? hits[0] : raw;
}
const isNoneVal = v => { const s = String(v ?? '').trim(); return s === '' || /^none$/i.test(s); };
// 原子完成：翻 tasks.md [x] + ledger transition→delivered（冪等）。供 flow-state done / PostToolUse 共用。
// done 閘門（與 flow-verify-gate 同語意，堵「不走 TaskUpdate 直接 done」的權威路徑旁路）：
//   首次 delivered SHALL 有真驗證綠燈（state.json verify/tdd 非空非 none，由 /flow-verify 真跑綠後寫入）；
//   交付成功即把全域 verify/tdd 歸零成 none——下一個 task 必須有自己的新綠燈，堵「借上一個 task 的 stale 綠燈」。
//   已 delivered 的冪等重呼（如補 --commit）不過閘門。
export async function markTaskDone(root, rawId, patch = {}) {
  const id = await resolveId(root, rawId);
  const cur = await readLedger(root, id);
  const from = cur.state || 'pending';
  if (from !== 'delivered') {
    const st = await readStateJson(root);
    if (isNoneVal(st.verify) || isNoneVal(st.tdd)) {
      const e = new Error([
        `Flow done gate：「${id}」還沒有真驗證綠燈，不能標 delivered。`,
        isNoneVal(st.verify) ? '  - .flow/state.json "verify" 空/none → 先跑 /flow-verify，真跑綠了寫入 verify="ok:<證據ref>"。' : '',
        isNoneVal(st.tdd) ? '  - .flow/state.json "tdd" 空/none → TDD 紅→綠，或例外時寫 "n/a"/"skipped:<reason>"。' : '',
        '  別手改 state.json 假填過閘門（系統性違規）；驗證真的綠了再 done。',
      ].filter(Boolean).join('\n'));
      e.code = 'VERIFY_GATE';
      throw e;
    }
  }
  let flip = { found: false, changed: false };
  const tp = tasksMdPath(root);
  if (existsSync(tp)) {
    const md = await readFile(tp, 'utf8');
    flip = flipCheckbox(md, id);
    if (flip.changed) await writeFile(tp, flip.text, 'utf8');   // UTF-8 無 BOM
  }
  if (from !== 'delivered' || patch.commit) await transition(root, id, from, 'delivered', patch);
  if (from !== 'delivered') {
    const st = await readStateJson(root);
    await writeStateJson(root, { ...st, verify: 'none', tdd: 'none' });  // 交付即歸零，堵 stale 綠燈白嫖
  }
  return { id, fromState: from, alreadyDelivered: from === 'delivered', tasksMd: flip };
}

// ── conflictZone 檔案越界檢查（同 repo 平行的檔案安全閘門，純函式可測）──
// 同 repo 多 worker 平行只靠「各寫各自不重疊的檔」保安全。這支用 git 的真實變動（模型偽造不了）
// 比對每個 feature 宣告的 conflictZone，揪出落在所有 sandbox 之外的檔（worker 越界改了共用檔/foundation）。
// 匹配：glob（* / **）→ regex；否則前綴 + 邊界（後接 / . - 或結尾），避免 features/items 誤吃 features/itemsmore。
// 一律大小寫不敏感（Windows/macOS 檔案系統皆 case-insensitive；同 repo 大小寫衝突極罕見，誤放遠少於誤擋）。
const normPath = (f) => String(f).replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/$/, '');
function zoneToRe(zone) {
  const z = normPath(zone);
  if (z.includes('*')) {
    const re = z.replace(/[.+^${}()|[\]]/g, '\\$&')
                .replace(/\*\*\//g, '__GLOBSTARSLASH__')      // **/ 連斜線一起吃 → 零層目錄也匹配（src/**/x ∋ src/x）
                .replace(/\*\*/g, '__GLOBSTAR__')
                .replace(/\*/g, '[^/]*')
                .replace(/__GLOBSTARSLASH__/g, '(?:[^/]*/)*')
                .replace(/__GLOBSTAR__/g, '.*');
    return new RegExp('^' + re + '$', 'i');
  }
  return new RegExp('^' + z.replace(/[.*+^${}()|[\]\\]/g, '\\$&') + '($|[/.-])', 'i');
}
export function fileInZone(file, zone) { return zoneToRe(zone).test(normPath(file)); }
// changedFiles: string[]（git 變動檔）; zonesByFeature: { [id]: string[] }
// 回傳 { attributed:[{file,feature}], overlaps:[{file,features}], violations:[{file}], ok }
export function checkScope(changedFiles, zonesByFeature, opts = {}) {
  const ignore = opts.ignore || [/^\.flow($|\/)/, /^specs($|\/)/];
  const feats = Object.entries(zonesByFeature || {});
  const attributed = [], overlaps = [], violations = [];
  for (const raw of (changedFiles || [])) {
    const f = normPath(raw);
    if (!f || ignore.some((re) => re.test(f))) continue;
    const hits = feats.filter(([, zs]) => (zs || []).some((z) => fileInZone(f, z))).map(([id]) => id);
    if (hits.length === 0) violations.push({ file: f });
    else if (hits.length > 1) { overlaps.push({ file: f, features: hits }); attributed.push({ file: f, feature: hits.join('+') }); }
    else attributed.push({ file: f, feature: hits[0] });
  }
  return { attributed, overlaps, violations, ok: violations.length === 0 };
}

// ── REQ-E2E 覆蓋對賬（純函式可測；完成謂詞的機讀核心）──
// 把「所有 REQ-E2E-* 都真綠了」從 complete-check 的散文提示，升級成「spec 清單 vs .flow/verify 記錄」逐條對賬。
// covered 狀態：pass（真綠）或 n/a（此 journey 無法自動化、附原因）；缺記錄或 fail → 未覆蓋。
export function extractReqE2E(md) {
  const out = [], seen = new Set();
  for (const m of String(md || '').matchAll(/\bREQ-E2E-[A-Za-z0-9._-]+/gi)) {
    const id = m[0].toUpperCase();
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}
const isCoveredStatus = s => /^(pass|ok|n\/?a)$/i.test(String(s || '').trim());
export function coverageAudit(reqIds, records) {
  const byId = new Map();
  for (const r of (records || [])) { const id = String(r.id || '').toUpperCase(); if (id) byId.set(id, r); }
  const covered = [], missing = [], failed = [];
  for (const id of (reqIds || [])) {
    const r = byId.get(id.toUpperCase());
    if (!r) missing.push(id);
    else if (isCoveredStatus(r.status)) covered.push(id);
    else failed.push({ id, status: String(r.status || '?'), evidence: r.evidence || '' });
  }
  const reqSet = new Set((reqIds || []).map(x => x.toUpperCase()));
  const orphans = [...byId.keys()].filter(id => !reqSet.has(id));   // 記錄了但 spec 查無（拼錯/已刪）→ 提示不擋
  return { total: (reqIds || []).length, covered, missing, failed, orphans, ok: missing.length === 0 && failed.length === 0 };
}

// ── Playwright journey 真實性審計（純函式可測；導航版「禁 mock 假綠」的確定性節點）──
// 守 playwright-real-data-template 第四鐵則（禁 mock/網路攔截）＋第五鐵則（單一入口 goto、其後真實點擊）。
// 故意「笨但確定」——純文字掃描而非語義判斷：便宜、模型偽造不了 git 真實檔內容、不誤把單元測試的合法 mock 當違規
// （只審帶 @playwright/test 或 page.goto 的 journey 檔）。hard 擋兩條近零誤殺的鐵則；軟訊號只提醒不擋（loose 防誤殺）。
const JOURNEY_SIGNAL = /@playwright\/test|page\.goto\s*\(/;
const MOCK_PATTERNS = [
  [/\b(?:page|context)\.route\s*\(/, 'page/context.route( 攔截網路回假 response'],
  [/\bfrom\s*['"]msw(?:\/[\w-]+)*['"]|require\(\s*['"]msw(?:\/[\w-]+)*['"]\s*\)/, 'MSW 假伺服器'],
  [/\bsetupServer\s*\(/, 'setupServer( 假伺服器'],
  [/\bcy\.intercept\s*\(/, 'cy.intercept( 攔截'],
  [/\bnock\s*\(/, 'nock( 攔截 HTTP'],
  [/\bfetchMock\b/, 'fetchMock 假 fetch'],
  [/\.mockResolvedValue\s*\(|\.mockImplementation\s*\(|\.mockReturnValue\s*\(/, 'mock 假回傳值'],
];
const INTERACTION_RE = /\.click\s*\(|\.fill\s*\(|\.press\s*\(|\.check\s*\(|\.selectOption\s*\(|\.type\s*\(|\.tap\s*\(|getByRole\s*\(/;
// 把檔內容切成各 test/it 區塊（近似，無 AST）：用於「單一 test 內 goto 計數」。
function journeyTestBlocks(c) {
  const re = /\b(?:test|it)\s*(?:\.\w+)?\s*\(/g;
  const idx = []; let m;
  while ((m = re.exec(c))) idx.push(m.index);
  if (!idx.length) return [c];
  const blocks = [];
  if (idx[0] > 0) blocks.push(c.slice(0, idx[0]));                         // import/前導不含 test 的部分
  for (let i = 0; i < idx.length; i++) blocks.push(c.slice(idx[i], i + 1 < idx.length ? idx[i + 1] : c.length));
  return blocks;
}
const gotoTargets = block => [...String(block).matchAll(/\.goto\s*\(\s*[`'"]([^`'"]*)[`'"]/g)].map(m => m[1]);
export function auditJourneyTest(content) {
  const c = String(content || '');
  if (!JOURNEY_SIGNAL.test(c)) return { isJourney: false, problems: [], warnings: [] };
  const problems = [], warnings = [];
  for (const [re, label] of MOCK_PATTERNS) if (re.test(c)) problems.push(`出現${label}——E2E 真實鏈路禁 mock/攔截假後端（第四鐵則）`);
  let totalGoto = 0;
  for (const b of journeyTestBlocks(c)) {
    const gts = gotoTargets(b);
    totalGoto += gts.length;
    if (gts.length > 1) problems.push(`單一 test 內有 ${gts.length} 個 goto（${gts.join(', ')}）——應只有一個入口 goto、其後用真實點擊串接（第五鐵則）`);
    for (const t of gts) {
      const segs = t.replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0].split('/').filter(Boolean);
      if (segs.length >= 2) warnings.push(`goto('${t}') 指向深層路徑——確認是真實入口，而非 deep-link 跳關（第五鐵則）`);
    }
  }
  if (totalGoto > 0 && !INTERACTION_RE.test(c)) warnings.push('有 goto 但全檔無任何點擊/填表互動——確認真模擬了使用者操作，而非 goto+斷言抄捷徑');
  return { isJourney: true, problems, warnings };
}

// state.json.tasks 的 status 詞彙 → reconstruct 的 state 詞彙。
// /flow-plan 把完整 task 表寫進 state.json（含 in-progress/todo），但常沒同步進 manifest/ledger；
// 此映射讓「規劃了但還沒交付」的 task 也被 reconstruct 算進來，修 /flow-resume 漏算整波的盲點。
const STATE_VOCAB = {
  done: 'delivered', delivered: 'delivered',
  'in-progress': 'building', in_progress: 'building', building: 'building',
  verifying: 'verifying',
  todo: 'pending', pending: 'pending', blocked: 'blocked',
  'needs-decision': 'needs-decision', needs_decision: 'needs-decision',
};
const mapStateVocab = s => STATE_VOCAB[s] || 'pending';

// 冷啟動重建：只讀磁碟 → 還原「現況 + 未完成動作」。任何 agent / 機器跑這個就接上。
// 三來源合併（後者覆蓋前者）：manifest（規劃清單，帶 blockedBy/conflictZone）→ state.json.tasks
// （當前迭代的豐富 task 表，含未交付）→ ledger（delivered 的權威快照，journal/commit gate 寫入、偽造不了）。
export async function reconstruct(root) {
  const manifest = await readManifest(root);
  const stateJson = await readStateJson(root);
  const tasks = {};
  const order = [];                       // 穩定顯示/挑選順序：manifest → state.json → 僅 ledger
  const seen = id => { if (!order.includes(id)) order.push(id); };

  // 1) manifest 完整清單（若 flow-plan 有寫）：種 pending、保留 blockedBy
  for (const t of (manifest.tasks || [])) { tasks[t.id] = { id: t.id, state: 'pending', blockedBy: t.blockedBy || [] }; seen(t.id); }
  // 2) state.json.tasks：併入 in-progress/todo（過去 reconstruct 完全沒讀這裡 → 整波被漏）
  for (const [id, t] of Object.entries((stateJson && stateJson.tasks) || {})) {
    const prev = tasks[id] || { id };
    tasks[id] = { ...prev, id, state: mapStateVocab(t.status), blockedBy: t.blockedBy || prev.blockedBy || [], verify: t.verify || prev.verify || '' };
    seen(id);
  }
  // 3) ledger：delivered 的權威來源，最後覆蓋（granular state 以 ledger 為準）
  for (const l of await listLedger(root)) { if (!l.id) continue; tasks[l.id] = { ...(tasks[l.id] || { id: l.id }), ...l }; seen(l.id); }

  const journal = await readJournal(root);
  const open = new Map();   // action.start 沒對應 action.done；key=id|action → 並行各自獨立、不互蓋
  for (const e of journal) {
    if (e.ev === 'action.start') open.set(e.id + '|' + e.action, { id: e.id, action: e.action });
    else if (e.ev === 'action.done') open.delete(e.id + '|' + e.action);
  }
  const lessons = (await readLessons(root)).filter(L => !L.stale && (tasks[L.id] || {}).state !== 'delivered');
  const mode = (stateJson && stateJson.mode) || 'manual';   // 推進模式由檔案帶出（resume 不靠記憶判斷自駕/manual）
  return { manifest, tasks, order, dangling: [...open.values()], journalLength: journal.length, lessons, mode };
}
