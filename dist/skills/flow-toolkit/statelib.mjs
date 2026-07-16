// statelib.mjs — Flow .flow/ 耐久狀態的唯一入口。
// 設計：write-ahead journal（先記再做）+ 冷啟動 reconstruct（只讀磁碟即重建現場）。
// append-only journal（用 id|action 當 key）讓 N 個並行 worker 各自的 dangling 都留得住——
// 修掉「單檔 state.json 多 worker 互蓋」硬傷。state.json 保留為當前 task 衍生指標（相容既有 hook）。
import { mkdir, readFile, writeFile, appendFile, readdir, rename, unlink, stat } from 'node:fs/promises';
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
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);   // strip BOM（PS5.1 utf8 帶 BOM）
  } catch { return fallback; }
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
// 耐久證據（manifest.json / ledger/ / redteam/ / verify/ / decisions/ / spec-review/ / trace/ / code-review/ / reports/ / journal.ndjson / lessons.ndjson / 本 .gitignore）
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
  // 排除 perf-*.json（perf 走 readPerfRecord 專徑）——否則污染 coverageAudit 的 orphan 警告。
  for (const f of await readdir(d)) if (f.endsWith('.json') && !f.startsWith('perf-')) out.push(await readJSON(path.join(d, f), {}));
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

// ── journal 歸檔（W4-4「歸檔不刪」）：append-only 流水帳無上限成長會讓 stall/done/reconstruct 每次 O(全史) 重讀，
// 長程自駕單調變慢。把「已 delivered task 的任務域事件」搬 .flow/archive/journal.ndjson（append、可回溯），
// 主檔只留未終局＋全域事件（spec.*/code.*/decision 一律留）。另對「無 taskId 的 verify.attempt」（stall-monitor 桶）
// 保尾 cap——stallCount 只看尾端連續段，保最近 400 筆綽綽有餘。先落歸檔再原子重寫主檔（當機頂多重複、不丟）。
const TASK_SCOPED_EVS = new Set(['verify.attempt', 'task.transition', 'action.start', 'action.done', 'checkpoint', 'lesson']);
const JOURNAL_ATTEMPT_CAP = 400;
export async function archiveJournal(root, deliveredIds) {
  const delivered = new Set((deliveredIds || []).map(String));
  const p = journalPath(root);
  if (!existsSync(p)) return { archived: 0, kept: 0 };
  const lines = (await readFile(p, 'utf8')).split('\n').filter(Boolean);
  const keep = [], move = [];
  for (const l of lines) {
    let e = null;
    try { e = JSON.parse(l); } catch { keep.push(l); continue; }               // 壞行保守留主檔
    const taskKey = e && (e.taskId || e.id);
    if (e && TASK_SCOPED_EVS.has(e.ev) && taskKey && delivered.has(String(taskKey))) move.push(l);
    else keep.push(l);
  }
  // 桶型 verify.attempt（無 taskId）保尾 cap：只留最近 N 筆，更舊的搬歸檔。
  const bucketIdx = [];
  for (let i = 0; i < keep.length; i++) {
    try { const e = JSON.parse(keep[i]); if (e.ev === 'verify.attempt' && !e.taskId) bucketIdx.push(i); } catch { /* keep */ }
  }
  if (bucketIdx.length > JOURNAL_ATTEMPT_CAP) {
    const drop = new Set(bucketIdx.slice(0, bucketIdx.length - JOURNAL_ATTEMPT_CAP));
    for (const i of drop) move.push(keep[i]);
    for (let i = keep.length - 1; i >= 0; i--) if (drop.has(i)) keep.splice(i, 1);
  }
  if (!move.length) return { archived: 0, kept: keep.length };
  await mkdir(path.join(dir(root), 'archive'), { recursive: true });
  await appendFile(path.join(dir(root), 'archive', 'journal.ndjson'), move.join('\n') + '\n', 'utf8');
  await writeFileAtomic(p, keep.length ? keep.join('\n') + '\n' : '');
  return { archived: move.length, kept: keep.length };
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

// C-13：flow-state 閘門子命令連紅偵測（複審/計畫/完成謂詞等）。**只給 stall-monitor 軟 STALL 用**（提醒換路），
// 刻意不併進 isRunnerCommand——否則 auto-gate 硬天花板會把「檢查完成的那條命令」也硬擋掉，反而 deadlock。
const GATE_RE = /\bflow-state(?:\.mjs)?\s+(complete-check|plan-check|spec-ready|redteam|scope|journey-check|review-check|code-check|coverage|verify-e2e|verify-perf)\b/i;
export function isGateThrash(cmd) { return GATE_RE.test(String(cmd || '')); }

// 把 runner 命令正規化成穩定的「失敗分桶 key」：去 flag、小寫、壓空白。
// 同一條測試重跑→同 bucket；不同測試/檔→不同 bucket。cwd 已由 .flow 位置隔離專案。
// C-13：把 `cd <dir> && …` 前綴摺進 key（保留 <dir> 防 monorepo 不同子專案誤併同桶）、npm/pnpm/yarn/bun run <s> ≡ <pm> <s>、
// 去掉 && / ; 串接的前置指令只留真正 runner——讓「同一條 runner 換寫法/加 cd/加 flag」穩定同桶、doom-loop 連敗不被歸零。
export function runnerBucket(cmd) {
  let s = String(cmd || '').trim();
  let cdTarget = '';
  const cdm = s.match(/^cd\s+(\S+)\s*(?:&&|;)\s*(.+)$/i);
  if (cdm) { cdTarget = cdm[1].replace(/["']/g, ''); s = cdm[2]; }
  const parts = s.split(/\s*(?:&&|;)\s*/).filter(Boolean);        // 取最後一段＝真正的 runner（去前置 export/echo 等）
  if (parts.length) s = parts[parts.length - 1];
  s = s.replace(/\b(npm|pnpm|yarn|bun)\s+run\s+/i, '$1 ');        // run 是可選語法糖
  const norm = s.split(/\s+/).filter(t => t && !t.startsWith('-')).join(' ').toLowerCase().slice(0, 200);
  return (cdTarget ? cdTarget.toLowerCase() + '|' : '') + (norm || '_runner');
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
// taskId（選填）：flow-state run --task 走這條——把 attempt 綁到 task，done 閘門據此對賬「這個 task 真跑綠了」。
// stall-monitor 不帶 taskId（生產不寫 state.task），故其 stallCount 只吃 bucket 相符的；兩用途分流不互擾。
export async function recordVerifyAttempt(root, id, sig, exit, taskId) {
  await appendJournal(root, { ev: 'verify.attempt', id, sig, exit, ...(taskId ? { taskId } : {}) });
}
// done 閘門：某 task 是否有「曾經跑紅、且該 runner（bucket）最後一次仍非綠」的 attempt（純函式）。
// 回 <bucket 字串>（還紅的那條 runner）／null（沒走 run，或每條跑過的 runner 最後都綠）。
//   ① taskId **canonical 嚴格相等**（不用 idMatches——尾段容錯會讓別 task 的紅 runner 誤擋，與 verifyTaskId 同源理由）；
//   ② 逐 bucket 取「最後一筆」——換一條 no-op 命令跑綠不會清掉原 failing runner 的紅（bucket 不同），
//      也擋「npm test 紅 → 改跑 npm run typecheck 綠」的無意洗綠（原 test suite 從沒重跑綠）。
export function taskRunnerRed(journal, taskId) {
  const byBucket = new Map();
  for (const e of (journal || [])) if (e && e.ev === 'verify.attempt' && e.taskId && e.taskId === taskId) byBucket.set(e.id, e.sig);
  for (const [bucket, sig] of byBucket) if (sig !== 'ok') return bucket;
  return null;
}
// verify 欄位格式（done 閘門＋flow-verify-gate 共用單一事實來源）：SHALL 是 ok:<ref>（冒號後可空白，帶真證據 ref）。
// 擋裸 'ok'/'passed'/'done' 無 ref 的自報字串；容忍 'ok: <ref>' 自然寫法（原 /^ok:\S/ 誤殺冒號後空格）。
export function isValidVerify(v) { return /^ok:\s*\S/i.test(String(v ?? '').trim()); }

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
// 從 REQ 定義行 index i 掃到下一個 REQ 定義行/標題（不含）為止，回區塊結束 index j
// （specReadiness 的 PERF 未量化偵測/規範動詞偵測、extractReqBlock、reqPerfBlock 三處同款切界，共用同一掃描邏輯）。
function reqBlockEnd(lines, i) {
  let j = i + 1;
  while (j < lines.length && !/^#{1,6}\s/.test(lines[j]) && !REQ_DEF_RE.test(lines[j])) j++;
  return j;
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
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(REQ_DEF_RE);
    if (!m || !/^REQ-PERF-/i.test(m[1])) continue;
    const block = [lines[i].slice(m[0].length), ...lines.slice(i + 1, reqBlockEnd(lines, i))].join('\n');
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
      const blockLines = [rest, ...lines.slice(i + 1, reqBlockEnd(lines, i))];
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

// ── spec 審查 lens ledger（第 1 波）：訪談多角度 review 的機讀痕跡 ──
// 設計：lens 綁「互異機制」（redteam＝對抗目標函數、consistency＝斷開 context 全集推理、codex＝跨模型家族
// opportunistic）而非換 persona（Nine Judges：同模型換提示詞 9 評審 ≈ 2.18 張獨立票＝假多角度）。
// docHash 由 CLI 收檔時自算（模型不可自填）＝「這輪審的是哪個版本的文字」是機器事實；
// findings 一旦落檔就只能走四種終局（resolved/open/deferred/rejected，各附機器可驗指標）、無法無痕蒸發。
// 誠實邊界：ledger「出處」不可機器證明（模型可不 spawn subagent 自編 findings）——防懶不防蓄意欺騙，
// 偽造成本＝編一整份結構化連環謊＋git 審計線可稽，與手改 state.json 同級。
export const SPEC_REVIEW_LENSES = ['redteam', 'consistency', 'codex'];
export const REQUIRED_SPEC_LENSES = ['redteam', 'consistency'];
export const SPEC_REVIEW_ROUND_CAP = 3;

// 行尾正規化後雜湊：docHash 語意是「文字版本」非「位元組版本」——git autocrlf/Windows 編輯器翻行尾
// 不該讓全 lens 末輪假性 stale（換機 clone 接手是本 harness 主軸，不能跟它打架）。
export function sha256Text(s) { return createHash('sha256').update(String(s || '').replace(/\r\n?/g, '\n'), 'utf8').digest('hex'); }

const specReviewDir = root => path.join(dir(root), 'spec-review');
const specResolutionsPath = root => path.join(specReviewDir(root), 'resolutions.json');

// findings 檔形狀驗證（模型自報內容，CLI 收檔前擋壞形狀；round/docHash 由 CLI 覆寫、不信自填）。
// id 前綴綁 lens（redteam→SR-RT-、consistency→SR-CS-、codex→SR-CX-）——resolutions 以 id 為全域 key，
// 跨 lens 撞號會讓一筆終局同時吃掉兩條不同質疑（無痕蒸發），結構上直接堵；跨輪撞號由 CLI 收檔時全域查重擋。
export const SPEC_LENS_ID_PREFIX = { redteam: 'SR-RT-', consistency: 'SR-CS-', codex: 'SR-CX-' };
export function validateSpecReviewFindings(obj, lens) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['不是 JSON 物件'];
  const problems = [];
  if (obj.lens && obj.lens !== lens) problems.push(`檔內 lens「${obj.lens}」與命令列 lens「${lens}」不符`);
  if (!Array.isArray(obj.findings)) return [...problems, '缺 findings 陣列（零發現要給空陣列 []，不是省略欄位——「沒看」與「看過且乾淨」要可分）'];
  const prefix = SPEC_LENS_ID_PREFIX[lens] || 'SR-';
  const seen = new Set();
  obj.findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (!f || typeof f !== 'object') { problems.push(`${at} 不是物件`); return; }
    const id = String(f.id || '').toUpperCase();
    if (!id.startsWith(prefix) || !/^SR-[A-Z]{2}-[A-Za-z0-9._-]+$/i.test(id)) problems.push(`${at} id 須為 ${prefix}<流水號>（如 ${prefix}001）——前綴綁 lens，防跨 lens 撞號蒸發質疑`);
    else if (seen.has(id)) problems.push(`${at} id 重複：${f.id}`);
    else seen.add(id);
    if (!String(f.claim || '').trim()) problems.push(`${at} 缺 claim（具體質疑，含 REQ 錨點）`);
    if (!['high', 'medium', 'low'].includes(String(f.severity || '').toLowerCase())) problems.push(`${at} severity 須為 high/medium/low`);
  });
  return problems;
}

// 開放問題段是否有帶 [findingId] 標籤的 bullet（open 終局的機器指標；之後由既有 spec-ready 逼清零＝逼到彈窗問使用者）
export function openSectionHasTag(md, findingId) {
  const lines = String(md || '').split(/\r?\n/);
  const tag = '[' + String(findingId).toUpperCase() + ']';
  let inSection = false, level = 0;
  for (const raw of lines) {
    const h = raw.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (h) {
      const lv = h[1].length, title = h[2].replace(/\*\*/g, '').trim();
      if (inSection && lv <= level) inSection = false;
      if (/開放問題|open\s*questions/i.test(title)) { inSection = true; level = lv; continue; }
      // 段內子標題也算 open item（specReadiness 同款）——tag 掛在子標題上同樣有效，別造成
      // 「算未收斂卻登記不了 open」的死結
      if (inSection && raw.toUpperCase().includes(tag)) return true;
      continue;
    }
    if (inSection && raw.toUpperCase().includes(tag)) return true;
  }
  return false;
}

// 單筆終局驗證（純函式；decisionExists 注入、不碰 fs）：回 null＝合法，否則錯誤訊息。
// opts.findingDocHash + opts.currentHash（皆給時）：resolved 要求文件在 finding 落檔後有變動——
// 「指回被批評、一字未改的既有 REQ」不算解決（質疑不成立的正路是 rejected）。
export function specResolutionProblem(findingId, asStr, requirementsMd, decisionExists, opts = {}) {
  const s = String(asStr || '').trim();
  let m;
  if ((m = s.match(/^resolved:(REQ-[A-Za-z0-9._-]+)$/i))) {
    const re = new RegExp('\\b' + m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (!re.test(String(requirementsMd || ''))) return `resolved 指向的 ${m[1]} 不存在於 requirements.md（id 打錯？先把質疑真的落成 REQ）`;
    if (opts.findingDocHash && opts.currentHash && opts.findingDocHash === opts.currentHash)
      return `finding 落檔後 requirements.md 無任何變動——先把質疑真的落成/改寫 REQ 再 resolved；質疑本身不成立走 rejected:<decisionId>`;
    return null;
  }
  if (/^open$/i.test(s)) {
    return openSectionHasTag(requirementsMd, findingId) ? null
      : `標記 open 但「### 開放問題」段查無帶 [${String(findingId).toUpperCase()}] 標籤的 bullet——答案已落地就改 resolved:REQ-xxx，還沒問就把 bullet 補回去`;
  }
  if ((m = s.match(/^(deferred|rejected):([^\s\\/]+)$/i))) {
    if (m[2].includes('..')) return `decisionId 不得含 ..`;
    return decisionExists(m[2]) ? null : `${m[1]} 指向的 decision「${m[2]}」不存在——先 flow-state decision ${m[2]} --choice "…" --why "…" 留檔`;
  }
  return `不合法的終局「${s}」——須為 resolved:REQ-xxx / open / deferred:<decisionId> / rejected:<decisionId>`;
}

// review-check 核心（純函式）：每條 finding 都要有終局且指標當下仍有效——發現不能無痕蒸發。
// currentHash（選填）：給了就對 resolved 加「文件有進展」錨點（finding 所屬輪的 docHash ≠ 現行）。
// frozenAt（選填）：最後一次 spec.frozen 時戳。落檔於該時點之前的輪＝上個週期的歷史 findings——
// 當時 freeze 已對現行文件全終局對賬過（凍結事件即證據），其 resolved 指向的 REQ 會隨迭代歸檔而
// 不在新 requirements.md，對「現行」文件重驗必偽陽性擋死新迭代。故歷史輪只驗「終局存在」
// （不可蒸發不放鬆），指標有效性重驗只吃當前週期的輪。
export function reviewCheckAudit(ledgers, resolutions, requirementsMd, decisionExists, currentHash, frozenAt = '') {
  const problems = [];
  const res = {};
  for (const [k, v] of Object.entries(resolutions || {})) res[k.toUpperCase()] = v;
  for (const rec of (ledgers || [])) {
    const historical = !!frozenAt && (rec.at || '') <= frozenAt;
    for (const f of (rec.findings || [])) {
      const id = String(f.id || '').toUpperCase();
      const r = res[id];
      if (!r) { problems.push(`${id}（${rec.lens} r${rec.round}，${f.severity}）未終局——flow-state review-resolve ${id} --as <resolved:REQ-xxx|open|deferred:<id>|rejected:<id>>`); continue; }
      if (historical) continue;
      const p = specResolutionProblem(id, r.as, requirementsMd, decisionExists, { findingDocHash: rec.docHash, currentHash });
      if (p) problems.push(`${id}：${p}`);
    }
  }
  return problems;
}

// 凍結側收斂判準（純函式）：required lens 各 ≥2 輪且末輪零新發現（或滿 cap 輪封頂＝防「審查者永遠找得到新毛病」
// 的死循環，剩餘 findings 仍須全終局）；末輪 docHash SHALL 等於現行 requirements.md hash——
// 「審完 → 大改文 → 凍結」會讓零新發現 attest 到舊文，機器擋。
export function lensConvergenceAudit(ledgers, currentHash, requiredLenses = REQUIRED_SPEC_LENSES, cap = SPEC_REVIEW_ROUND_CAP) {
  const problems = [];
  const byLens = {};
  for (const r of (ledgers || [])) (byLens[r.lens] = byLens[r.lens] || []).push(r);
  for (const arr of Object.values(byLens)) arr.sort((a, b) => (a.round || 0) - (b.round || 0));
  for (const lens of requiredLenses) {
    const rounds = byLens[lens] || [];
    if (!rounds.length) { problems.push(`lens「${lens}」未跑——SHALL 至少 2 輪（spawn ${lens === 'redteam' ? 'spec-redteam' : 'spec-consistency'} subagent → flow-state spec-review ${lens} --file <findings.json>）`); continue; }
    const last = rounds[rounds.length - 1];
    if (last.docHash !== currentHash) { problems.push(`lens「${lens}」末輪（r${last.round}）審的不是現行 requirements.md（docHash 不符）——文字在末輪審查後被改過，重跑一輪把新文字審過`); continue; }
    const lastN = (last.findings || []).length;
    if (!((rounds.length >= 2 && lastN === 0) || rounds.length >= cap))
      problems.push(`lens「${lens}」未收斂：${rounds.length} 輪、末輪 ${lastN} 條 findings——逐條終局化後重跑，直到末輪零新發現（或滿 ${cap} 輪且全終局封頂）`);
  }
  return problems;
}

// ── ledger 儲存（fs 端；寫入一律經 flow-state CLI 正門，flow-spec-gate 擋裸寫）──
export async function writeSpecReviewLedger(root, lens, record) {
  await mkdir(specReviewDir(root), { recursive: true });
  const existing = (await listSpecReviewLedgers(root)).filter(r => r.lens === lens);
  const round = existing.reduce((m, r) => Math.max(m, r.round || 0), 0) + 1;
  await writeJSON(path.join(specReviewDir(root), `${lens}-r${round}.json`), { ...record, lens, round, at: nowISO() });
  await appendJournal(root, { ev: 'spec.review', lens, round, findings: (record.findings || []).length });
  return round;
}
export async function listSpecReviewLedgers(root) {
  const d = specReviewDir(root);
  if (!existsSync(d)) return [];
  const out = [];
  for (const f of await readdir(d)) {
    // 只認 CLI 寫出的正規檔名——「內容有 lens 欄位就算一輪」會讓留在目錄裡的 findings 輸入檔
    // 被灌成一輪（1 個真輪就打穿 ≥2 輪收斂門）。lens/round 以檔名為準、不信檔內自填。
    const m = f.match(/^(redteam|consistency|codex)-r(\d+)\.json$/i);
    if (!m) continue;
    const rec = await readJSON(path.join(d, f), null);
    if (rec) out.push({ ...rec, lens: m[1].toLowerCase(), round: Number(m[2]) });
  }
  return out;
}
// 只取「最後一次凍結之後」的 lens 輪（純函式）：收斂週期斷代——已 ship 的長線專案回 /flow-spec 追加需求時，
// 「各 ≥2 輪＋末輪零新發現」要對本週期重新成立，不能被上個週期累計的輪數蒙混（rounds.length>=cap 永久為真）。
// spec.frozen journal 事件是天然斷代點；ledger 帶 at 時戳。歷史輪的 findings 已終局，reviewCheckAudit 仍吃全量（保「不可蒸發」）。
export function currentCycleLedgers(ledgers, journal) {
  const t0 = lastFrozenAt(journal);
  if (!t0) return ledgers || [];
  return (ledgers || []).filter(r => (r.at || '') > t0);
}
// 最後一次 spec.frozen 的 journal 時戳（''＝從未凍結）——週期斷代的單一事實來源。
export function lastFrozenAt(journal) {
  let t0 = '';
  for (const e of (journal || [])) if (e && e.ev === 'spec.frozen' && (e.t || '') > t0) t0 = e.t || '';
  return t0;
}

export async function readSpecResolutions(root) { return readJSON(specResolutionsPath(root), {}); }
export async function writeSpecResolution(root, findingId, resObj) {
  const cur = await readSpecResolutions(root);
  cur[String(findingId).toUpperCase()] = { ...resObj, at: nowISO() };
  await writeJSON(specResolutionsPath(root), cur);
  await appendJournal(root, { ev: 'spec.review.resolve', id: String(findingId).toUpperCase(), as: resObj.as });
}

// ── 第 2 波：全鏈路機器對賬（REQ→design→task→test→verify，.flow/trace/ ledger）──
// 凍結分母：freeze 通過瞬間落 REQ 全集＋requirements.md hash＋HEAD sha。下游閘門一律以此為分母，
// 不再各自臨場重掃——凍結後偷改 requirements.md 在「下一個消費閘門」就被 hash 對賬抓到（不拖到 ship）。
const traceDir = root => path.join(dir(root), 'trace');
const reqIndexPath = root => path.join(traceDir(root), 'req-index.json');
const planCheckPath = root => path.join(traceDir(root), 'plan-check.json');

// 共用：跑 regex 掃 md，逐個 match 大寫化＋去重＋保序（extractAllReqIds/extractReqPerf/extractReqE2E 同款迴圈，只差 regex 本身）。
function extractIdsByRegex(md, re) {
  const out = [], seen = new Set();
  for (const m of String(md || '').matchAll(re)) {
    const id = m[0].toUpperCase();
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}
// 全型號 REQ id（REQ-*/REQ-E2E-*/REQ-PERF-*/REQ-RBAC-*…）——去重保序大寫。
// 字元類不含「.」——真實 REQ id 無中綴點；含點會讓「對應 REQ-E2E-001.」句尾把尾點吞進 id 變幻覺 id（plan-check/wave 誤 exit 2）。
export function extractAllReqIds(md) { return extractIdsByRegex(md, /\bREQ-[A-Za-z0-9_-]+/gi); }
export async function writeReqIndex(root, reqMd, head) {
  await writeJSON(reqIndexPath(root), { reqIds: extractAllReqIds(reqMd), reqHash: sha256Text(reqMd), head: head || '', at: nowISO() });
}
export async function readReqIndex(root) { return readJSON(reqIndexPath(root), null); }
// 現行 requirements.md hash vs 凍結 index：回 null＝相符或無 index（向後相容）；否則錯誤訊息。
// 消費閘門（plan-check/verify-e2e/complete-check）先跑這個——凍結後偷改文字，下一道就擋。
export function reqHashProblem(index, currentReqMd) {
  if (!index || !index.reqHash) return null;                      // 無 index（舊專案/尚未凍結）→ 不擋
  if (index.reqHash === sha256Text(currentReqMd)) return null;
  return 'requirements.md 已與凍結快照不符（凍結後被改過）——要嘛還原，要嘛重跑 flow-state spec-ready --freeze 重新凍結（會走過收斂閘門並更新快照）。';
}

// tasks.md 解析（純函式）：抽 task id＋blockedBy＋conflictZone，供 plan-check 對賬 manifest。
// 格式（tasks-template）：「- [ ] F-1 標題（對應 REQ-E2E-001）」下一行「blockedBy: A,B | conflictZone: x/, y/」。
const splitDecl = s => s.split(/[,，]/).map(x => x.trim()).filter(x => x && x !== '—' && x !== '-' && x !== '–');
export function parseTasksMd(md) {
  const lines = String(md || '').split(/\r?\n/);
  const tasks = [];
  let cur = null;
  const scanDecl = (raw) => {                                      // 同行或續行的 blockedBy/conflictZone 都吃
    if (!cur) return;
    const bb = raw.match(/blockedBy\s*[:：]\s*([^|]*)/i);
    if (bb) cur.blockedBy = splitDecl(bb[1]);
    const cz = raw.match(/conflictZone\s*[:：]\s*([^|]*)/i);        // 到 | 為止（與 blockedBy 對稱，欄位順序無關）
    if (cz) cur.conflictZone = splitDecl(cz[1]);
  };
  for (const raw of lines) {
    const m = raw.match(LINE_RE);
    if (m) {
      const id = lineId(m[4]);
      if (id) { cur = { id, blockedBy: [], conflictZone: [] }; tasks.push(cur); scanDecl(raw); } else cur = null;   // 承接 inline 宣告
      continue;
    }
    scanDecl(raw);
  }
  return tasks;
}

// tasks.md 裡「checkbox task 行」的文字（REQ id 在標題「（對應 REQ-E2E-001）」上）——
// 只掃 task 行、排除追溯註解/backlog 散文，避免「REQ id 出現在註解就算被承接」的假覆蓋。
function taskLinesText(md) {
  return String(md || '').split(/\r?\n/).filter(l => { const m = l.match(LINE_RE); return m && lineId(m[4]); }).join('\n');
}
// REQ↔task 覆蓋（純函式）：只要求 REQ-E2E-*／REQ-PERF-* 被 task 承接——功能型 REQ-* 由 REQ-E2E 承接、
// 走 plan-check 的 REQ↔design 對照表人工掃（對齊 ears-cheatsheet 方法論；強求功能型逐條進 tasks.md 會擋死官方範本）。
// 覆蓋＝該 id 出現在某 task 行，或有「前綴 glob」（tasks.md 寫「REQ-PERF-*」→ token「REQ-PERF-」覆蓋該前綴全部 id）。
// 成員判定用 tokenized set（word-boundary），不用裸子字串——防 REQ-1 誤配 REQ-10 的前綴碰撞。
export function reqTaskCoverage(reqIds, tasksMd) {
  const need = (reqIds || []).map(x => x.toUpperCase()).filter(id => /^REQ-(E2E|PERF)-/.test(id));
  const taskText = taskLinesText(tasksMd);
  const referenced = extractAllReqIds(taskText);
  const concrete = new Set(referenced.filter(id => !id.endsWith('-')));   // 具體 id（非殘綴）
  const prefixes = referenced.filter(id => id.endsWith('-'));             // 「REQ-PERF-*」→「REQ-PERF-」前綴 glob
  const covered = id => concrete.has(id) || prefixes.some(p => id.startsWith(p));
  const uncovered = need.filter(id => !covered(id));
  const idSet = new Set((reqIds || []).map(x => x.toUpperCase()));
  const phantom = [...concrete].filter(id => !idSet.has(id));             // 具體 id 卻不在 index＝幻覺/打錯（glob 不算幻覺）
  return { uncovered, phantom, ok: uncovered.length === 0 && phantom.length === 0 };
}

// tasks.md ↔ manifest 逐欄 diff（純函式）：task 集合／blockedBy／conflictZone 不一致就回問題列。
// 堵「manifest 寫得比 tasks.md 寬＝scope/wave 閘門的事實來源被靜默調鬆」。
// conflictZone 比對前套 scope 閘門同款 normPath（去尾斜線/./前綴/反斜線）＋大小寫不敏感，純外觀差異不誤判；
// 集合比對故排序，欄位順序（conflictZone 寫在 blockedBy 前後）不影響。
const normZone = z => normPath(z).toLowerCase();
const sortedEq = (a, b) => { const x = [...(a || [])].sort(), y = [...(b || [])].sort(); return x.length === y.length && x.every((v, i) => v === y[i]); };
const sortedEqZone = (a, b) => sortedEq((a || []).map(normZone), (b || []).map(normZone));
export function planManifestDiff(tasksMd, manifest) {
  const parsed = parseTasksMd(tasksMd);
  const mTasks = (manifest && manifest.tasks) || [];
  const problems = [];
  const pIds = new Set(parsed.map(t => t.id)), mIds = new Set(mTasks.map(t => t.id));
  for (const id of pIds) if (!mIds.has(id)) problems.push(`task「${id}」在 tasks.md 有、manifest 沒有——同步進 manifest（/flow-plan Step 5）`);
  for (const id of mIds) if (!pIds.has(id)) problems.push(`task「${id}」在 manifest 有、tasks.md 沒有——manifest 比 tasks.md 寬，scope/wave 閘門會據此放行幽靈 task`);
  const mById = Object.fromEntries(mTasks.map(t => [t.id, t]));
  for (const t of parsed) {
    const mt = mById[t.id];
    if (!mt) continue;
    if (!sortedEq(t.blockedBy, mt.blockedBy || [])) problems.push(`「${t.id}」blockedBy 不一致：tasks.md=[${t.blockedBy}] vs manifest=[${mt.blockedBy || []}]`);
    if (!sortedEqZone(t.conflictZone, mt.conflictZone || [])) problems.push(`「${t.id}」conflictZone 不一致：tasks.md=[${t.conflictZone}] vs manifest=[${mt.conflictZone || []}]（scope 閘門讀 manifest，寫寬＝檔案安全被鬆綁）`);
  }
  return problems;
}

export async function writePlanCheck(root, manifest, head) {
  await writeJSON(planCheckPath(root), { manifestHash: manifestScopeHash(manifest), head: head || '', at: nowISO() });
}
export async function readPlanCheck(root) { return readJSON(planCheckPath(root), null); }

// ── 第 3 波：執行期波次計算（W3-1）＋ worker 逐字投餵（W3-2），合流一個 .flow/trace/wave-plan.json ──
// 動機：`/flow-build` 的「同一波可並行」過去靠模型臨場算（讀 blockedBy/conflictZone 心算），零確定性節點＝
//   自駕下可能把有依賴/zone 重疊的 task 併同波（覆寫地獄／破壞接縫），或 worker 各自 re-read requirements.md
//   讀到漂移版本（H10）。這裡把「波次拓樸」與「每 task 逐字 REQ 文字」都算成一個確定性檔，dispatch 只讀它。
const wavePlanPath = root => path.join(traceDir(root), 'wave-plan.json');

// manifest 的「波次/scope 語意」canonical hash——只投影 tasks 的 id/blockedBy/conflictZone（排序正規化），
// 對 updatedAt/mode/projectType 等語意無關欄位穩定：否則 wave --compute/plan-check 後跑 mode/project-type
// （writeManifest 會 bump updatedAt）就誤判「manifest 漂移」擋 scope。buildWavePlan/waveMembershipProblem/writePlanCheck/complete-check 四處共用同一投影。
export function manifestScopeHash(manifest) {
  const tasks = (((manifest && manifest.tasks) || []).map(t => ({
    id: t.id,
    blockedBy: [...(t.blockedBy || [])].sort(),
    conflictZone: [...(t.conflictZone || [])].map(normZone).sort(),
  }))).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256Text(JSON.stringify(tasks));
}

// zone 前綴重疊（以路徑邊界為界，非裸子字串——src/ab 不算 src/a 的子路徑）。normZone 已去尾斜線/大小寫。
function zonePrefixOverlap(za, zb) {
  const a = normZone(za), b = normZone(zb);
  return a === b || b.startsWith(a + '/') || a.startsWith(b + '/');
}
const zoneSetsOverlap = (A, B) => (A || []).some(za => (B || []).some(zb => zonePrefixOverlap(za, zb)));

// 純函式：純拓樸排序（Kahn 分層）→ 波次。輸入 manifest（tasks[].blockedBy/conflictZone）＋ deliveredSet（已交付 id）。
//   ① 已 delivered 的 task 不進波（已完成）；② blockedBy 未全滿足（∉ placed）者延到後波；
//   ③ 同層按 id 字典序 tie-break（真「同輸入同輸出」，去除 Map 插入序偶然性）；
//   ④ 同波 conflictZone 前綴重疊 → 優先自動拆波（把後者延到下一波，降並行度、附 warning），不 exit；
//   ⑤ 剩餘 task 全部 blockedBy 卡死（成環／懸空依賴／依賴永不交付）＝拓樸無解 → problems 非空（CLI exit 2）。
// zone 重疊「拆波總能解」（延後不造成環，因無依賴關係的 task 分兩波只是變序列）；唯一 exit＝依賴拓樸無解。
export function computeWaves(manifest, deliveredSet) {
  const tasks = ((manifest && manifest.tasks) || []).filter(t => t && t.id);
  const done = new Set([...(deliveredSet || [])]);
  const placed = new Set([...done]);
  const left = new Map(tasks.filter(t => !done.has(t.id)).map(t => [t.id, t]));
  const waves = [], warnings = [];
  let guard = left.size + 5;
  while (left.size) {
    const ready = [...left.values()]
      .filter(t => (t.blockedBy || []).every(b => placed.has(b)))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (!ready.length) {
      return { waves, warnings, problems: [`波次拓樸無解：這些 task 的 blockedBy 成環／指向不存在或永不交付的 task，永遠進不了任何波 → ${[...left.keys()].join(', ')}。回 /flow-plan 修 blockedBy（斬環或補齊被依賴 task）。`] };
    }
    const wave = [], chosenZones = [];
    for (const t of ready) {
      const z = (t.conflictZone || []).map(normZone);
      if (z.length && chosenZones.some(cz => zoneSetsOverlap(cz, z))) { warnings.push(`${t.id} 因 conflictZone 與同波成員重疊被自動拆到後波（並行度受限）——回 /flow-plan Step 4.5 評估能否把中央檔擴充點改成各 feature 自己的檔`); continue; }
      wave.push(t.id); chosenZones.push(z);
    }
    for (const id of wave) { placed.add(id); left.delete(id); }
    waves.push(wave);
    if (--guard < 0) return { waves, warnings, problems: ['波次計算超出迭代上限（疑似邏輯錯誤，請回報）'] };
  }
  return { waves, warnings, problems: [] };
}

// 純函式：tasks.md 每個 task 行承接的 REQ id（標題「（對應 REQ-E2E-001）」）。回 { [taskId]: [reqId...] }。
// 只掃 checkbox task 行本身（不含續行/註解），與 reqTaskCoverage 的 taskLinesText 同源避免假承接。
export function taskReqIds(tasksMd) {
  const out = {};
  for (const raw of String(tasksMd || '').split(/\r?\n/)) {
    const m = raw.match(LINE_RE);
    if (!m) continue;
    const id = lineId(m[4]);
    if (!id) continue;
    out[id] = extractAllReqIds(m[4]);
  }
  return out;
}

// 純函式：從 requirements.md 逐字抽某 REQ id 的定義區塊（定義行含 id → 至下一個 REQ 定義行/標題）。
// 找不到回 null（W3-2：任一承接的具體 REQ 抽不到＝ id 打錯/已刪，buildWavePlan 據此 exit 2）。與 reqPerfBlock 同款切界。
export function extractReqBlock(reqMd, id) {
  const lines = String(reqMd || '').split(/\r?\n/);
  const target = String(id).toUpperCase();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(REQ_DEF_RE);
    if (!m || m[1].toUpperCase() !== target) continue;
    return lines.slice(i, reqBlockEnd(lines, i)).join('\n').replace(/\s+$/, '');   // 含定義行、逐字、去尾空白
  }
  return null;
}

// 純函式：組裝 wave-plan（波次拓樸 + 每 task 逐字 REQ 文字）。任一拓樸無解或承接 REQ 抽不到區塊 → problems 非空。
// reqText 逐字來自凍結 requirements.md（呼叫端 CLI 先過 reqHashProblem 確保是凍結版）＝同 task＋同凍結 spec →
// worker 收到的規格文字逐 byte 相同（堵 H10：worker 各自 re-read 讀到漂移版本）。glob 前綴（REQ-PERF-*）不抽區塊、跳過。
export function buildWavePlan(manifest, deliveredSet, tasksMd, reqMd, reqIndex) {
  const { waves, warnings, problems } = computeWaves(manifest, deliveredSet);
  if (problems.length) return { problems, warnings };
  const reqMap = taskReqIds(tasksMd);
  const missing = [];
  const detailWaves = waves.map(w => w.map(id => {
    const reqIds = (reqMap[id] || []).filter(r => !r.endsWith('-'));   // 排除 glob 前綴（非具體 id）
    const blocks = [];
    for (const rid of reqIds) {
      const blk = extractReqBlock(reqMd, rid);
      if (blk == null) { missing.push(`${id} 承接 ${rid}，但凍結 requirements.md 抽不到該 REQ 區塊（id 打錯或已被刪）——修 tasks.md 或重新凍結`); continue; }
      blocks.push(blk);
    }
    return { id, reqIds, reqText: blocks.join('\n\n') };
  }));
  if (missing.length) return { problems: missing, warnings };
  // W3-3②：函式自身防禦——reqIndex 存在但與傳入 reqMd 不一致＝呼叫端漏跑 reqHashProblem。
  // 別靜默組出「reqText 對不上凍結版」的 wave-plan 給 worker 逐字投餵（防線放在最終輸出契約裡，不只靠呼叫端自律）。
  if (reqIndex && reqIndex.reqHash && sha256Text(reqMd || '') !== reqIndex.reqHash)
    return { problems: ['requirements.md 與凍結分母 req-index.json 不一致（呼叫端漏跑 reqHashProblem？）——逐字投餵只准用凍結版，先對賬再算波次'], warnings };
  return {
    manifestHash: manifestScopeHash(manifest),
    reqHash: sha256Text(reqMd || ''),
    reqIndexHash: (reqIndex && reqIndex.reqHash) || '',
    waves: detailWaves, warnings, problems: [],
  };
}

export async function writeWavePlan(root, plan) { await writeJSON(wavePlanPath(root), { ...plan, at: nowISO() }); }
export async function readWavePlan(root) { return readJSON(wavePlanPath(root), null); }

// W3-1/W3-5 trace 記錄（journey-check 通過、complete-check 達成）——各綁 HEAD，供 complete-check / Stop hook 對賬。
const journeyCheckPath  = root => path.join(dir(root), 'trace', 'journey-check.json');
const completeCheckPath = root => path.join(dir(root), 'trace', 'complete-check.json');
export async function writeJourneyCheck(root, obj) { await writeJSON(journeyCheckPath(root), { ...obj, at: nowISO() }); }
export async function readJourneyCheck(root) { return readJSON(journeyCheckPath(root), null); }
export async function writeCompleteCheck(root, obj) { await writeJSON(completeCheckPath(root), { ...obj, at: nowISO() }); }
export async function readCompleteCheck(root) { return readJSON(completeCheckPath(root), null); }

// ── 待決單（pending tickets，C-8）─────────────────────────────────────────────
// 自駕碰到「重試仍過不了」的關卡 → 記一張待決單、繼續其他工作不中斷；收尾一批彈窗請使用者拍板。
// 取代「AI 自建 waiver 冒使用者名義關掉出貨安全門」的舊路徑。pending/ 進 git（耐久、可稽核）。
// complete-check 對 pending 非空 exit 2（有待決＝不得自稱出貨完成）。
const pendingDir = root => path.join(dir(root), 'pending');
export async function addPending(root, id, { why = '', task = '' } = {}) {
  const sid = safeId(id);
  await writeJSON(path.join(pendingDir(root), sid + '.json'), { id: sid, why, task, at: nowISO() });
  await appendJournal(root, { ev: 'pending.add', id: sid, why });
  return sid;
}
export async function listPending(root) {
  const d = pendingDir(root);
  if (!existsSync(d)) return [];
  const out = [];
  for (const f of await readdir(d)) if (f.endsWith('.json')) out.push(await readJSON(path.join(d, f), {}));
  return out;
}
export async function resolvePending(root, id, how = '') {
  const sid = safeId(id);
  const p = path.join(pendingDir(root), sid + '.json');
  if (!existsSync(p)) return false;
  await unlink(p);
  await appendJournal(root, { ev: 'pending.resolve', id: sid, how });
  return true;
}

// 純函式：--wave 傳入的一組 id 是否對應 wave-plan 的「某一波」（成員集合相等，順序無關）＋ manifest hash 一致。
// scope --wave / checkpoint --phase dispatched 增驗用（堵 H6：dispatch/整合時自行併波或用漂移 manifest）。
// 回 null＝相符或無 wave-plan（向後相容：沒跑過 wave --compute 就跳過本增驗，只做原本的 conflictZone 檢查）。
export function waveMembershipProblem(plan, manifest, waveIds) {
  if (!plan || !Array.isArray(plan.waves)) return null;               // 無 wave-plan → 不擋（相容既有流程）
  const curHash = manifestScopeHash(manifest);
  if (plan.manifestHash && plan.manifestHash !== curHash)
    return 'manifest 已與 wave-plan 快照不符（plan 後改過 blockedBy/conflictZone）——重跑 flow-state wave --compute 重算波次再跑。';
  const want = new Set((waveIds || []).map(String));
  const hit = plan.waves.some(w => {
    const s = new Set((w || []).map(x => (x && x.id) || x));
    return s.size === want.size && [...want].every(id => s.has(id));
  });
  if (!hit) return `--wave 成員 [${(waveIds || []).join(', ')}] 不對應 wave-plan 算出的任何一波——照 flow-state wave --compute 的波次跑，別自行併/拆波（會破壞 zone 互斥與依賴序）。`;
  return null;
}

// ── REQ-PERF budget 解析＋達標判定（純函式）：verify-perf 用 ──
// 抽「比較運算子＋數字＋單位」，回 { op, budget, unit, lower } 或 null。要點：
//   ① 支援上界（<=/</≤，延遲/尺寸）與下界（>=/>/≥，吞吐量/可用率）——lower 記方向；
//   ② 錨定「帶單位」的比較式優先（延遲/尺寸 budget 一定帶單位；資料量/並發條件如「資料量 < 5000 筆」不帶）——
//      堵條件句「查詢在資料量 < 5000 筆時 p95 <= 400ms」把 5000 抓成 budget 的靜默失效；全行無單位才 fallback 首個。
const PERF_UNIT = 'ms|s|sec|MB|KB|GB|%|rps|qps|tps|fps';
export function parsePerfBudget(line) {
  const s = String(line || '');
  // 數字允許千分位逗號（budget 常寫成 1,000ms / 2,000 tokens）——比對含逗號、Number 前 strip 掉，
  // 否則 [\d.]+ 會在逗號前截斷把「< 1,000ms」錯解成 budget=1（靜默把達標判成超標）。
  const all = [...s.matchAll(new RegExp(`(<=|<|≤|>=|>|≥)\\s*([\\d,.]+)\\s*(${PERF_UNIT})?`, 'gi'))]
    .map(m => ({ op: m[1], budget: Number(m[2].replace(/,/g, '')), unit: (m[3] || '').toLowerCase() }));
  if (!all.length) return null;
  const chosen = all.find(x => x.unit) || all[0];
  return { ...chosen, lower: /^(>=|>|≥)/.test(chosen.op) };
}
// value（同單位）是否達標。回 null＝達標，否則訊息。容差 5%（量測噪音；budget 建議自留 20% 餘裕）。
// 上界：value <= budget*1.05；下界（吞吐量/可用率）：value >= budget*0.95。
export function perfMeetsBudget(value, budget) {
  const v = Number(value);
  if (!Number.isFinite(v)) return 'value 不是數字';
  if (budget.lower) return v >= budget.budget * 0.95 ? null : `實測 ${v}${budget.unit} 未達下限（budget ${budget.op} ${budget.budget}${budget.unit}，含 5% 容差）`;
  return v <= budget.budget * 1.05 ? null : `實測 ${v}${budget.unit} 超標（budget ${budget.op} ${budget.budget}${budget.unit}，含 5% 容差）`;
}
export function extractReqPerf(md) { return extractIdsByRegex(md, /\bREQ-PERF-[A-Za-z0-9._-]+/gi); }
// REQ-PERF 定義行（供 verify-perf 解析 budget）。回 { [id]: line }
export function reqPerfLines(md) {
  const out = {};
  for (const raw of String(md || '').split(/\r?\n/)) {
    const m = raw.match(REQ_DEF_RE);
    if (m && /^REQ-PERF-/i.test(m[1])) out[m[1].toUpperCase()] = raw;
  }
  return out;
}
// 某 REQ-PERF id 的「定義塊」文字（定義行殘句＋後續至下個 REQ/標題）——與 specReadiness 掃 N/A 同源，
// 讓 spec-ready 與 complete-check 對「非量測型/N-A」判定一致（堵「freeze 認 N/A、ship 卻要 verify-perf」死鎖）。
export function reqPerfBlock(md, id) {
  const lines = String(md || '').split(/\r?\n/);
  const target = String(id).toUpperCase();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(REQ_DEF_RE);
    if (!m || m[1].toUpperCase() !== target) continue;
    return [lines[i].slice(m[0].length), ...lines.slice(i + 1, reqBlockEnd(lines, i))].join('\n');
  }
  return '';
}
// 此 REQ-PERF 是否「非量測型」（無可解析 budget，或明標 N/A）——需 perf-waiver 而非 verify-perf。
export function perfIsNonMeasurable(md, id) {
  const block = reqPerfBlock(md, id);
  return !parsePerfBudget(block) || /\bN\/A\b|Ｎ／Ａ|不適用/i.test(block);
}
// perf 驗證記錄（.flow/verify/perf-<id>.json）——與 REQ-E2E 記錄同目錄但 perf- 前綴，listVerifyRecords 排除它、不污染 coverage orphan。
export async function writePerfRecord(root, id, rec) {
  await writeJSON(path.join(verifyDir(root), 'perf-' + safeId(id) + '.json'), { id, ...rec, at: rec.at || nowISO() });
}
export async function readPerfRecord(root, id) { return readJSON(path.join(verifyDir(root), 'perf-' + safeId(id) + '.json'), null); }

// ── 藍軍 code-review 機讀落檔＋終局化（.flow/code-review/）：把 code-reviewer 的 red flag 從散文升級成閘門 ──
// /flow-ship Step 1 的 code-reviewer subagent 回結構化 findings → flow-state review-code 落檔（記 review 當時 HEAD）；
// 每條 red flag（必修）SHALL 走終局（fixed:<evidence>／waiver:<decisionId>），沒處理完的 complete-check 擋 ship。
// yellow flag（建議）記錄但不進閘門。誠實邊界：機器驗的是「red flag 不能無聲蒸發＋各有終局標記」，
// 不驗「fixed 是否真的修對」（evidence 自報）——防懶不防蓄意，與 spec-review 同分層。
const codeReviewDir = root => path.join(dir(root), 'code-review');
const codeFindingsPath = root => path.join(codeReviewDir(root), 'findings.json');
const codeResolutionsPath = root => path.join(codeReviewDir(root), 'resolutions.json');

export function validateCodeFindings(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['不是 JSON 物件'];
  if (!Array.isArray(obj.findings)) return ['缺 findings 陣列（零 red flag 也給空陣列 []——「沒審」與「審過且乾淨」要可分）'];
  const problems = [], seen = new Set();
  obj.findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (!f || typeof f !== 'object') { problems.push(`${at} 不是物件`); return; }
    const id = String(f.id || '').toUpperCase();
    if (!/^CR-[A-Za-z0-9._-]+$/i.test(id)) problems.push(`${at} id 須為 CR-<流水號>（如 CR-001）`);
    else if (seen.has(id)) problems.push(`${at} id 重複：${f.id}`);
    else seen.add(id);
    if (!['red', 'yellow'].includes(String(f.severity || '').toLowerCase())) problems.push(`${at} severity 須為 red（必修）/yellow（建議）`);
    if (!String(f.claim || '').trim()) problems.push(`${at} 缺 claim（具體問題，含 file:line）`);
  });
  return problems;
}
// finding 內容 hash（id 無關；resolution 綁它、不綁裸 id）——重跑 review 換編號/覆寫時，
// 「同號但內容全新的 red」不會繼承舊 id 的終局（堵撞號蒸發），與 spec-review 的 docHash 同構。
export function codeFindingHash(f) {
  return sha256Text([String(f.file || ''), String(f.severity || '').toLowerCase(), String(f.claim || '')].join('|')).slice(0, 16);
}
// 落一輪 code-review：覆寫 findings.json，但**保留「舊 red 中仍未終局的」**（合併進來，去重按 hash）——
// 重跑報少了/聚焦別處，未解的 red 不因覆寫而蒸發。needs decisionExists 判「舊 red 是否已終局」。
export async function writeCodeReview(root, findings, head, decisionExists) {
  const res = await readCodeResolutions(root);
  const prev = await readCodeReview(root);
  const newHashes = new Set(findings.map(codeFindingHash));
  const carried = [];
  if (prev) for (const f of (prev.findings || [])) {
    if (String(f.severity).toLowerCase() !== 'red') continue;
    const h = codeFindingHash(f);
    if (newHashes.has(h)) continue;                                // 新輪也報了同一問題 → 用新的
    const r = res[h];
    const terminal = r && !codeResolutionProblem(r.as, decisionExists);
    if (!terminal) carried.push({ ...f, carried: true });          // 舊未終局 red → 帶進來繼續要求終局
  }
  const merged = [...findings, ...carried];
  await writeJSON(codeFindingsPath(root), { findings: merged, head: head || '', at: nowISO() });
  await appendJournal(root, { ev: 'code.review', red: merged.filter(f => String(f.severity).toLowerCase() === 'red').length, total: merged.length, carried: carried.length });
  return { carried: carried.length };
}
export async function readCodeReview(root) { return readJSON(codeFindingsPath(root), null); }
export async function readCodeResolutions(root) { return readJSON(codeResolutionsPath(root), {}); }
// resolution key ＝ finding 內容 hash（非裸 id）。
export async function writeCodeResolution(root, findingHash, resObj) {
  const cur = await readCodeResolutions(root);
  cur[findingHash] = { ...resObj, at: nowISO() };
  await writeJSON(codeResolutionsPath(root), cur);
  await appendJournal(root, { ev: 'code.review.resolve', hash: findingHash, as: resObj.as });
}
// 單筆終局驗證（純函式；decisionExists 注入）：fixed 須附非空 evidence；waiver 須 decision 檔實存。回 null＝合法。
export function codeResolutionProblem(asStr, decisionExists) {
  const s = String(asStr || '').trim();
  let m;
  if ((m = s.match(/^fixed:(.*)$/i))) return m[1].trim() ? null : 'fixed 須附證據 ref（fixed:<file:line/commit/測試名>）——空證據不算修';
  if ((m = s.match(/^waiver:(.+)$/i))) {
    const did = m[1].trim();
    if (/[\/\\]|\.\./.test(did)) return 'waiver 的 decisionId 不得含路徑分隔或 ..';
    return decisionExists(did) ? null : `waiver 指向的 decision「${did}」不存在——先 flow-state decision ${did} --choice … --why … 留檔（使用者拍板不修）`;
  }
  return `不合法的終局「${s}」——須為 fixed:<evidence> / waiver:<decisionId>`;
}
// code-review 終局化對賬（純函式）：每條 red flag（按內容 hash 查 resolution）都要終局——red flag 不能無聲蒸發。yellow 不進閘門。
export function codeReviewAudit(review, resolutions, decisionExists) {
  if (!review) return [];                                          // 沒跑 code-review → 這函式不擋（forcing function 在 complete-check 端）
  const res = resolutions || {};
  const problems = [];
  for (const f of (review.findings || [])) {
    if (String(f.severity).toLowerCase() !== 'red') continue;
    const id = String(f.id || '').toUpperCase();
    const r = res[codeFindingHash(f)];                             // 綁內容 hash，不綁裸 id
    if (!r) { problems.push(`${id}（red）未終局：${String(f.claim || '').slice(0, 60)}——flow-state code-resolve ${id} --as <fixed:<evidence>|waiver:<decisionId>>`); continue; }
    const p = codeResolutionProblem(r.as, decisionExists);
    if (p) problems.push(`${id}：${p}`);
  }
  return problems;
}

// ── tasks.md 同步：把「task 完成」收成一個可被 hook/CLI 共用的原子操作 ──
// 修根因：原本「翻 tasks.md [x]」「寫 ledger」「TaskUpdate」是三條各自會被漏掉的散文步驟。
// 這裡把「翻 [x] + ledger→delivered」綁成一次呼叫，flow-state done 與 commit gate 都走它。
const tasksMdPath = root => path.join(root, 'specs', 'tasks.md');
const LINE_RE = /^(\s*[-*]\s*\[)([ xX])(\]\s*)(.+)$/;          // 抓 checkbox 行（保留前後綴以原樣回寫）
const ID_RE   = /^([A-Za-z][A-Za-z0-9]*(?:-[\w.]+)+)\b/;      // 抽 canonical id（去 ** 後取開頭 ID token）。C-48：容許字母後緊接數字（W0-5/T1-2 等 wave 標籤），原 [A-Z][A-Za-z]* 會把它們解析成 null → 翻勾/對帳/閘門全鏈靜默失明
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
    // verify 欄位格式（W2-3）：SHALL 是 ok:<ref>（帶證據 ref），堵「verify=x 隨便填非空字串就過」。
    if (!isValidVerify(st.verify)) {
      const e = new Error(`Flow done gate：「${id}」verify="${st.verify}" 格式不對——SHALL 是 "ok:<證據ref>"（trace 路徑/測試名/verify-e2e id），不是隨手填的字串。`);
      e.code = 'VERIFY_GATE';
      throw e;
    }
    // run --task 對賬（W2-3）：若此 task 走過 flow-state run --task 且某條 runner 最後一次仍紅 → 擋
    // 「用 runner 跑過、最後一次紅卻硬標 done」（含換命令洗綠）。沒走 run 的不表態（退回 verify/tdd 閘門，不誤擋 MCP 真點擊）。
    const redBucket = taskRunnerRed(await readJournal(root), id);
    if (redBucket) {
      const e = new Error([
        `Flow done gate：「${id}」的 runner「${redBucket}」最後一次是紅，不能標 delivered。`,
        `  先讓它真跑綠（flow-state run --task ${id} -- ${redBucket}），再 done——換別的命令跑綠不算數。`,
      ].join('\n'));
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
export function extractReqE2E(md) { return extractIdsByRegex(md, /\bREQ-E2E-[A-Za-z0-9._-]+/gi); }
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
const gotoAllCount = block => (String(block).match(/\.goto\s*\(/g) || []).length;   // C-20：含非字面（page.goto(變數)）
export function auditJourneyTest(content) {
  const c = String(content || '');
  if (!JOURNEY_SIGNAL.test(c)) return { isJourney: false, problems: [], warnings: [] };
  const problems = [], warnings = [];
  for (const [re, label] of MOCK_PATTERNS) if (re.test(c)) problems.push(`出現${label}——E2E 真實鏈路禁 mock/攔截假後端（第四鐵則）`);
  let totalGoto = 0;
  for (const b of journeyTestBlocks(c)) {
    const gts = gotoTargets(b);
    const allGoto = gotoAllCount(b);
    totalGoto += allGoto;
    if (gts.length > 1) problems.push(`單一 test 內有 ${gts.length} 個 goto（${gts.join(', ')}）——應只有一個入口 goto、其後用真實點擊串接（第五鐵則）`);
    // C-20：非字面 goto（page.goto(變數/表達式)）靜態抓不到目標——一個 block 內有非字面 goto 且 goto 總數 >1 → 警告
    //（維持非阻擋，避免「單一入口用變數」被誤殺；只提醒人工確認不是 deep-link 串接）。
    const nonLiteral = allGoto - gts.length;
    if (nonLiteral > 0 && allGoto > 1) warnings.push(`單一 test 內有 ${nonLiteral} 個非字面 goto（page.goto(變數/表達式)）——靜態無法確認是否只有單一入口，請人工確認非 deep-link 跳關（第五鐵則）`);
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
export function pickNext(view, excludeIds = []) {
  const done = id => (view.tasks[id] || {}).state === 'delivered';
  const skip = new Set(excludeIds || []);   // C-8：有待決單的 task 不算「可推進」（stop-gate 傳入，防已放棄的關卡被誤判成活口）
  const manifestById = Object.fromEntries(((view.manifest || {}).tasks || []).map(t => [t.id, t]));
  const ids = ((view.manifest || {}).tasks && view.manifest.tasks.length)
    ? view.manifest.tasks.map(t => t.id)
    : (view.order && view.order.length ? view.order : Object.keys(view.tasks || {}));
  for (const id of ids) {
    if (skip.has(id)) continue;
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

// ── 安裝完整性自檢（W0-2/W0-5，SessionStart 消費）─────────────────────────────
// hook 接線對賬：hooks 目錄實存的 flow-*.mjs（排除 .test 與非註冊型）都應出現在 settings.json 文字裡。
// 「檔案在、沒接線」＝閘門形同虛設（flow-auto-gate 漏接線的實證教訓）。純函式，動作交呼叫端。
// C-3①：commit/auto/spec 三道閘門經 flow-dispatch 合併呼叫、**不直接註冊** settings.json（省 spawn），故從直接接線檢查豁免；
// 改由 dispatchWiringProblems 驗「flow-dispatch.mjs 真的引用三道」——防「合併後漏掉一道＝靜默失效」（同 W0-1 auto-gate 漏接線教訓）。
const WIRING_EXEMPT = new Set(['flow-precommit.mjs', 'flow-commit-gate.mjs', 'flow-auto-gate.mjs', 'flow-spec-gate.mjs']);
export function hookWiringProblems(hookFiles, settingsText) {
  const txt = String(settingsText || '');
  return (hookFiles || [])
    .filter((f) => /^flow-.+\.mjs$/.test(f) && !f.endsWith('.test.mjs') && !WIRING_EXEMPT.has(f))
    .filter((f) => !txt.includes(f));
}
export const DISPATCHED_GATES = ['flow-commit-gate.mjs', 'flow-auto-gate.mjs', 'flow-spec-gate.mjs'];
// 回 flow-dispatch.mjs 沒引用的閘門檔名（空＝三道都在）。純函式；dispatchSrc = flow-dispatch.mjs 全文。
export function dispatchWiringProblems(dispatchSrc) {
  const src = String(dispatchSrc || '');
  return DISPATCHED_GATES.filter((g) => !src.includes(g));
}

// 雙向同步對賬（來源 dist ↔ 安裝區）：內容 hash 不一致或安裝區缺檔都回報，differing 附 mtime 方向提示
// （installed 較新＝安裝區被熱修、記得回寫 dist；dist 較新＝改了源頭沒重裝）。
// 只掃核心（排除 *.test.mjs、settings.flow.json、install/、design-systems/ 大目錄）控制每 session 成本。
export async function syncDrift(srcDist, claudeHome) {
  const skipDirs = new Set(['design-systems', 'install']);
  const files = [];
  async function walk(rel) {
    let ents;
    try { ents = await readdir(path.join(srcDist, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skipDirs.has(e.name)) await walk(r); }
      else if (!e.name.endsWith('.test.mjs') && e.name !== 'settings.flow.json') files.push(r);
    }
  }
  await walk('');
  const missing = [];
  const differing = [];
  for (const rel of files) {
    const a = path.join(srcDist, rel);
    const b = path.join(claudeHome, rel);
    if (!existsSync(b)) { missing.push(rel); continue; }
    const [ba, bb] = await Promise.all([readFile(a), readFile(b)]);
    const ha = createHash('sha256').update(ba).digest('hex');
    const hb = createHash('sha256').update(bb).digest('hex');
    if (ha !== hb) {
      const [sa, sb] = await Promise.all([stat(a), stat(b)]);
      differing.push({ rel, newer: sb.mtimeMs > sa.mtimeMs ? 'installed' : 'dist' });
    }
  }
  return { missing, differing };
}

// C-3③：dist↔安裝區的「便宜指紋」（stat-only、兩側都算，不 read+hash）——session-start 據此決定要不要跑全量 syncDrift。
// 版本不變但任一側被熱修（mtime 前進）→ 指紋變 → 照樣全量比對（保留 W0-5「同版本熱修偵測」，使用者臨場改安裝區也抓得到）；
// 兩側都沒動 → 指紋同 → 略過全量（省每 session 的 60–120 檔 read+hash 開機稅）。缺檔也進指紋（missing 會變化）。
export async function syncFingerprint(srcDist, claudeHome) {
  const skipDirs = new Set(['design-systems', 'install']);
  let count = 0, maxMtime = 0, totalSize = 0;
  async function walk(rel) {
    let ents;
    try { ents = await readdir(path.join(srcDist, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!skipDirs.has(e.name)) await walk(rel ? `${rel}/${e.name}` : e.name); continue; }
      if (e.name.endsWith('.test.mjs') || e.name === 'settings.flow.json') continue;
      const relFile = rel ? `${rel}/${e.name}` : e.name;
      for (const base of [srcDist, claudeHome]) {
        try { const st = await stat(path.join(base, relFile)); count++; totalSize += st.size; if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs; }
        catch { count++; /* 缺檔也影響指紋（count 少一） */ }
      }
    }
  }
  await walk('');
  return `${count}:${Math.round(maxMtime)}:${totalSize}`;
}
