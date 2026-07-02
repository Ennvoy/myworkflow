// statelib.mjs — Flow .flow/ 耐久狀態的唯一入口。
// 設計：write-ahead journal（先記再做）+ 冷啟動 reconstruct（只讀磁碟即重建現場）。
// append-only journal（用 id|action 當 key）讓 N 個並行 worker 各自的 dangling 都留得住——
// 修掉「單檔 state.json 多 worker 互蓋」硬傷。state.json 保留為當前 task 衍生指標（相容既有 hook）。
import { mkdir, readFile, writeFile, appendFile, readdir, rename, unlink } from 'node:fs/promises';
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
// 原子寫任意內容：先寫唯一暫存檔 → rename 覆蓋正式檔。當機中途只會壞在 tmp，正式檔永遠是「上一個完整版本」，
// 不再出現半寫的空檔/截斷。同卷 rename 在 POSIX 與 Windows（Node 走 MoveFileEx replace-existing）皆原子。
// tmp 名帶 pid+時戳避免並行/重啟同名碰撞；rename 失敗即清掉 tmp、不留孤兒。state.json/ledger/manifest/tasks.md 都走這支。
async function writeFileAtomic(p, content) {
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(tmp, content, 'utf8');                        // 無 BOM
    await rename(tmp, p);
  } catch (e) {
    try { await unlink(tmp); } catch { /* tmp 不存在/已清，忽略 */ }
    throw e;
  }
}
async function writeJSON(p, obj) { await writeFileAtomic(p, JSON.stringify(obj, null, 2)); }

// ── .flow/.gitignore（nested、managed block）──
// 把「耐久證據進 git、瞬時/衍生檔忽略」從散文鐵則釘成確定性檔，放在 .flow/ 內＝self-contained、隨目錄走、
// 不必動專案根 .gitignore（那支由 clean-verify-artifacts 管另一塊）。清單為相對 .flow/ 的瞬時檔：
//   state.json（當前 task 衍生指標、每動一次重寫）/ state.json.mode / monitor.port / *.log / *-reminded（ctx/size 提醒旗標）。
// 耐久證據（manifest.json / ledger/ / redteam/ / verify/ / decisions/ / journal.ndjson / lessons.ndjson / 本 .gitignore）
// 不在清單 → 照常 track（換機 clone 即 reconstruct、ship 審查讀紅軍清單）。冪等 managed block：只換自己區塊、保留使用者自訂行。
const FLOW_GITIGNORE_BLOCK = [
  '# >>> flow-state (managed by flow-toolkit) >>>',
  '# Flow runtime/衍生狀態——可從 manifest/ledger/journal 重建，勿入版控（耐久證據不在此清單、照常 track）。',
  'state.json',
  'state.json.mode',
  'monitor.port',
  '*.log',
  '*-reminded',
  '# <<< flow-state <<<',
].join('\n');

export async function ensureFlowGitignore(root) {
  const gi = path.join(dir(root), '.gitignore');
  const cur = existsSync(gi) ? await readFile(gi, 'utf8') : '';
  const re = /# >>> flow-state \(managed by flow-toolkit\) >>>[\s\S]*?# <<< flow-state <<<\n?/;
  const next = re.test(cur)
    ? cur.replace(re, FLOW_GITIGNORE_BLOCK + '\n')
    : (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + FLOW_GITIGNORE_BLOCK + '\n';
  if (next === cur) return false;
  await writeFileAtomic(gi, next);
  return true;
}

export async function init(root, manifest = {}) {
  await mkdir(ledgerDir(root), { recursive: true });
  await mkdir(decisionsDir(root), { recursive: true });
  await ensureFlowGitignore(root);               // 版控政策釘成檔（取代散文鐵則）：瞬時檔忽略、耐久證據照常 track
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

// mid-task 檢查點（修「開發中當機就重跑整個 task」）：worker 跑到某 TDD 相 / 整合階段時記一筆。
// append-only、輕量（一行 journal）、崩潰安全。冷啟動 reconstruct 取每 task「最新一筆」→ 重啟只接著沒做完的相、
// 不重跑整個 task、也不覆蓋已寫的半成品。phase 建議 red|green|refactor|integrated，非 TDD 流程可填自由字串。
export async function recordCheckpoint(root, id, phase, note) {
  await appendJournal(root, { ev: 'checkpoint', id, phase: String(phase || ''), note: String(note || '') });
}

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
// 故凍結前 SHALL：① ### 開放問題 段「存在」且收斂為零（段缺失＝帳本沒建過，恆過洞，exit 2；
//   空 /「無」/「N/A」才算零，任一實質列＝未收斂）；
//   ② 至少各 1 條 REQ-（驗收條件）/ REQ-E2E-（端到端 journey＝驗證來源）/ REQ-PERF-（效能 budget＝ship 硬閘門）；
//   ③ 無 placeholder（TODO/TBD/待定/???——需求不能留待填空白）；
//   ④ 每條 REQ-E2E 有可驗 journey 結構（單行箭頭鏈 ≥3 段，或欄位式 入口：/步驟：≥2/斷言：≥1）；
//   ⑤ REQ-PERF 標 N/A 只回報 perfNA 旗標——豁免檔對賬（.flow/decisions/perf-waiver.json）由 CLI 做，純函式不碰檔案系統。
// 另回 warnings（提醒不擋，防 Goodhart 誤殺合法表述）：REQ 行含糊詞無量化、非 E2E/PERF 的 REQ 行缺規範動詞。
// 「延後決策」不放開放問題段（移到獨立段 + flow-state decision 記錄），故 ### 開放問題 任何實質列都算未收斂。
const SPEC_NONE_RE = /^(無|（無）|\(無\)|none|n\/?a|—|–|-|\.{1,3})$/i;
const REQ_DEF_RE = /^\s*(?:[-*+]\s*)?(?:\d+[.)]\s*)?(?:\*\*)?(REQ-[A-Za-z0-9._-]+)/;   // 行首（容列點/編號/粗體）的 REQ 定義行
// placeholder：英文 TODO 只認標記形（TODO: ）——todo-list 類專案的領域名詞不誤殺；
// 待定/待補 加負向前瞻排除複合詞（待補貨/待定義）；含 zh-TW 常見變體（待確認/未定/全形？？？/TBC）。
const PLACEHOLDER_RE = /\bTODO\b\s*[:：]|\bTBD\b|\bTBC\b|\bTBA\b|\bTKTK\b|\bFIXME\b|(?:待定|待補)(?![一-鿿])|待確認|待決定|未定(?!義)|\?{3}|？{3}/i;
const VAGUE_RE = /好用|快速|迅速|高效|大量|適當|盡量|盡快|友善|直覺|流暢|\b(fast|robust|user-friendly|intuitive|scalable|performant)\b/i;
const E2E_FIELD_RE = /^\s*(?:[-*+]\s*)?(?:\*\*)?(入口|步驟|斷言)(?:\*\*)?\s*[:：]\s*(.*)$/;
const LIST_ITEM_RE = /^\s*(?:\d+[.)]|[-*+])\s+\S/;
const arrowSegs = s => String(s || '').split(/→|->/).map(x => x.trim()).filter(Boolean);
// 一條 REQ-E2E 是否有可驗 journey 結構。只認「定義行」（REQ_DEF_RE 且捕獲 id 相符）當檢查錨——
// 總覽/追溯行（「REQ-E2E-001 → REQ-E2E-002 → …」）不是萬用通行證；引用行不參與判定。
//   形 A：定義行本身是 ≥3 段箭頭鏈（入口 → … → 目標/斷言），且該行不含其他 REQ-E2E id（一行多 id＝引用非定義）
//   形 B：定義行之後（至下一個 REQ 定義行/標題前）有欄位式 入口：(非空)/步驟：(≥2 列點或箭頭鏈)/斷言：(≥1)
// 全檔找不到定義行也算 fail（只被引用、沒被定義）。
function e2eStructureOk(lines, id) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(REQ_DEF_RE);
    if (!m || m[1].toUpperCase() !== id) continue;
    const otherIds = (lines[i].match(/\bREQ-E2E-[A-Za-z0-9._-]+/gi) || []).filter(x => x.toUpperCase() !== id);
    if (!otherIds.length && arrowSegs(lines[i]).length >= 3) return true;
    let hasEntry = false, steps = 0, asserts = 0, cur = '';
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (/^#{1,6}\s/.test(l) || REQ_DEF_RE.test(l)) break;
      const f = l.match(E2E_FIELD_RE);
      if (f) {
        cur = f[1];
        const val = f[2].trim();
        if (cur === '入口' && val) hasEntry = true;
        if (cur === '步驟' && arrowSegs(val).length >= 3) steps = Math.max(steps, 2);   // 步驟欄同行箭頭鏈也算
        if (cur === '斷言' && val) asserts++;
        continue;
      }
      if (LIST_ITEM_RE.test(l)) { if (cur === '步驟') steps++; else if (cur === '斷言') asserts++; }
    }
    if (hasEntry && steps >= 2 && asserts >= 1) return true;
  }
  return false;
}
export function specReadiness(md) {
  const text = String(md || '');
  const lines = text.split(/\r?\n/);
  // 段落狀態機：開放問題段（open 計數）＋延後決策段（placeholder 降級用）。
  // 段內「更深層子標題」也算 open item（#### 是否支援 SSO？——常見排版習慣，不能被 heading 分支吞掉）。
  let inSection = false, level = 0, sawOpenSection = false;
  let inDeferred = false, defLevel = 0;
  const open = [];
  const deferredLine = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const h = raw.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (h) {
      const lv = h[1].length, title = h[2].replace(/\*\*/g, '').trim();
      if (inSection && lv <= level) inSection = false;                 // 同級或更高標題＝段結束
      if (inDeferred && lv <= defLevel) inDeferred = false;
      if (/開放問題|open\s*questions/i.test(title)) { inSection = true; sawOpenSection = true; level = lv; }
      else if (/延後決策|deferred/i.test(title)) { inDeferred = true; defLevel = lv; }
      else if (inSection && !SPEC_NONE_RE.test(title)) open.push(title);   // 段內子標題＝一個開放問題
      deferredLine[i] = inDeferred;
      continue;
    }
    deferredLine[i] = inDeferred;
    if (!inSection) continue;
    const body = raw.replace(/\*\*/g, '').replace(/^\s*[-*+]\s*/, '').replace(/^\s*\d+[.)]\s*/, '').trim();
    if (!body || SPEC_NONE_RE.test(body)) continue;                    // 空行 /「無」/「N/A」＝零
    open.push(body);
  }
  const problems = [], warnings = [];
  if (!sawOpenSection) problems.push('查無「### 開放問題」段——訪談帳本 SHALL 存在（整段不寫＝閘門看不見任何未決項＝恆過洞）；真的零開放問題就寫「### 開放問題」＋「無」');
  if (open.length) problems.push(`### 開放問題 還有 ${open.length} 項未收斂——凍結前 SHALL 清零（解決成 REQ/EARS，或移到「延後決策」段並 flow-state decision 記錄）`);
  if (!/\bREQ-/.test(text))       problems.push('查無任何 REQ- 驗收條件（requirements.md 形同空殼）');
  if (!/\bREQ-E2E-/i.test(text))  problems.push('查無 REQ-E2E-*（缺可 demo 的端到端 journey＝Phase 4/5 沒驗證來源）');
  if (!/\bREQ-PERF-/i.test(text)) problems.push('查無 REQ-PERF-*（缺效能 budget；真無效能敏感路徑須寫 REQ-PERF-001：N/A 並經使用者拍板 flow-state decision perf-waiver 留檔）');
  // placeholder：延後決策段內（本就要求逐項 decision 留檔）降 warning、不整段豁免（防「TODO 全倒進該段洗閘門」）。
  const ph = [];
  lines.forEach((l, i) => {
    if (!PLACEHOLDER_RE.test(l)) return;
    if (deferredLine[i]) warnings.push(`${i + 1} 行（延後決策段）含 placeholder 字樣——確認該項已 flow-state decision 留檔（附 AI 建議預設）`);
    else ph.push(`${i + 1} 行：${l.trim().slice(0, 60)}`);
  });
  if (ph.length) problems.push(`發現 ${ph.length} 處 placeholder（TODO:/TBD/待定/待確認/???）——需求不能留待填空白：問清楚拍板成 REQ/EARS，或改寫措辭（附 AI 建議預設）移入 ### 延後決策 段並 flow-state decision 記錄：` + ph.slice(0, 8).map(s => `\n      · ${s}`).join(''));
  for (const id of extractReqE2E(text)) {
    if (!e2eStructureOk(lines, id)) problems.push(`${id} 缺可驗 journey 結構（定義行不合格或只被引用沒被定義）——定義行寫成單行箭頭鏈「入口 → … → 斷言」（≥3 段），或欄位式「入口：/步驟：（≥2 步）/斷言：」（範本見 references/ears-cheatsheet.md）`);
  }
  // REQ-PERF 未量化偵測（逐定義行區塊）：整塊無任何數字（budget 沒量化，含 N/A/不適用/同義洗白），
  // 或定義塊明寫 N/A（限斜線/全形形；裸 NA 可能是區域縮寫不誤中）→ perfNA=true，CLI 端要求 perf-waiver。
  let perfNA = false;
  const blockEnd = (i) => { let j = i + 1; while (j < lines.length && !/^#{1,6}\s/.test(lines[j]) && !REQ_DEF_RE.test(lines[j])) j++; return j; };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(REQ_DEF_RE);
    if (!m || !/^REQ-PERF-/i.test(m[1])) continue;
    const block = [lines[i].slice(m[0].length), ...lines.slice(i + 1, blockEnd(i))].join('\n');
    if (!/\d/.test(block) || /\bN\/A\b|Ｎ／Ａ|不適用/i.test(block)) perfNA = true;
  }
  // 表述品質提醒（僅 warning）：規範動詞看「定義行＋其後內文區塊」任一行即可（標題行式 REQ 不誤殺）；
  // 追溯/對照行（rest 以 →/-> 開頭）跳過；每個 id 每類只警告一次。
  const warned = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(REQ_DEF_RE);
    if (!m) continue;
    const id = m[1];
    const rest = lines[i].slice(m[0].length);      // id 之後的句子（id 本身含數字，不能拿整行測「無量化」）
    if (/^\s*(?:\*\*)?\s*(?:→|->)/.test(rest)) continue;               // 追溯行「REQ-001 → F-1」非定義
    const isE2E = /^REQ-E2E-/i.test(id), isPerf = /^REQ-PERF-/i.test(id);
    const vague = rest.match(VAGUE_RE);
    if (vague && !/\d/.test(rest) && !warned.has(id + '|vague')) {
      warned.add(id + '|vague');
      warnings.push(`${i + 1} 行 ${id} 含含糊詞「${vague[0]}」且無量化數字——建議補可驗的數字/單位`);
    }
    if (!isE2E && !isPerf && !warned.has(id + '|verb')) {
      const blockLines = [rest, ...lines.slice(i + 1, blockEnd(i))];
      if (!blockLines.some(l => /應|須|SHALL|MUST/i.test(l))) {
        warned.add(id + '|verb');
        warnings.push(`${i + 1} 行 ${id} 缺規範動詞（應/須/SHALL/MUST，含其後內文）——不像可驗收的 EARS 句`);
      }
    }
  }
  return { open, problems, warnings, perfNA };
}

// ── 專案類型正門（W0-5）：Step 1 彈窗拍板後 flow-state project-type 落檔；--freeze 對賬這筆記錄。──
// web 類（含 mobile：走垂直切片＋互動原型）凍結時 SHALL 有原型或 mockup-waiver 豁免檔；
// 非 web 的 enum 記錄本身即豁免（不再造「豁免的豁免」）。
export const PROJECT_TYPES = ['web-saas', 'web-app', 'mobile', 'cli', 'api', 'data-pipeline', 'library', 'framework', 'desktop-gui'];
export const WEB_PROJECT_TYPES = ['web-saas', 'web-app', 'mobile'];

// ── 紅軍高危攻擊面判定（W0-6，純函式可測）：命中者禁無痕跳過（skipped 須 decision 豁免檔）。──
// 三組制降誤中（「prompt 超過 token 上限」「依賴注入順序」這類工程語境不觸發）：
//   (a) 強訊號詞單獨即觸發（幾乎必為安全面）；
//   (b) 低訊號 domain 名詞（auth/login/token/session/payment…）須與攻擊動詞（bypass/偽造/竊取/未登入…）同文共現；
//   (c) 「注入」須與 SQL/script/命令/惡意 等語境共現（排除依賴注入）。
// 英文詞帶 word boundary（author/repayment 不誤中）；方向仍 fail-safe：誤中代價＝多留一筆可稽核豁免。
const RISK_STRONG_RE = /\b(injection|sqli|xss|csrf|idor|ssrf|rce|privilege|credential)s?\b|越權|提權|個資|金流|竄改|盜用|冒用/i;
const RISK_DOMAIN_RE = /\b(auth|login|token|session|payment|admin|account|password)s?\b|權限|登入|後台|帳號|密碼|他人|付費/i;
const RISK_VERB_RE = /\b(bypass|forge[dr]?|steal|stolen|replay|hijack|escalat\w*|spoof\w*|tamper\w*|unauthori[sz]ed|takeover|impersonat\w*|leak\w*|brute)\b|繞過|偽造|竊取|盜|劫持|外洩|冒用|未授權|未登入|明文/i;
const RISK_INJECT_CTX_RE = /SQL|script|命令|指令|惡意|payload|XSS/i;
export function isHighRiskAttackText(text) {
  const s = String(text || '');
  if (RISK_STRONG_RE.test(s)) return true;
  if (RISK_DOMAIN_RE.test(s) && RISK_VERB_RE.test(s)) return true;
  if (/注入/.test(s) && RISK_INJECT_CTX_RE.test(s)) return true;
  return false;
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
    // 堵 stale 綠燈白嫖（崩潰版）：綠燈若屬於「別的 task」（前一 task 交付後當機、verifyTaskId 沒歸零殘留），
    // 不准這個 task 借來過閘門。寫入/比對都用 canonical id，嚴格 !==（不用 idMatches——其尾段容錯會把
    // W0-5 誤配 F-1186-W0-5 反而放行白嫖）。向後相容：舊專案/沒寫 verifyTaskId（空/none）→ 不擋，退回原行為。
    const vt = String(st.verifyTaskId || '').trim();
    if (vt && !isNoneVal(vt) && vt !== id) {
      const e = new Error([
        `Flow done gate：「${id}」想用的驗證綠燈其實屬於「${vt}」、不是這個 task。`,
        '  多半是上一個 task 交付後當機、綠燈沒歸零殘留——別讓這個 task 白嫖它。',
        `  先為「${id}」自己跑 /flow-verify 真跑綠（會覆蓋成本 task 的綠燈），再 done。`,
      ].join('\n'));
      e.code = 'VERIFY_GATE';
      throw e;
    }
  }
  let flip = { found: false, changed: false };
  const tp = tasksMdPath(root);
  if (existsSync(tp)) {
    const md = await readFile(tp, 'utf8');
    flip = flipCheckbox(md, id);
    if (flip.changed) await writeFileAtomic(tp, flip.text);   // 原子寫，UTF-8 無 BOM（堵半寫壞 tasks.md）
  }
  if (from !== 'delivered' || patch.commit) await transition(root, id, from, 'delivered', patch);
  if (from !== 'delivered') {
    const st = await readStateJson(root);
    await writeStateJson(root, { ...st, verify: 'none', tdd: 'none', verifyTaskId: 'none' });  // 交付即歸零（含 verifyTaskId），堵 stale 綠燈白嫖
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

// ── 互動原型走查對賬（純函式可測；mockup-check 閘門核心）──
// 「mockup 片面、要靠想像」的病根是覆蓋缺漏：機檢 index.html 走查台是否列出每條 REQ-E2E journey，
// 並抽出走查台連到的本地 .html 頁（呼叫端驗實存；連結 404 ＝ 假走查）。故意「笨但確定」——
// 純文字掃描：原型好不好看仍由使用者開瀏覽器點過後彈窗定版，這裡只守「覆蓋骨架完整」的機讀底線。
export function mockupAudit(requirementsMd, indexHtml) {
  const reqIds = extractReqE2E(requirementsMd);
  const upper = String(indexHtml || '').toUpperCase();
  const missingReq = reqIds.filter(id => !upper.includes(id));      // extractReqE2E 已 canonical 大寫
  const hrefs = [], seen = new Set();
  for (const m of String(indexHtml || '').matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const raw = m[1].trim();
    if (/^(https?:|\/\/|\/|mailto:|tel:|#|javascript:|data:)/i.test(raw)) continue;   // 外部/絕對/錨點不驗
    const local = raw.split(/[#?]/)[0].replace(/\\/g, '/');
    if (!/\.html?$/i.test(local) || seen.has(local)) continue;
    seen.add(local); hrefs.push(local);
  }
  return { reqIds, missingReq, hrefs };
}

// 走查台連到的每一頁的空殼檢查（W0-8，純函式）：堵「index.html 有卡但頁面是空殼」——
// 每頁 SHALL 引用共用假資料層 app.js（prototype-guide：CRUD 才有後果）且含 ≥1 互動元素。
// 故意笨（純文字掃描）：擋的是零互動的空殼，好不好用仍由使用者真點過後定版。
export function mockupPageProblems(html) {
  const c = String(html || '');
  const problems = [];
  if (!/app\.js/i.test(c)) problems.push('未引用共用假資料層 app.js（prototype-guide：每頁掛同一份假資料層，CRUD 才有後果）');
  if (!/<form\b|<button\b|<input\b|<select\b|<textarea\b|<a\s[^>]*href\s*=/i.test(c)) problems.push('無任何互動元素（form/button/input/連結）——空殼頁不算可走查的互動原型');
  return problems;
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
  const checkpoints = {};   // 每 task 的最新 checkpoint（時序後者覆蓋前者）→ mid-task 接續「上次做到第幾步」
  for (const e of journal) {
    if (e.ev === 'action.start') open.set(e.id + '|' + e.action, { id: e.id, action: e.action });
    else if (e.ev === 'action.done') open.delete(e.id + '|' + e.action);
    else if (e.ev === 'checkpoint' && e.id) checkpoints[e.id] = { phase: e.phase || '', note: e.note || '', at: e.at || e.t || '' };
  }
  // 半寫的最後一行 journal 會被 readJournal 丟掉 → 退回前一個 checkpoint（寧可接續較早的相、不可跳過沒做完的）。
  for (const id of Object.keys(checkpoints)) { if (tasks[id]) tasks[id].checkpoint = checkpoints[id]; }
  const lessons = (await readLessons(root)).filter(L => !L.stale && (tasks[L.id] || {}).state !== 'delivered');
  const mode = (manifest && manifest.mode) || (stateJson && stateJson.mode) || 'manual';   // 優先 git-tracked manifest（換機 clone 後自駕不掉回 manual）；相容舊的 state.json.mode
  return { manifest, tasks, order, dangling: [...open.values()], journalLength: journal.length, lessons, mode };
}

// 下一個可推進 task：非 delivered/needs-decision、且 blockedBy 已全 delivered（純函式；resume 與 hook 共用）。
// 順序來源：manifest（若有，帶 conflictZone-aware 排序）否則 reconstruct 合併出的 order（含 state.json 未交付 task）。
export function pickNext(view) {
  const done = id => (view.tasks[id] || {}).state === 'delivered';
  const manifestById = Object.fromEntries(((view.manifest || {}).tasks || []).map(t => [t.id, t]));
  const ids = ((view.manifest || {}).tasks && view.manifest.tasks.length)
    ? view.manifest.tasks.map(t => t.id)
    : (view.order && view.order.length ? view.order : Object.keys(view.tasks || {}));
  for (const id of ids) {
    const t = (view.tasks || {})[id] || { state: 'pending' };
    const s = t.state || 'pending';
    if (s === 'delivered' || s === 'needs-decision') continue;
    const blockedBy = t.blockedBy || (manifestById[id] || {}).blockedBy || [];
    if ((s === 'pending' || s === 'blocked') && !blockedBy.every(done)) continue;
    return { id, state: s };
  }
  return null;
}

// ── 純檔案對帳（resume 諮詢用，只提示不擋）：tasks.md 的 [x] vs ledger 的 delivered ──
// ledger = 唯一真相（gate 寫入、偽造不了）；tasks.md [x] 為衍生。崩潰在 markTaskDone 跨檔三步中途會留分歧，
// 偵測出來提示使用者跑 `flow-state done <id>`（冪等）重同步即可修復。canonical id 精確比對。
export function reconcile(tasksMd, ledgerList) {
  const checked = [], unchecked = [];
  for (const line of String(tasksMd || '').split(/\r?\n/)) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const id = lineId(m[4]);
    if (!id) continue;
    (m[2] === ' ' ? unchecked : checked).push(id);
  }
  const deliveredIds = (ledgerList || []).filter(l => l.state === 'delivered').map(l => l.id);
  const deliveredSet = new Set(deliveredIds);
  const uncheckedSet = new Set(unchecked);
  return {
    checkedButNotDelivered: checked.filter(id => !deliveredSet.has(id)),     // 翻了 [x] 但 ledger 沒 delivered（flip 成功、transition 掉了）
    deliveredButNotChecked: deliveredIds.filter(id => uncheckedSet.has(id)), // ledger delivered 但 tasks.md 還 [ ]（transition 成功、flip 掉了）
    deliveredNoCommit: (ledgerList || []).filter(l => l.state === 'delivered' && !l.commit).map(l => l.id), // 已交付但 ledger 沒記 commit sha（可能 done 後 commit 前當機）
  };
}

// 把 reconstruct 的 view 變成人讀摘要行（resume 與 SessionStart hook 共用，單一事實來源）。
// 純函式（不碰 git/檔案）；git/對帳由呼叫端（resume）另補。回傳 string[]，呼叫端各自加標題。
export function summarizeView(view) {
  const tasks = Object.values((view && view.tasks) || {});
  const by = s => tasks.filter(t => t.state === s).length;
  const L = [];
  L.push(`已交付 ${by('delivered')}/${tasks.length} | 開發中 ${by('building')} | 驗收中 ${by('verifying')} | 待開發 ${by('pending') + by('blocked')} | ⚠️ 等你決策 ${by('needs-decision')}`);
  L.push(`推進模式：${view.mode === 'auto' ? '🤖 自駕（spec 定版後自動推進、只 T1 分歧停；resume 續跑自駕，不每階段問）' : '🙋 每階段停（manual）'}`);
  const need = tasks.filter(t => t.state === 'needs-decision');
  if (need.length) { L.push('', '⚠️ 等你決策（回 Claude 以彈窗拍板）：'); for (const t of need) L.push(`   - ${t.id}：${t.decision || '需要你決策'}`); }
  // mid-task 進度：開發中 task 上次做到第幾步（崩潰重啟只補沒做完的相，不重跑整個 task）
  const building = tasks.filter(t => t.state === 'building' && t.checkpoint && t.checkpoint.phase);
  if (building.length) {
    L.push('', '⏳ 上次做到第幾步（接續只補沒做完的相、別重做整個 task、別覆蓋半成品）：');
    for (const t of building) L.push(`   - ${t.id}：${t.checkpoint.phase}${t.checkpoint.note ? `（${t.checkpoint.note}）` : ''}`);
  }
  if ((view.dangling || []).length) { L.push('', '↻ 未完成動作（對帳會冪等補做）：'); for (const d of view.dangling) L.push(`   - ${d.id} → ${d.action}`); }
  if ((view.lessons || []).length) { L.push('', '⚠️ 已知死路（再生計畫別重走、見 .flow/lessons.ndjson）：'); for (const ls of view.lessons) L.push(`   - ${ls.id}：${ls.failedApproach || '?'} ✗ ${ls.why || ''}`); }
  const next = pickNext(view);
  L.push('', `下一步：${next ? `推進 ${next.id}（${next.state} → 下一階段）` : (need.length ? '等你決策後才有得做' : '無可推進（全部完成或卡依賴）')}`);
  return L;
}

// 開場精簡提醒（SessionStart hook 用）：只在「真的還有事要接」時回一行；全部出貨完 → hasWork=false（hook 靜默）。
// 純函式。「有事」= 還有可推進 task ∨ 有等你決策 ∨ task 全交付但還沒 ship（phase≠shipped）。完整進度由 /flow-resume 的 summarizeView 印。
export function briefStatus(view) {
  const tasks = Object.values((view && view.tasks) || {});
  const c = { delivered: 0, building: 0, pending: 0, needsDecision: 0 };
  for (const t of tasks) {
    if (t.state === 'delivered') c.delivered++;
    else if (t.state === 'building') c.building++;
    else if (t.state === 'needs-decision') c.needsDecision++;
    else c.pending++;                          // pending/blocked/verifying 都算「還沒交付」
  }
  const phase = (view && view.manifest && view.manifest.phase) || '?';
  const allDelivered = tasks.length > 0 && c.delivered === tasks.length;
  const danglingN = (view && view.dangling && view.dangling.length) || 0;
  const hasWork = !!pickNext(view) || c.needsDecision > 0 || (allDelivered && phase !== 'shipped') || danglingN > 0;
  if (!hasWork) return { hasWork: false, line: '' };
  const bits = [];
  if (c.building) bits.push(`開發中 ${c.building}`);
  if (c.pending) bits.push(`待開發 ${c.pending}`);
  if (c.needsDecision) bits.push(`⚠️ ${c.needsDecision} 個等你決策`);
  if (danglingN) bits.push(`↻ ${danglingN} 個未完成動作`);
  if (allDelivered && phase !== 'shipped') bits.push('task 全交付、待驗證/出貨');
  return { hasWork: true, line: `⚡ 有未完成的 Flow（phase=${phase}${bits.length ? '；' + bits.join('、') : ''}）→ 打 /flow-resume 看完整進度並接續。` };
}
