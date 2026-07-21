#!/usr/bin/env node
// flow-state — Flow .flow/ 狀態 CLI。換手接手用：冷啟動 reconstruct 純讀檔印現況 + 下一步 + 原子標完成。
// 全域裝一次（~/.claude/skills/flow-toolkit），對「當前專案」生效（讀 cwd 或 --root 的 .flow/）。
// 決策/討論一律回 Claude（彈窗）；狀態都在各專案的 .flow/。進度看這支的文字輸出；平行波看 /workflows。
import path from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import * as S from './statelib.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
// flag 值不接受以 -- 開頭（避免 `--choice --why x` 把 --why 當值，或缺值時吃到下個 flag）。
const flag = (n, d) => { const i = argv.indexOf(n); const v = i >= 0 ? argv[i + 1] : undefined; return (v !== undefined && !v.startsWith('--')) ? v : d; };
const root = path.resolve(flag('--root', process.cwd()));

// 解析 id 成 canonical；歧義（同尾段對多個 task）拒絕並列候選 exit 1，不靜默挑一個（decision/lesson 共用）。
async function resolveIdOrExit(id) {
  try { return await S.resolveId(root, id); }
  catch (e) { if (e && e.code === 'AMBIGUOUS_ID') { console.error('✗ ' + e.message); process.exit(1); } return id; }
}
// 紅軍 testFile 內容驗證（不只 existsSync 檔名）：非空 + 含測試框架關鍵字，堵「touch 空檔/恆綠殼即過閘」。
function testFileProblem(testFile) {
  if (!testFile) return '未填 testFile';
  const abs = path.resolve(root, testFile);
  if (!existsSync(abs)) return `testFile 不存在（${testFile}）`;
  let content = '';
  try { content = readFileSync(abs, 'utf8'); } catch { return `testFile 讀不到（${testFile}）`; }
  if (content.trim().length < 20) return `testFile 形同空檔（${testFile}）——touch 空檔不算 covered`;
  if (!/\b(test|it|describe|expect|assert)\b|def\s+test_|@Test/i.test(content)) return `testFile 不含測試框架關鍵字（${testFile}）`;
  return null;
}

// W3-2 pass 證據驗真：證據 SHALL 指向實存非空檔/目錄（trace/測試檔/報告），拉到與紅軍 testFileProblem 同強度——
// 「我保證通過」這種純敘述不算證據；人工驗證請把輸出存檔（如 .flow/verify/evidence-<id>.txt）再指過來。
// 相容 file:line 寫法（tests/auth.spec.ts:12 → 驗 tests/auth.spec.ts）。
function evidenceProblem(evidence, evidenceFile, opts = {}) {
  const cand = String(evidenceFile || evidence || '').trim().replace(/:\d+(?:[-:]\d+)?$/, '');
  if (!cand) return '缺證據';
  const abs = path.resolve(root, cand);
  if (!existsSync(abs)) return `證據不是實存檔（${cand}）——pass 證據 SHALL 指向實存的 trace/測試檔/量測報告；純敘述請先存檔再用 --evidence-file 指過來`;
  let isDir = false, body = '';
  try {
    const st = statSync(abs);
    isDir = st.isDirectory();
    if (isDir) { if (!readdirSync(abs).length) return `證據目錄是空的（${cand}）`; }
    else { if (st.size < 10) return `證據檔形同空檔（${cand}）——touch 空檔不算證據`; body = readFileSync(abs, 'utf8'); }
  } catch { return `證據讀不到（${cand}）`; }
  // C-11：量測型 pass 的證據內容 SHALL 佐證宣稱的實測值——防「拿任意實存檔（README/舊 log）當量測報告充數」。
  // 檔內須有與 --value ±10% 相符的數字（量測工具真輸出必含該數）；純字串證據（無檔）也掃自身。best-effort、只對量測型套。
  if (opts.value !== undefined && !isDir) {
    const target = Number(opts.value);
    const hay = body + '\n' + String(evidence || '');
    const nums = (hay.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    const tol = Math.max(Math.abs(target) * 0.1, 0.01);
    if (Number.isFinite(target) && !nums.some(n => Math.abs(n - target) <= tol))
      return `證據檔（${cand}）內容找不到與實測值 ${opts.value} 相符的數字（±10%）——像是拿了無關檔案充數；把量測工具的真實輸出存進去再指過來`;
  }
  return null;
}

// 現行 HEAD sha（best-effort；非 git/無 commit/失敗回 ''，不洩漏 git stderr）——trace 記「凍結/驗證在哪個 commit」的審計錨。
function gitHead(r) {
  try { return execSync('git rev-parse HEAD', { cwd: r, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

// C-7：兩個 commit 之間變動的檔名（review 新鮮度對賬用）。git 失敗回 null（無從判定→上層 fail-open，不憑空擋 ship）。
// H2-F1：fromRef 來自 findings.json 的 head 欄位（git-tracked、可被手改/merge 汙染）——先驗 sha 格式，
// 再走 execFileSync argv 陣列不經 shell，雙保險堵「head 欄位塞命令」的注入面。
function gitDiffNames(r, fromRef) {
  const ref = String(fromRef || '');
  if (!/^[0-9a-f]{7,40}$/i.test(ref)) return null;   // 非 sha ＝ 無從判定（同 git 失敗）
  try { return execFileSync('git', ['diff', '--name-only', `${ref}..HEAD`], { cwd: r, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').map(s => s.trim()).filter(Boolean); }
  catch { return null; }
}
// 變動檔是否含「非測試、非文件/設定、非 Flow 自身狀態」的原始碼（review 新鮮度只在真的改了 code 時要求重審）。
function sourceChanged(files) {
  return (files || []).filter(f =>
    !/(^|\/)\.flow\//.test(f) &&                                  // Flow 自身 ledger/journal/trace，非產品原始碼
    !/(^|\/)(tests?|__tests__|spec|e2e)\//i.test(f) &&
    !/\.(test|spec)\.[jt]sx?$/i.test(f) &&
    !/\.(md|txt|json|ndjson|lock|ya?ml|toml|cfg|ini|env)$/i.test(f));
}

// git 真實變動檔（staged + unstaged + untracked）。模型偽造不了——這是 scope 閘門的事實來源。
// W3-3①：git 失敗回 null（非 []）——「查不到」不等於「零變動」，scope 閘門對 null fail-closed。
function gitChangedFiles(r) {
  let out = '';
  // -uall：展開未追蹤目錄到「個別檔」（預設會把整個未追蹤目錄收合成一行，scope 比對需要檔案層級）。
  // core.quotepath=false：中文/非 ASCII 檔名輸出 UTF-8 原文而非 octal escape（否則 zone 比對必假陽性）。
  try { out = execSync('git -c core.quotepath=false status --porcelain -uall', { cwd: r, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let p = line.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ')[1]; // rename：取新路徑
    files.push(p.replace(/^"(.*)"$/, '$1'));         // 去掉 git 對特殊字元加的引號
  }
  return files;
}

// 自駕護欄判定（mode auto 與 guardrail-check 共用）：settings.json 須同時掛 stall 斷路器＋auto-gate 三道硬擋。
// W0-3：mode auto 落檔前直接呼叫，未過 exit 2——「啟動前提」是機器擋、不是散文提醒（auto-gate 曾漏接線形同虛設的教訓）。
function claudeHomeDir() {
  return flag('--claude-home') || process.env.CLAUDE_HOME ||
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude');
}
function guardrailProblem(home) {
  let raw = '';
  try { raw = readFileSync(path.join(home, 'settings.json'), 'utf8'); }
  catch { return `找不到 ${path.join(home, 'settings.json')}——無法確認護欄在線。先跑 install 裝 Flow hooks 再啟用自駕。`; }
  // C-3①：auto-gate 併入 flow-dispatch 後不直接註冊 settings.json——「settings 掛 dispatch ＋ dispatch 真引用 auto-gate」視同在線
  // （同 statelib dispatchWiringProblems 的對賬思路）；直連舊接線向後相容。
  let autoGateOn = /flow-auto-gate\.mjs/.test(raw);
  if (!autoGateOn && /flow-dispatch\.mjs/.test(raw)) {
    try { autoGateOn = readFileSync(path.join(home, 'hooks', 'flow-dispatch.mjs'), 'utf8').includes('flow-auto-gate.mjs'); }
    catch { /* dispatch 檔讀不到＝不得視同在線 */ }
  }
  const missing = [];
  if (!/flow-stall-monitor\.mjs/.test(raw)) missing.push('flow-stall-monitor（doom-loop 斷路器）');
  if (!autoGateOn) missing.push('flow-auto-gate（自駕三道硬擋：裝新相依/破壞性 DB/doom-loop 天花板；直連或經 flow-dispatch 引用皆可）');
  if (!missing.length) return null;
  return `自駕護欄缺失：settings.json 沒有 ${missing.join('、')}。無花費上限下這是唯一剎車——重跑 install 裝齊 hooks 再啟用自駕，或本次走「每階段停」。`;
}

// journey-check 用：遞迴撈測試檔（*.spec/.test/.e2e），跳過 node_modules 等重目錄與 dot 目錄、限深防失控。
const SKIP_WALK = new Set(['node_modules', 'dist', 'build', 'out', '.next', 'coverage', 'test-results', '__pycache__', 'venv', '.venv', 'vendor', 'target']);
const TEST_FILE_RE = /\.(?:spec|test|e2e)\.[mc]?[jt]sx?$/i;
function walkTestFiles(base, acc = [], depth = 0) {
  if (depth > 8) return acc;
  let ents;
  try { ents = readdirSync(base, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (e.isDirectory()) { if (!SKIP_WALK.has(e.name) && !e.name.startsWith('.')) walkTestFiles(path.join(base, e.name), acc, depth + 1); }
    else if (TEST_FILE_RE.test(e.name)) acc.push(path.join(base, e.name));
  }
  return acc;
}
// journey-check 用：撈 playwright.config.*（retries/webServer 掃描）。同 walkTestFiles 的限深/跳重目錄。
const CONFIG_FILE_RE = /^playwright\.config\.[mc]?[jt]s$/i;
function walkConfigFiles(base, acc = [], depth = 0) {
  if (depth > 8) return acc;
  let ents;
  try { ents = readdirSync(base, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (e.isDirectory()) { if (!SKIP_WALK.has(e.name) && !e.name.startsWith('.')) walkConfigFiles(path.join(base, e.name), acc, depth + 1); }
    else if (CONFIG_FILE_RE.test(e.name)) acc.push(path.join(base, e.name));
  }
  return acc;
}

// coverage 用：讀 requirements.md 的 REQ-E2E-* 清單 + .flow/verify 記錄，對賬。requirements.md 缺則 skipped。
async function coverageReport(r) {
  const rp = path.join(r, 'specs', 'requirements.md');
  if (!existsSync(rp)) return { skipped: true };
  const reqIds = S.extractReqE2E(readFileSync(rp, 'utf8'));
  return { skipped: false, audit: S.coverageAudit(reqIds, await S.listVerifyRecords(r)) };
}
function printCoverage(audit) {
  console.log(`\nREQ-E2E 覆蓋：${audit.covered.length}/${audit.total} 已驗綠（pass/n-a）`);
  if (audit.missing.length) { console.error('  ✗ 缺驗證記錄（requirements.md 有、.flow/verify 無）：'); for (const id of audit.missing) console.error('    · ' + id); }
  if (audit.failed.length) { console.error('  ✗ 記錄為未通過：'); for (const f of audit.failed) console.error(`    · ${f.id}（status=${f.status}）`); }
  if (audit.orphans.length) console.log('  ⚠ 記錄了但 requirements.md 查無（拼錯/已刪？）：' + audit.orphans.join(', '));
}

// mockup-check / spec-ready --freeze 共用：互動原型走查台的覆蓋骨架機檢（statelib.mockupAudit 是純核心）。
function mockupProblems(r, dirRel) {
  const dir = path.join(r, dirRel);
  const idx = path.join(dir, 'index.html');
  const disp = String(dirRel).replace(/\\/g, '/');
  if (!existsSync(idx)) return { problems: [`查無 ${disp}/index.html（journey 走查台）——互動原型 SHALL 有走查台：每條 REQ-E2E 一張卡（id＋步驟＋入口連結）`] };
  const rp = path.join(r, 'specs', 'requirements.md');
  const audit = S.mockupAudit(existsSync(rp) ? readFileSync(rp, 'utf8') : '', readFileSync(idx, 'utf8'));
  const problems = [];
  for (const id of audit.missingReq) problems.push(`${id} 不在走查台 index.html——每條 REQ-E2E SHALL 列卡（id＋步驟＋入口連結），缺卡＝該 journey 沒原型可走`);
  // 零入口連結＝journey 沒得點：缺卡檢查只驗 id 字串，404/空殼檢查全掛在 hrefs 上——
  // index 只列 id 文字、一個本地連結都不放，等於整鏈空轉（省事模型最低成本過關路徑），硬擋。
  if (audit.reqIds.length > 0 && audit.hrefs.length === 0)
    problems.push('走查台零本地入口連結——每張 REQ-E2E 卡 SHALL 含入口連結（<a href> 連到本地頁），否則 journey 沒得點＝假走查台');
  for (const h of audit.hrefs) {
    const abs = path.resolve(dir, h);
    if (!existsSync(abs)) { problems.push(`走查台連結 404：${h}（index.html 連到但檔案不存在＝假走查）`); continue; }
    // 空殼頁機檢（W0-8）：連到的每頁 SHALL 引用 app.js 且含互動元素——「有卡但頁面空殼」不算原型
    let page = '';
    try { page = readFileSync(abs, 'utf8'); } catch { problems.push(`走查台連結讀不到：${h}`); continue; }
    for (const p of S.mockupPageProblems(page)) problems.push(`${h}：${p}`);
    // 頁內引用的本地 script 須實存（掛了 <script src="app.js"> 但檔案缺＝CRUD 全無後果的空殼）
    for (const sm of page.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)) {
      const src = sm[1];
      if (/^(https?:|\/\/|data:)/i.test(src)) continue;
      if (!existsSync(path.resolve(path.dirname(abs), src.split(/[?#]/)[0])))
        problems.push(`${h}：引用的 script 不存在：${src}（掛了 script 但檔案缺＝假資料層失效、CRUD 無後果）`);
    }
  }
  return { problems, audit };
}

// pickNext 已移到 statelib（resume 與 SessionStart hook 共用，避免兩份邏輯漂移）。

async function resume() {
  const view = await S.reconstruct(root);
  const L = [];
  L.push(`\n=== flow resume :: ${view.manifest.project || '(未命名)'}  (phase: ${view.manifest.phase || '?'}) ===`);
  // 計數/模式/待決策/mid-task checkpoint/dangling/死路/下一步：與 SessionStart hook 同一份摘要邏輯
  for (const line of S.summarizeView(view)) L.push(line);
  // 純檔案對帳（ledger=唯一真相）：崩潰在 markTaskDone 跨檔三步中途、或 done 後 commit 前當機會留分歧
  const tp = path.join(root, 'specs', 'tasks.md');
  const rec = S.reconcile(existsSync(tp) ? readFileSync(tp, 'utf8') : '', await S.listLedger(root));
  if (rec.checkedButNotDelivered.length || rec.deliveredButNotChecked.length) {
    L.push('', '⚠ tasks.md 與 ledger 對不上（多半是上次標完成時當機）——跑 `flow-state done <id>` 冪等重同步：');
    for (const id of rec.checkedButNotDelivered) L.push(`   - ${id}：tasks.md 已 [x] 但 ledger 未 delivered`);
    for (const id of rec.deliveredButNotChecked) L.push(`   - ${id}：ledger 已 delivered 但 tasks.md 還 [ ]`);
  }
  if (rec.deliveredNoCommit.length) {
    L.push('', '⚠ 這些 task 已交付但沒記 commit sha（可能 done 後 commit 前當機）——確認 git 有對應 commit，或補 `flow-state done <id> --commit <sha>`：');
    for (const id of rec.deliveredNoCommit) L.push(`   - ${id}`);
  }
  // 開發中 task 可能有 worker 寫了還沒 commit 的半成品 → 提示用 git status 查（不重造 git-tools 的輪子）
  if (Object.values(view.tasks).some(t => t.state === 'building')) {
    L.push('', '提示：有開發中 task，未 commit 的半成品跑 `git status` 查（接續別重做已寫好的、別覆蓋）。');
  }
  L.push('');
  console.log(L.join('\n'));
  return view;
}

switch (cmd) {
  case 'resume':
  case 'status':
    await resume();
    break;
  case 'done': {
    // 原子完成一個 task：翻 tasks.md [x] + ledger→delivered。一個指令取代三條會被漏掉的散文步驟。
    // 自帶 done 閘門（statelib）：state.json verify/tdd 空/none → exit 2（先真跑 /flow-verify）；交付即把綠燈歸零。
    // 用法：flow-state done <taskId> [--commit <sha>]（taskId 可給 canonical 或唯一尾段如 W0-5）
    const id = argv[1];
    if (!id || id.startsWith('--')) { console.error('usage: flow-state done <taskId> [--commit <sha>]'); process.exit(1); }
    const commit = flag('--commit');
    let r;
    try {
      r = await S.markTaskDone(root, id, commit ? { commit } : {});
    } catch (e) {
      if (e && e.code === 'VERIFY_GATE') { console.error(e.message); process.exit(2); }   // 確定性 done 閘門：沒真驗綠不准 delivered
      if (e && e.code === 'AMBIGUOUS_ID') { console.error('✗ ' + e.message); process.exit(1); }
      throw e;
    }
    if (!((await S.readManifest(root)).tasks || []).some(t => t.id === r.id))
      console.error(`⚠ manifest 查無「${r.id}」——已以原樣建 ledger（id 打錯？canonical id 見 .flow/manifest.json）`);
    // 自動 stage 耐久證據 + tasks.md，讓緊接著的 per-task commit 一定帶上它們——耐久檔不再落隊（症狀根治）。
    // 先確保 .flow/.gitignore 就位（舊專案初次跑到這裡也補上），瞬時檔（state.json 等）才不會被 -A 吃進 staging。
    // 全程 fail-open：非 git repo / git 不可用一律略過，交付本身絕不受影響。
    let staged = false;
    try {
      await S.ensureFlowGitignore(root);
      execSync('git add -A -- .flow', { cwd: root, stdio: 'ignore' });
      const tp = path.join(root, 'specs', 'tasks.md');
      if (existsSync(tp)) execSync('git add -- "specs/tasks.md"', { cwd: root, stdio: 'ignore' });
      staged = true;
    } catch { /* 非 git / git 失敗 → 略過，交付不受影響（下次 commit 前 smart-commit 會再收） */ }
    // W4-4：交付即順手歸檔已終局 task 的 journal 事件（歸檔不刪、防長程 O(全史) 重讀單調變慢）。fail-silent。
    try {
      const view2 = await S.reconstruct(root);
      const deliveredIds = Object.values(view2.tasks).filter((t) => t.state === 'delivered').map((t) => t.id);
      const a = await S.archiveJournal(root, deliveredIds);
      if (a.archived) console.log(`  🧹 journal 歸檔：${a.archived} 筆已終局事件 → .flow/archive/journal.ndjson（主檔剩 ${a.kept} 筆，可回溯）。`);
    } catch { /* 歸檔非關鍵，失敗不影響交付 */ }
    const md = r.tasksMd.changed ? 'tasks.md [x] 已翻' : (r.tasksMd.found ? 'tasks.md 本已 [x]' : '⚠ tasks.md 無對應行（id 對不上？）');
    const lg = r.alreadyDelivered ? 'ledger 本已 delivered' : 'ledger→delivered';
    console.log(`✓ ${r.id}：${md}；${lg}${commit ? `；commit=${commit}` : ''}`);
    console.log(`  下一步：照常 git commit（commit gate 已可放行此 task）${staged ? '；已自動 stage .flow 耐久證據＋tasks.md、不會落隊' : ''}。`);
    break;
  }
  case 'verify-ok': {
    // C-10：verify/tdd 寫入 state.json 的唯一正門（取代裸寫——flow-spec-gate 會擋裸寫 verify/tdd）。
    // 有 runner 優先用 `run --task`（真跑捕真 exit code）；手動/無法自動化的驗證走本命令（留 journal 審計線）。
    // 用法：flow-state verify-ok <taskId> --ref "<真證據 ref>" [--tdd <green|refactored|n/a|skipped:...>]
    const id = argv[1];
    if (!id || id.startsWith('--')) { console.error('usage: flow-state verify-ok <taskId> --ref "<證據ref>" [--tdd <green|refactored|n/a|skipped:...>]'); process.exit(1); }
    const ref = (flag('--ref') || '').trim();
    if (!ref) { console.error('需給 --ref（真證據：trace 路徑/測試名/verify-e2e id——空 ref 不算驗證）'); process.exit(1); }
    const tdd = (flag('--tdd') || 'green').trim();
    const rid = await resolveIdOrExit(id);
    const st = await S.readStateJson(root);
    await S.writeStateJson(root, { ...st, verify: `ok:${ref}`, tdd });
    await S.appendJournal(root, { ev: 'verify.ok', id: rid, ref, tdd });
    console.log(`✓ ${rid}：verify="ok:${ref}"、tdd="${tdd}" 已寫入 state.json（done 閘門認得）。`);
    console.log(`  若有 runner，建議先 flow-state run --task ${rid} -- <測試命令> 真跑綠更硬（done 會擋「跑過但最後紅」）。`);
    break;
  }
  case 'mode': {
    // 設定推進模式，寫進 git-tracked manifest（換機 clone 後自駕不掉回 manual）+ state.json（相容既有讀取）。
    // 用法：flow-state mode <auto|manual> [--claude-home <dir>]
    // W0-3：auto 內建 guardrail——護欄（stall 斷路器＋auto-gate）不在線就 exit 2 拒寫，不再只印提醒。
    const m = argv[1];
    if (m !== 'auto' && m !== 'manual') { console.error('usage: flow-state mode <auto|manual>'); process.exit(1); }
    if (m === 'auto') {
      const gp = guardrailProblem(claudeHomeDir());
      if (gp) { console.error('✗ ' + gp); console.error('  未過 guardrail → 拒絕寫入 mode=auto（啟動前提是機器擋、不是提醒）。'); process.exit(2); }
    }
    const manifest = await S.readManifest(root);
    await S.writeManifest(root, { ...manifest, mode: m });
    const st = await S.readStateJson(root);
    await S.writeStateJson(root, { ...st, mode: m });
    console.log(`✓ 推進模式設為 ${m}：寫進 .flow/manifest.json（進 git、換機 clone 後保留）+ state.json。`);
    if (m === 'auto') console.log('  ✓ guardrail 已過：stall 斷路器＋auto-gate 在線。');
    break;
  }
  case 'journal-archive': {
    // W4-4 手動觸發（/flow-compact 收束時跑；done 交付時也會自動順手做）：歸檔不刪、可回溯。
    const view = await S.reconstruct(root);
    const deliveredIds = Object.values(view.tasks).filter((t) => t.state === 'delivered').map((t) => t.id);
    const a = await S.archiveJournal(root, deliveredIds);
    console.log(a.archived
      ? `✓ journal 歸檔：搬 ${a.archived} 筆已終局事件 → .flow/archive/journal.ndjson；主檔剩 ${a.kept} 筆。`
      : `✓ 無可歸檔事件（主檔 ${a.kept} 筆，皆未終局或全域事件）。`);
    break;
  }
  case 'project-type': {
    // 專案類型正門（W0-5）：/flow-spec Step 1 併入首輪訪談彈窗跟使用者拍板後落檔（模型只提建議）。
    // spec-ready --freeze 對賬這筆記錄：缺檔凍不了；web 類無互動原型且無 mockup-waiver → exit 2。
    // 用法：flow-state project-type <type>
    const t = argv[1];
    if (!S.PROJECT_TYPES.includes(t)) { console.error(`usage: flow-state project-type <${S.PROJECT_TYPES.join('|')}>`); process.exit(1); }
    const manifest = await S.readManifest(root);
    await S.writeManifest(root, { ...manifest, projectType: t });
    const st = await S.readStateJson(root);
    await S.writeStateJson(root, { ...st, projectType: t });
    console.log(`✓ projectType=${t} 已落檔（manifest+state.json）。${S.WEB_PROJECT_TYPES.includes(t)
      ? 'web 類：凍結時 SHALL 有互動原型過 mockup-check，或使用者拍板豁免（flow-state decision mockup-waiver）。'
      : '非 web：凍結時不強制互動原型（enum 記錄本身即豁免）。'}`);
    break;
  }
  case 'checkpoint': {
    // mid-task 檢查點（修「開發中當機就重跑整個 task」）：worker 跑到某 TDD 相/整合階段記一筆。
    // 冷啟動 reconstruct 取每 task 最新一筆 → flow-state resume/SessionStart 顯示「上次做到第幾步」，接續只補沒做完的。
    // 用法：flow-state checkpoint <taskId> --phase <red|green|refactor|integrated|自由> [--note "<一句話>"]
    const id = argv[1];
    if (!id || id.startsWith('--')) { console.error('usage: flow-state checkpoint <taskId> --phase <red|green|refactor|integrated> [--note "<一句>"]'); process.exit(1); }
    const phase = flag('--phase');
    if (!phase) { console.error('需給 --phase（這個 task 現在做到第幾步：red|green|refactor|integrated 或自由字串）'); process.exit(1); }
    // W3-1 早期攔截：dispatch 一波時記 `checkpoint <代表task> --phase dispatched --wave <本波ids>`——
    // 對賬 wave-plan（本波成員＝某波、manifest 未漂移），比整合前的 scope --wave 更早擋自行併/拆波。無 --wave 就照舊單 task。
    const dispatchWave = (flag('--wave') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (phase === 'dispatched' && dispatchWave.length) {
      const wmp = S.waveMembershipProblem(await S.readWavePlan(root), await S.readManifest(root), dispatchWave);
      if (wmp) { console.error('✗ ' + wmp); process.exit(2); }
    }
    const rid = await resolveIdOrExit(id);
    await S.recordCheckpoint(root, rid, phase, flag('--note') || '');
    console.log(`✓ 已記 checkpoint：${rid} → ${phase}${flag('--note') ? `（${flag('--note')}）` : ''}`);
    console.log('  中斷重啟後 flow-state resume 會帶出最新一筆，接續只補沒做完的相、不重跑整個 task。');
    break;
  }
  case 'scope': {
    // 同 repo 平行的檔案安全閘門：本波各 feature 宣告的 conflictZone vs git 真實變動。
    // 用法：flow-state scope --wave F-1,F-2（zones 讀 manifest.tasks[].conflictZone）。
    // 任一變動檔落在所有 conflictZone 之外（worker 越界改了共用檔/foundation）→ exit 2 擋整合。
    const wave = (flag('--wave') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!wave.length) { console.error('usage: flow-state scope --wave <id1,id2,...>'); process.exit(1); }
    // scope 只需 manifest 的 conflictZone，不必跑全量 reconstruct（省讀 state.json + 全 ledger + journal）。
    const manifest = await S.readManifest(root);
    const byId = Object.fromEntries((manifest.tasks || []).map((t) => [t.id, t]));
    const zonesByFeature = {}, missing = [];
    for (const id of wave) {
      const cz = byId[id] && byId[id].conflictZone;
      if (!cz || !cz.length) missing.push(id); else zonesByFeature[id] = cz;
    }
    if (missing.length) {
      console.error(`✗ scope 無法檢查：這些 task 在 manifest 沒宣告 conflictZone → ${missing.join(', ')}`);
      console.error('  先在 specs/tasks.md 標 conflictZone 並同步進 manifest（flow-plan Step 5）。無宣告＝無法強制檔案安全。');
      process.exit(2);
    }
    // W3-1 增驗：本波成員 SHALL == wave-plan 某一波、且 manifest 未漂移——堵「整合時自行併/拆波或用 plan 後改過的 manifest」（H6）。
    // 無 wave-plan：單 task scope 向後相容放行；但「多 task 併波整合」缺 wave-plan＝沒算過拓樸依賴序就自行併波 → fail-closed exit 2
    // （把 flow-build Step 1「起手跑 wave --compute」的散文前置升級成確定性閘門，堵有依賴卻沒算波次就整合）。
    const wp = await S.readWavePlan(root);
    if (!wp && wave.length > 1) {
      console.error('✗ 尚未算波次就要整合多個 task——先跑 flow-state wave --compute（拓樸依賴序＋zone 互斥），再照它算出的波整合。');
      console.error('  （堵「有依賴卻沒算波次就自行併波整合」；單 task scope 不受此限。）');
      process.exit(2);
    }
    const wmp = S.waveMembershipProblem(wp, manifest, wave);
    if (wmp) { console.error('✗ ' + wmp); process.exit(2); }
    const changed = gitChangedFiles(root);
    if (changed === null) {
      console.error('✗ git 不可用/查詢失敗——無法確認真實檔案變動，scope fail-closed 暫停整合（別把「查不到」當「零變動」放行）。');
      process.exit(2);
    }
    const r = S.checkScope(changed, zonesByFeature);
    if (r.attributed.length) { console.log('檔案歸屬：'); for (const a of r.attributed) console.log(`  ${a.file} → ${a.feature}`); }
    if (r.overlaps.length) {
      console.log('\n⚠ conflictZone 重疊（規劃問題，本應互斥；同波兩 feature 改同檔有覆寫風險）：');
      for (const o of r.overlaps) console.log(`  ${o.file} ∈ ${o.features.join(', ')}`);
    }
    if (!r.ok) {
      console.error('\n✗ 檔案越界：以下變動落在所有 conflictZone 之外（worker 越界改了共用檔/foundation，會造成 merge 地獄/破壞接縫契約）：');
      for (const v of r.violations) console.error(`  ${v.file}`);
      console.error('  暫停整合：查是哪個 worker 越界、該檔是否該走序列 foundation；別硬整合（這是同 repo 平行的檔案安全底線）。');
      process.exit(2);
    }
    console.log('\n✓ 無檔案越界：本波所有變動都落在宣告的 conflictZone 內。');
    break;
  }
  case 'wave': {
    // W3-1+W3-2：算波次拓樸（blockedBy 依賴序＋conflictZone 互斥自動拆波）＋逐字抽每 task 承接的 REQ 區塊
    // → 落 .flow/trace/wave-plan.json（含 manifest hash + reqHash）。dispatch 唯一事實來源，取代模型臨場心算波次。
    // 用法：flow-state wave --compute
    if (!argv.includes('--compute')) { console.error('usage: flow-state wave --compute'); process.exit(1); }
    const manifest = await S.readManifest(root);
    if (!((manifest.tasks || []).length)) { console.error('✗ manifest 無 task——先 /flow-plan 產計畫（plan-check 綠）再算波次。'); process.exit(2); }
    const idx = await S.readReqIndex(root);
    if (!idx) { console.error('✗ 查無 .flow/trace/req-index.json——先 flow-state spec-ready --freeze 凍結需求（逐字投餵的凍結分母）再算波次。'); process.exit(2); }
    const rp = path.join(root, 'specs', 'requirements.md');
    const reqMd = existsSync(rp) ? readFileSync(rp, 'utf8') : '';
    const hp = S.reqHashProblem(idx, reqMd);   // 逐字文字 SHALL 來自凍結版——現行 requirements 漂移即擋（別餵 worker 漂移規格）
    if (hp) { console.error('✗ ' + hp); process.exit(2); }
    const tp = path.join(root, 'specs', 'tasks.md');
    const tasksMd = existsSync(tp) ? readFileSync(tp, 'utf8') : '';
    // delivered 集合：reconstruct 合併 manifest→state→ledger 的權威狀態（判 blockedBy 是否已滿足）
    const view = await S.reconstruct(root);
    const delivered = Object.values(view.tasks).filter((t) => t.state === 'delivered').map((t) => t.id);
    const plan = S.buildWavePlan(manifest, delivered, tasksMd, reqMd, idx);
    if (plan.problems && plan.problems.length) {
      console.error('✗ 波次計算未過：');
      for (const p of plan.problems) console.error('  - ' + p);
      process.exit(2);
    }
    await S.writeWavePlan(root, { ...plan, head: gitHead(root) });
    const nTask = plan.waves.reduce((n, w) => n + w.length, 0);
    console.log(`✓ 波次已算：${plan.waves.length} 波、${nTask} 個未交付 task（已排除 delivered）。落 .flow/trace/wave-plan.json。`);
    for (let i = 0; i < plan.waves.length; i++) console.log(`  Wave ${i}: ${plan.waves[i].map((t) => t.id).join(', ')}`);
    if (plan.warnings && plan.warnings.length) { console.log('\n⚠ 並行度提醒（conflictZone 重疊自動拆波）：'); for (const w of plan.warnings) console.log('  · ' + w); }
    console.log('\n  dispatch 時：worker prompt 直接用 wave-plan 該 task 的逐字 reqText（不叫 worker 自讀 requirements.md，堵版本漂移）；');
    console.log('  整合前 flow-state scope --wave 會對賬「本波成員＝wave-plan 某波、manifest 未漂移」。manifest 若合法改動 → 重跑本指令。');
    break;
  }
  case 'redteam': {
    // 紅軍對賬閘門（確定性，整合前與 scope 一起跑）：驗 .flow/redteam/<id>.json 存在、
    // 每個 high 攻擊有 status=covered 的對應項、且其 testFile 真實存在（檔案存在性 worker 偽造不了）。
    // 檔案格式（orchestrator 從 parallel-build 回傳落檔）：{ attacks: [...redTeam], coverage: [...attackCoverage] }
    // 用法：flow-state redteam --wave F-1,F-2
    const wave = (flag('--wave') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!wave.length) { console.error('usage: flow-state redteam --wave <id1,id2,...>'); process.exit(1); }
    const problems = [];
    for (const id of wave) {
      const p = path.join(root, '.flow', 'redteam', id + '.json');
      if (!existsSync(p)) { problems.push(`${id}：缺 .flow/redteam/${id}.json（紅軍清單未落檔——flow-build Step 2 漏了）`); continue; }
      let rec;
      try { rec = JSON.parse(readFileSync(p, 'utf8')); } catch { problems.push(`${id}：.flow/redteam/${id}.json 不是合法 JSON`); continue; }
      // 數量下限鏡射 ATTACK_SCHEMA 的 minItems:3——schema 只守 Workflow fan-out 路徑，
      // 本檔可由模型親手落檔（輕量路徑/orchestrator），attacks 空/太少＝紅軍空轉，閘門端同擋。
      if (!Array.isArray(rec.attacks) || rec.attacks.length < 3) {
        problems.push(`${id}：紅軍清單少於 3 個攻擊（現 ${Array.isArray(rec.attacks) ? rec.attacks.length : 0} 個）——攻擊面至少列 3 個（邊界值/併發/惡意輸入/相依故障/配置漂移），別省`);
        continue;
      }
      const coverage = rec.coverage || [];
      for (const a of (rec.attacks || [])) {
        const sev = String(a.severity || '').toLowerCase();
        // severity 缺失/非法值（''/'critical'）＝自報資料可疑，fail-safe 從嚴比照 high（否則掉出 high 分支只剩關鍵字網）
        const sevKnown = ['high', 'medium', 'low'].includes(sev);
        const c = coverage.find((x) => x.attackId === a.id && x.status === 'covered');
        if ((sev === 'high' || !sevKnown) && !c) { problems.push(`${id}/${a.id}（${sevKnown ? sev : `severity 非法值「${a.severity || ''}」，比照 high`}）：無 covered 對應項——high 攻擊不准 skipped，先補失敗安全測試轉綠`); continue; }
        // 任何 covered（含 medium/low）都驗 testFile 真實有效（非空 + 含測試關鍵字），堵「touch 空檔即過閘」
        if (c) { const prob = testFileProblem(c.testFile); if (prob) problems.push(`${id}/${a.id}（${sev || '?'}）：${prob}——coverage 是自報的，檔案得真的是測試`); continue; }
        // 高危關鍵字 floor（W0-6）：severity 自報調不鬆這道——攻擊文字命中高危面（auth/注入/權限/金流…）
        // 就禁無痕跳過：沒 covered 須有使用者拍板的豁免檔（誤中的代價＝多留一筆可稽核豁免，fail-safe 方向）。
        if (S.isHighRiskAttackText(`${a.scenario || ''} ${a.failingTestHint || ''}`)
            && !existsSync(path.join(root, '.flow', 'decisions', `redteam-waiver-${id}-${a.id}.json`)))
          problems.push(`${id}/${a.id}（${sev || '?'}）：攻擊涉及高危面（auth/注入/權限/金流…）不准無痕跳過——補失敗安全測試轉 covered，或使用者拍板豁免：flow-state decision redteam-waiver-${id}-${a.id} --choice "skip" --why "<理由>"`);
      }
    }
    if (problems.length) {
      console.error('✗ 紅軍對賬未過：');
      for (const x of problems) console.error('  ' + x);
      // C-49：擋因透明化——分兩類觸發，讓使用者一眼看懂為何連標 low 的攻擊也要處理（floor 硬度不變、只把「為何被擋」講清）：
      console.error('  ┌ 擋因分兩類：');
      console.error('  │ ① severity 觸發：high（或 severity 非法值比照 high）攻擊必須 covered。');
      console.error('  │ ② 高危關鍵字觸發：攻擊文字命中 auth/注入/權限/金流… 即使標 low 也不准無痕跳過（fail-safe，誤中代價＝多留一筆可稽核豁免）。');
      console.error('  └ ② 類確實不適用：flow-state decision redteam-waiver-<id>-<attackId> --choice skip --why "<理由>"（正式波次仍維持攻擊 ≥3）。');
      console.error('  暫停整合：補測試/落檔後重跑。別跳過本閘門硬整合（high 攻擊面沒防禦＝出貨即漏洞）。');
      process.exit(2);
    }
    console.log('✓ 紅軍對賬通過：攻擊 ≥3、high 全 covered、testFile 實存、高危攻擊無無痕跳過。');
    break;
  }
  case 'decision': {
    // 記一個自駕自決分歧（T1 放手下、spec 沒釘死的 C 類需求分歧由 AI 自決並留審計）。
    // 用法：flow-state decision <taskId> --choice "<決定了什麼>" --why "<理由>" [--question "<分歧點>"]
    // 全部自決也都進 journal（ev:'decision'，append-only 審計線），decisions/<id>.json 留最新快照。
    const id = argv[1];
    if (!id || id.startsWith('--')) { console.error('usage: flow-state decision <taskId> --choice "<決定>" --why "<理由>" [--question "<分歧>"]'); process.exit(1); }
    const choice = flag('--choice') || '';
    if (!choice) { console.error('需給 --choice（你自決了什麼）'); process.exit(1); }
    const rid = await resolveIdOrExit(id);
    // H2-F4（體檢）：豁免/定版檔靠字面 id 精確比對才生效——打錯字會「看起來記成功」但永遠不被閘門認得＝無聲失守。
    // 觸發二選一：id 含 waiver/signoff 字樣、或與已知豁免 id 編輯距離 ≤2（抓 perf-waver 這類掉字母型）。
    // 自由形自決 id（兩者皆否，如 D-1/e2e-na-1）不受限。redteam-waiver-<taskId>-<attackId> 動態形只驗前綴結構。
    const KNOWN_WAIVERS = ['mockup-waiver', 'perf-waiver', 'plan-check-waiver', 'code-review-waiver', 'journey-waiver', 'retry-waiver', 'ui-signoff'];
    const lev = (a, b) => {
      const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
      for (let j = 1; j <= b.length; j++) d[0][j] = j;
      for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      return d[a.length][b.length];
    };
    const isKnownWaiver = KNOWN_WAIVERS.includes(rid) || /^redteam-waiver-.+-.+$/.test(rid);
    if (!isKnownWaiver && (/waiver|signoff/i.test(rid) || KNOWN_WAIVERS.some(k => lev(rid.toLowerCase(), k) <= 2))) {
      console.error(`✗ 未知的豁免/定版 id「${rid}」——豁免檔靠字面 id 精確比對，拼錯會記成功但永遠不生效。合法形：`);
      console.error('  ' + KNOWN_WAIVERS.join(' | ') + ' | redteam-waiver-<taskId>-<attackId>');
      process.exit(1);
    }
    // 審計語意：waiver/signoff 類（perf-waiver/mockup-waiver/redteam-waiver-*/ui-signoff）規格上是
    // 「使用者彈窗拍板後留檔」，預設記 by:'user'；其餘（自駕 C 類自決）預設 by:'auto'。--by 可明示覆寫。
    const by = flag('--by') || (/waiver|signoff/i.test(rid) ? 'user' : 'auto');
    if (by !== 'user' && by !== 'auto') { console.error('--by 須為 user / auto'); process.exit(1); }
    // C-8：自駕下 AI 不得自建 waiver/signoff——那等於冒使用者名義關掉一道出貨安全門。改記待決單、收尾彈窗請使用者拍板。
    if (/waiver|signoff/i.test(rid) && (await S.reconstruct(root)).mode === 'auto') {
      console.error(`✗ 自駕模式下不可自建豁免/定版單（${rid}）——那等於 AI 冒你的名義關掉一道出貨安全門。`);
      console.error(`  → 改記待決單：flow-state pending add ${rid} --why "<為何需要豁免>"；自駕收尾時會一批彈窗請使用者拍板。`);
      process.exit(2);
    }
    try { await S.recordDecision(root, rid, { question: flag('--question') || '', choice, why: flag('--why') || '', by }); }
    catch (e) { if (e && e.code === 'UNSAFE_ID') { console.error('✗ ' + e.message); process.exit(1); } throw e; }
    console.log(`✓ ${by === 'user' ? '已記使用者拍板' : '已記自決'}：${rid}：${choice}${flag('--why') ? `（${flag('--why')}）` : ''}`);
    console.log('  審計線在 .flow/journal.ndjson（ev:decision）；最新快照在 .flow/decisions/。使用者可事後翻、要改再說。');
    break;
  }
  case 'pending': {
    // 待決單（C-8）：自駕碰到「重試仍過不了」的關卡 → 記一張、繼續其他工作不中斷；收尾一批彈窗請使用者拍板。
    // 取代「AI 自建 waiver 冒名關掉出貨門」。complete-check 對 pending 非空 exit 2（有待決＝不得自稱出貨）。
    // 用法：flow-state pending add <id> --why "<為何過不了>" | list | resolve <id> [--how "<處理>"]
    const sub = argv[1];
    if (sub === 'add') {
      const id = argv[2];
      if (!id || id.startsWith('--')) { console.error('usage: flow-state pending add <id> --why "<為何過不了>"'); process.exit(1); }
      const why = flag('--why') || '';
      if (!why) { console.error('需給 --why（記清楚試了什麼、為何過不了，收尾時使用者才知道怎麼拍板）'); process.exit(1); }
      let rid;
      try { rid = await S.addPending(root, id, { why }); }
      catch (e) { if (e && e.code === 'UNSAFE_ID') { console.error('✗ ' + e.message); process.exit(1); } throw e; }
      console.log(`✓ 已記待決單：${rid}（${why}）。繼續其他工作，收尾時 SHALL 一批彈窗請使用者拍板。`);
    } else if (sub === 'list') {
      const items = await S.listPending(root);
      if (!items.length) { console.log('✓ 無待決單。'); break; }
      console.log(`待決單 ${items.length} 筆（收尾 SHALL 一批彈窗請使用者拍板）：`);
      for (const p of items) console.log(`  - ${p.id}：${p.why || '(無說明)'}`);
    } else if (sub === 'resolve') {
      const id = argv[2];
      if (!id || id.startsWith('--')) { console.error('usage: flow-state pending resolve <id> [--how "<處理>"]'); process.exit(1); }
      let ok;
      try { ok = await S.resolvePending(root, id, flag('--how') || ''); }
      catch (e) { if (e && e.code === 'UNSAFE_ID') { console.error('✗ ' + e.message); process.exit(1); } throw e; }
      console.log(ok ? `✓ 待決單 ${id} 已結案。` : `⚠ 查無待決單 ${id}（可能已結案）。`);
    } else {
      console.error('usage: flow-state pending <add|list|resolve> …');
      process.exit(1);
    }
    break;
  }
  case 'lesson': {
    // 記一條失敗記憶（防計畫再生撞同一面牆）。寫入點：標 BLOCKED、stall 升級時順手記。
    // 用法：flow-state lesson <taskId> --approach "<試過什麼>" --why "<為何失敗>"
    const id = argv[1];
    if (!id || id.startsWith('--')) { console.error('usage: flow-state lesson <taskId> --approach "<試過什麼>" --why "<為何失敗>"'); process.exit(1); }
    const approach = flag('--approach') || '';
    const why = flag('--why') || '';
    if (!approach && !why) { console.error('需至少給 --approach 或 --why（只記 approach→why，禁貼計畫全文）'); process.exit(1); }
    const rid = await resolveIdOrExit(id);
    await S.appendLesson(root, { id: rid, failedApproach: approach, why });
    console.log(`✓ 已記死路：${rid}：${approach} ✗ ${why}`);
    console.log('  下次 reconstruct / flow-plan 再生會自動帶出，避免重走（delivered 後自動失效）。');
    break;
  }
  case 'guardrail-check': {
    // 自駕前置硬閘門：確認護欄在線（stall 斷路器＋auto-gate 三道硬擋，判定與 mode auto 共用 guardrailProblem）。
    // /flow 寫 mode:auto 前 SHALL 跑；缺則 exit 2，退回每階段停、不假裝自駕（無花費上限下唯一剎車不能缺）。
    const gp = guardrailProblem(claudeHomeDir());
    if (gp) { console.error('✗ ' + gp); process.exit(2); }
    console.log('✓ 自駕護欄在線：stall 斷路器（flow-stall-monitor）＋自駕硬擋（flow-auto-gate）皆已註冊，可啟用自駕。');
    break;
  }
  case 'run': {
    // verify runner wrapper（W2-3）：真跑命令、捕真實 exit code、落 journal verify.attempt（綁 taskId）。
    // 接住 RUNNER_RE 白名單外的跑法（make/docker/自寫 script），且 done 閘門據此擋「跑過但最後一次紅卻標 done」。
    // 用法：flow-state run [--root <path>] --task <id> -- <runner 命令...>（-- 之後全部當命令，經 shell 跑）
    //   ⚠ --root/--task 等 flag SHALL 在 -- 之前——`--` 之後一律歸 runner 命令（含被誤放的 flag）。
    //   適用簡單 runner 命令（npm test / pytest / make test / docker compose run）；含 shell 元字元的
    //   內聯 code（node -e "…(…)…"）請放腳本檔再跑——argv 用空白重組會丟引號。
    const dashdash = argv.indexOf('--');
    const taskId = flag('--task');
    if (!taskId || dashdash < 0 || dashdash === argv.length - 1) { console.error('usage: flow-state run --task <id> -- <runner 命令...>'); process.exit(1); }
    const rid = await resolveIdOrExit(taskId);
    const cmd = argv.slice(dashdash + 1).join(' ');
    // 只認真正的 test/build runner（沿用 stall-monitor/auto-gate 同一支白名單）——堵「run -- node --version / true / echo ok」
    // 這類 no-op 綠命令洗掉紅 attempt。非 runner 直接拒、不落 attempt。
    if (!S.isRunnerCommand(cmd)) { console.error(`✗ 「${cmd}」不是測試 runner（node --version/true/echo 之類不算）——請給真正的 test/build/lint runner（npm test / pytest / make test…）。`); process.exit(1); }
    const bucket = S.runnerBucket(cmd);
    let out = '', code = 0;
    try { out = execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { code = (e.status ?? 1); out = String(e.stdout || '') + String(e.stderr || ''); }
    process.stdout.write(out);
    const sig = code === 0 ? 'ok' : S.verifyFailSig(cmd, out);
    await S.recordVerifyAttempt(root, bucket, sig, code, rid);
    console.log(code === 0
      ? `✓ ${rid}：runner 綠（exit 0）——已綁 taskId 落 journal，done 閘門認得。`
      : `✗ ${rid}：runner 紅（exit ${code}）——已落 journal；done 會擋到你真跑綠。`);
    process.exit(code === 0 ? 0 : 2);
    break;
  }
  case 'plan-check': {
    // 計畫出口對賬（W2-2）：REQ↔task 覆蓋＋tasks.md↔manifest 逐欄 diff。通過落 .flow/trace/plan-check.json
    // （記 manifest hash，complete-check 重算比對）＋寫 phase="plan-done"（flow-spec-gate 擋裸寫繞過）。
    // 用法：flow-state plan-check —— /flow-plan 出口 SHALL 跑。
    const idx = await S.readReqIndex(root);
    if (!idx) { console.error('✗ 查無 .flow/trace/req-index.json——先 flow-state spec-ready --freeze 凍結需求（凍結分母）再做計畫。'); process.exit(2); }
    const rp = path.join(root, 'specs', 'requirements.md');
    const hp = S.reqHashProblem(idx, existsSync(rp) ? readFileSync(rp, 'utf8') : '');
    if (hp) { console.error('✗ ' + hp); process.exit(2); }
    const tp = path.join(root, 'specs', 'tasks.md');
    if (!existsSync(tp)) { console.error('✗ 查無 specs/tasks.md——先 /flow-plan 產 tasks.md。'); process.exit(2); }
    const tasksMd = readFileSync(tp, 'utf8');
    const cov = S.reqTaskCoverage(idx.reqIds, tasksMd);
    const manifest = await S.readManifest(root);
    const diff = S.planManifestDiff(tasksMd, manifest);
    const problems = [];
    if (cov.uncovered.length) problems.push('這些 REQ 沒有任何 task 承接（會無聲蒸發到出貨）：\n    · ' + cov.uncovered.join('\n    · '));
    if (cov.phantom.length) problems.push('tasks.md 引用了 index 沒有的 REQ id（幻覺/打錯）：\n    · ' + cov.phantom.join('\n    · '));
    problems.push(...diff);
    if (problems.length) {
      console.error('✗ 計畫對賬未過（REQ↔task 覆蓋 / tasks.md↔manifest 同步）：');
      for (const p of problems) console.error('  - ' + p);
      process.exit(2);
    }
    // REQ↔design 對照矩陣：只印表給使用者 plan 定版彈窗掃一眼（design 語意矛盾機器驗不了，不假裝機檢）
    const dp = path.join(root, 'specs', 'design.md');
    if (existsSync(dp)) {
      const dmd = readFileSync(dp, 'utf8').toUpperCase();
      console.log('\nREQ↔design 對照（人工掃：每條 REQ 在 design.md 有沒有交代）：');
      for (const id of idx.reqIds) console.log(`  ${dmd.includes(id) ? '✓' : '⚠ design 查無'}  ${id}`);
    }
    await S.writePlanCheck(root, manifest, gitHead(root));
    const st = await S.readStateJson(root);
    await S.writeStateJson(root, { ...st, phase: 'plan-done' });
    console.log(`\n✓ 計畫對賬通過：${idx.reqIds.length} 條 REQ 全被 task 承接、tasks.md↔manifest 一致。已落 plan-check.json＋phase="plan-done"。`);
    break;
  }
  case 'verify-perf': {
    // REQ-PERF 達標記錄（W2-4）：從凍結 index 的 requirements 解析 budget、比對量測值，達標才落 pass。
    // 用法：flow-state verify-perf <REQ-PERF-id> --value <數字> --evidence "<量測工具輸出 ref>"
    const id = argv[1];
    if (!id || id.startsWith('--')) { console.error('usage: flow-state verify-perf <REQ-PERF-id> --value <數字> --evidence "<ref>"'); process.exit(1); }
    const rp = path.join(root, 'specs', 'requirements.md');
    if (!existsSync(rp)) { console.error('✗ 查無 specs/requirements.md。'); process.exit(2); }
    const reqMd0 = readFileSync(rp, 'utf8');
    const line = S.reqPerfLines(reqMd0)[id.toUpperCase()];
    if (!line) { console.error(`✗ requirements.md 查無 ${id.toUpperCase()} 定義行。`); process.exit(2); }
    // 非量測型（無可解析 budget/標 N/A，如「不阻塞主線程」）→ 走 perf-waiver decision，不是 verify-perf。
    if (S.perfIsNonMeasurable(reqMd0, id)) {
      console.error(`✗ ${id.toUpperCase()} 是非量測型 REQ-PERF（無可解析 budget）——它走 perf-waiver 豁免，不是 verify-perf：`);
      console.error('  flow-state decision perf-waiver --choice "REQ-PERF 非量測型/N/A" --why "<拍板原因>"（complete-check 認 perf-waiver）。');
      process.exit(2);
    }
    const value = flag('--value'), evidence = flag('--evidence') || '';
    if (value === undefined) { console.error('須給 --value <實測數字>（同 budget 單位）。'); process.exit(1); }
    if (!evidence) { console.error('須給 --evidence（量測工具輸出 ref：k6/autocannon/lighthouse 檔或摘要）——堵空綠。'); process.exit(1); }
    // W3-2：達標記錄的證據驗真（與 verify-e2e pass 同強度）——量測工具輸出 SHALL 是實存檔。
    // C-11：量測型再加碼——證據內容 SHALL 含與 --value 相符的數字（防拿無關檔充數、填假數字過關）。
    const perfEp = evidenceProblem(evidence, flag('--evidence-file'), { value });
    if (perfEp) { console.error('✗ ' + perfEp); process.exit(2); }
    const budget = S.parsePerfBudget(line);
    const miss = S.perfMeetsBudget(value, budget);
    if (miss) { console.error(`✗ ${id.toUpperCase()} 未達標：${miss}——優化到達標再記，別記假綠。`); process.exit(2); }
    await S.writePerfRecord(root, id.toUpperCase(), { status: 'pass', value: Number(value), budget: budget.budget, unit: budget.unit, lower: !!budget.lower, evidence, head: gitHead(root) });
    console.log(`✓ ${id.toUpperCase()} 達標：${value}${budget.unit} ${budget.lower ? '≥' : '≤'} ${budget.budget}${budget.unit}（含 5% 容差）。complete-check 會對賬。`);
    break;
  }
  case 'review-code': {
    // 藍軍 code-review 落機讀檔（/flow-ship Step 1）：code-reviewer subagent 回結構化 findings → 這裡落檔＋記 review 當時 HEAD。
    // 用法：flow-state review-code --file <findings.json>
    //   findings.json：{ "findings": [{ "id":"CR-001", "severity":"red|yellow", "file":"src/x.ts:42", "claim":"…", "suggest":"…" }] }；零 red flag 給空陣列。
    const fp = flag('--file');
    if (!fp) { console.error('需給 --file <findings.json>（code-reviewer 回傳的結構化 findings）'); process.exit(1); }
    let obj;
    try { const s = readFileSync(path.resolve(root, fp), 'utf8'); obj = JSON.parse(s.charCodeAt(0) === 0xfeff ? s.slice(1) : s); }
    catch (e) { console.error(`✗ findings 檔讀取/解析失敗：${e.message}`); process.exit(1); }
    const problems = S.validateCodeFindings(obj);
    if (problems.length) { console.error('✗ findings 檔形狀不合法：'); for (const p of problems) console.error('  - ' + p); process.exit(1); }
    const decExists = (did) => existsSync(path.join(root, '.flow', 'decisions', did + '.json'));
    const { carried } = await S.writeCodeReview(root, obj.findings, gitHead(root), decExists);
    const red = obj.findings.filter(f => String(f.severity).toLowerCase() === 'red').length;
    console.log(`✓ code-review 已落檔（${red} 條 red flag、${obj.findings.length - red} 條 yellow${carried ? `；另保留 ${carried} 條上一輪未終局 red` : ''}）。`);
    console.log((red + carried) ? '  下一步：逐條 flow-state code-resolve <CR-id> --as <fixed:<evidence>|waiver:<decisionId>>——red flag 不能無聲蒸發，complete-check 會擋。'
      : '  零 red flag——complete-check 對賬會過。');
    break;
  }
  case 'code-resolve': {
    // 把一條 red flag 走終局（fixed:<evidence> 或 waiver:<decisionId>）。用法：flow-state code-resolve <CR-id> --as <…>
    // 終局綁 finding 內容 hash（非裸 id）——重跑換編號時舊終局不會誤套到內容全新的同號 red。
    const cid = argv[1], asStr = flag('--as');
    if (!cid || cid.startsWith('--') || !asStr) { console.error('usage: flow-state code-resolve <CR-id> --as <fixed:<evidence>|waiver:<decisionId>>'); process.exit(1); }
    const review = await S.readCodeReview(root);
    const idU = cid.toUpperCase();
    const finding = (review && (review.findings || []).find(f => String(f.id || '').toUpperCase() === idU));
    if (!finding) { console.error(`✗ 查無 red flag「${cid}」——它不在 .flow/code-review/findings.json（先 review-code 落檔）。`); process.exit(1); }
    const prob = S.codeResolutionProblem(asStr, (did) => existsSync(path.join(root, '.flow', 'decisions', did + '.json')));
    if (prob) { console.error('✗ ' + prob); process.exit(2); }
    await S.writeCodeResolution(root, S.codeFindingHash(finding), { as: asStr, id: idU });
    console.log(`✓ ${idU} → ${asStr}（complete-check 會對賬）。`);
    break;
  }
  case 'diagnose': {
    // A3 三合一診斷入口（原 code-check / coverage / review-check 三個 subcommand——功能分別是
    // complete-check 與 spec-ready --freeze 的子集，單獨跑僅為互動除錯；收斂成一個動詞砍 CLI 表面積）。
    const section = argv[1];
    if (section === 'code') {
      // code-review red flag 終局化對賬（complete-check 內含同一檢查）。
      const review = await S.readCodeReview(root);
      if (!review) { console.log('⚠ 查無 .flow/code-review/findings.json——藍軍 code-review 還沒落檔（/flow-ship Step 1 SHALL 跑 review-code）。'); break; }
      const problems = S.codeReviewAudit(review, await S.readCodeResolutions(root), (did) => existsSync(path.join(root, '.flow', 'decisions', did + '.json')));
      if (problems.length) { console.error('✗ code-review red flag 未全終局（red flag 不能無聲蒸發）：'); for (const p of problems) console.error('  - ' + p); process.exit(2); }
      const red = (review.findings || []).filter(f => String(f.severity).toLowerCase() === 'red').length;
      console.log(`✓ ${red} 條 red flag 全數終局（fixed/waiver）。`);
      break;
    }
    if (section === 'coverage') {
      // REQ-E2E 覆蓋對賬（complete-check 內含同一檢查）。
      const cov = await coverageReport(root);
      if (cov.skipped) { console.error('✗ 查無 specs/requirements.md——無從對賬 REQ-E2E 覆蓋。'); process.exit(2); }
      if (cov.audit.total === 0) { console.error('✗ specs/requirements.md 實存但查無任何 REQ-E2E-*——0 條＝無從驗收（spec 被收束成殼？）。'); process.exit(2); }
      printCoverage(cov.audit);
      if (!cov.audit.ok) {
        console.error('✗ REQ-E2E 覆蓋未達：缺驗證記錄或有 fail。用 flow-state verify-e2e <id> --status pass --evidence "<ref>" 記真綠。');
        process.exit(2);
      }
      console.log(`✓ 所有 ${cov.audit.total} 條 REQ-E2E-* 都有 pass/n-a 驗證記錄。`);
      break;
    }
    if (section === 'review') {
      // spec-review findings 終局化對賬（spec-ready --freeze 內含同一檢查＋lens 收斂判準）。
      const ledgers = await S.listSpecReviewLedgers(root);
      if (!ledgers.length) { console.log('⚠ 查無任何 .flow/spec-review/ ledger——lens 審查還沒跑（freeze 會要求 redteam/consistency 各 ≥2 輪）。'); break; }
      const rp4 = path.join(root, 'specs', 'requirements.md');
      const reqMd = existsSync(rp4) ? readFileSync(rp4, 'utf8') : '';
      const problems = S.reviewCheckAudit(ledgers, await S.readSpecResolutions(root), reqMd,
        (did) => existsSync(path.join(root, '.flow', 'decisions', did + '.json')), S.sha256Text(reqMd),
        S.lastFrozenAt(await S.readJournal(root)));
      if (problems.length) {
        console.error('✗ findings 終局化對賬未過（發現不能無痕蒸發）：');
        for (const p of problems) console.error('  - ' + p);
        process.exit(2);
      }
      const total = ledgers.reduce((n, r) => n + (r.findings || []).length, 0);
      console.log(`✓ ${total} 條 findings 全數終局且指標有效（resolved/open/deferred/rejected）。`);
      break;
    }
    console.error('usage: flow-state diagnose <code|coverage|review>');
    process.exit(1);
  }
  case 'complete-check': {
    // 完成謂詞硬閘門（ship 出口）：① tasks.md 全 [x]（無未完成 [ ]）② 所有 REQ-E2E-* 都有 pass/n-a 驗證記錄。
    // /flow-ship Step 5 SHALL 跑；自駕下尤其要（防模型自報全中提早收工）。
    const tp = path.join(root, 'specs', 'tasks.md');
    if (!existsSync(tp)) { console.error('✗ 查無 specs/tasks.md——無法判定完成謂詞，不准發 COMPLETE。'); process.exit(2); }
    const md = readFileSync(tp, 'utf8');
    const open = (md.match(/^\s*[-*]\s*\[ \]/gm) || []).length;
    const xstar = (md.match(/\bX-[A-Za-z]\w*/g) || []).length;
    if (open > 0) { console.error(`✗ 完成謂詞未達：tasks.md 還有 ${open} 個未完成 [ ]。自駕不准在此發 COMPLETE，回 build 補完。`); process.exit(2); }
    console.log(`✓ tasks.md 全數 [x]${xstar ? `（注意：尚見 ${xstar} 處 X-* cross-cutting 標記，ship 前確認已清）` : ''}。`);
    // C-8：有待決單＝還有沒拍板的關卡，不得自稱出貨完成。
    const pend = await S.listPending(root);
    if (pend.length) {
      console.error(`✗ 完成謂詞未達：還有 ${pend.length} 筆待決單未結案（自駕跳過、待使用者拍板）：`);
      for (const p of pend) console.error(`  - ${p.id}：${p.why || ''}`);
      console.error('  → 收尾彈窗請使用者逐筆拍板，處理後 flow-state pending resolve <id>；全部結案才可 COMPLETE。');
      process.exit(2);
    }
    // C-17：tasks.md 全 [x] 不代表真交付——與 ledger 交叉對賬（現成 reconcile），揪「翻了勾但沒走 done」的偽造。
    // 最小 guard：ledger 非空才對賬（空 ledger＝從未走過 done 的極簡/舊專案，不誤擋）。
    const ledgerAll = await S.listLedger(root);
    if (ledgerAll.length) {
      const rec = S.reconcile(md, ledgerAll);
      if (rec.checkedButNotDelivered.length) {
        console.error('✗ 完成謂詞未達：以下 task 在 tasks.md 標了 [x] 但 ledger 沒有 delivered（翻勾≠真交付）：');
        for (const id of rec.checkedButNotDelivered) console.error('  - ' + id);
        console.error('  → 每個都跑 flow-state done <id>（冪等、會補齊 ledger）後再 complete-check。別手翻 [x] 繞過。');
        process.exit(2);
      }
    }
    // REQ-E2E 覆蓋對賬（把原本的散文提示升級成確定性節點）。requirements.md 缺則提醒不擋（不破壞既有最小用法）。
    const cov = await coverageReport(root);
    // W0-7：缺 requirements.md 從警告升 exit 2——「歸檔/改名 spec ＝ 整段 REQ-E2E 完成謂詞靜默關閉」的洞封死。
    if (cov.skipped) { console.error('✗ 查無 specs/requirements.md——REQ-E2E 完成謂詞無從對賬，不准發 COMPLETE（spec 被歸檔/改名？還原它，或用 --root 指對專案根）。'); process.exit(2); }
    // 檔案實存但被收束成 0 條 REQ-E2E 的殼（/flow-compact 歸檔變體）＝完成謂詞 0/0 空轉，同擋。
    if (cov.audit.total === 0) { console.error('✗ specs/requirements.md 實存但查無任何 REQ-E2E-*——spec 被收束成殼？（凍結底線＝至少 1 條）從 specs/archive/ 還原完整版再對賬，不准發 COMPLETE。'); process.exit(2); }
    printCoverage(cov.audit);
    // W3-3③：凍結分母 SHALL 實存（後續 hash/perf 對賬要用）——結構前置，維持 fail-fast。
    const idx = await S.readReqIndex(root);
    if (!idx) { console.error('✗ 查無 .flow/trace/req-index.json（凍結分母）——凍結後被刪，或從未走 spec-ready --freeze 正門。重跑 flow-state spec-ready --freeze 重建分母再對賬。'); process.exit(2); }
    const reqMd = readFileSync(path.join(root, 'specs', 'requirements.md'), 'utf8');
    // C-23：以下品質閘門「收集全部未達項、最後一次列印」，不逐類 fail-fast——自駕下不必每類多跑一輪「修→重跑→發現下一類」。
    // 結構前置（tasks/requirements/req-index 缺）已在上面 fail-fast（後續分析依賴它們）。
    const fails = [];
    if (!cov.audit.ok) fails.push('REQ-E2E 未全部驗綠：每條 journey 經 /flow-verify 真跑綠後 flow-state verify-e2e <id> --status pass --evidence …；無法自動化標 --status n/a 附原因。');
    const hp = S.reqHashProblem(idx, reqMd);
    if (hp) fails.push(hp);
    // W2-3 n/a 醒目列出（每條都該有 decision 撐著）
    for (const r of await S.listVerifyRecords(root)) if (String(r.status) === 'n/a') console.log(`  ⚠ ${r.id} 標 n/a（decision=${r.decision || '?'}）——ship 前確認此 journey 真的無法自動化`);
    // W2-4 REQ-PERF 對賬：量測型 SHALL 有 verify-perf pass；非量測型（無 budget/N/A）SHALL 有 perf-waiver。
    const perfIds = S.extractReqPerf(reqMd);
    const perfWaived = existsSync(path.join(root, '.flow', 'decisions', 'perf-waiver.json'));
    for (const pid of perfIds) {
      if (S.perfIsNonMeasurable(reqMd, pid)) { if (!perfWaived) fails.push(`REQ-PERF ${pid} 非量測型/N/A 但無 perf-waiver decision（flow-state decision perf-waiver …）`); continue; }
      const rec = await S.readPerfRecord(root, pid);
      if (!rec || rec.status !== 'pass') fails.push(`REQ-PERF ${pid} 缺達標記錄——flow-state verify-perf ${pid} --value <實測> --evidence <ref>`);
    }
    // C-9：plan-check.json SHALL 實存（計畫出口對賬從未跑或被刪＝可整段略過）。舊專案相容＝plan-check-waiver 逃生口。
    const pc = await S.readPlanCheck(root);
    const planWaived = existsSync(path.join(root, '.flow', 'decisions', 'plan-check-waiver.json'));
    if (!pc && !planWaived) fails.push('查無 .flow/trace/plan-check.json（計畫出口對賬從未跑/被刪）——跑 flow-state plan-check；舊專案相容：flow-state decision plan-check-waiver …。');
    if (pc && pc.manifestHash && pc.manifestHash !== S.manifestScopeHash(await S.readManifest(root)))
      fails.push('manifest 的 blockedBy/conflictZone 在 plan-check 後被改過（scope/wave 事實來源漂移）——重跑 flow-state plan-check。');
    // C：藍軍 code-review forcing function——ship 出貨 SHALL 過藍軍（缺 code-review 且無豁免即擋；逃生口＝code-review-waiver）。
    const codeReview = await S.readCodeReview(root);
    const codeWaived = existsSync(path.join(root, '.flow', 'decisions', 'code-review-waiver.json'));
    if (!codeReview && !codeWaived) fails.push('未跑藍軍 code-review——review-code --file <findings.json>（零 red flag 也落空陣列＝證明審過）；真要跳過：flow-state decision code-review-waiver …。');
    for (const p of S.codeReviewAudit(codeReview, await S.readCodeResolutions(root), (did) => existsSync(path.join(root, '.flow', 'decisions', did + '.json'))))
      fails.push('藍軍 code-review red flag 未終局：' + p);
    // C-7：code-review 新鮮度——review 記錄的 HEAD 之後又改了原始碼（非測試/文件/.flow）＝驗的是舊 code。逃生口＝code-review-waiver。
    if (codeReview && codeReview.head && !codeWaived) {
      const headNow = gitHead(root);
      if (headNow && codeReview.head !== headNow) {
        const src = sourceChanged(gitDiffNames(root, codeReview.head));
        if (src.length) fails.push(`code-review 之後又改了原始碼（驗的是舊 code）：${src.slice(0, 8).join('、')}——重跑 review-code，或改的是無關檔則 code-review-waiver。`);
      }
    }
    // W3-1/C-19 journey 真實性：web 類 SHALL 有「當前 HEAD」的 journey-check 通過記錄；journey-waiver 只降級 mock/goto 違規、不略過整段。
    const cm = await S.readManifest(root);
    const journeyWaiverPath = path.join(root, '.flow', 'decisions', 'journey-waiver.json');
    const journeyWaivedCC = existsSync(journeyWaiverPath);
    if (S.WEB_PROJECT_TYPES.includes(cm.projectType)) {
      const jc = await S.readJourneyCheck(root);
      if (!jc) fails.push('web 專案未過 journey 真實性閘門——flow-state journey-check（合法外部服務 mock 另加 journey-waiver 降級違規，但仍須跑）。');
      else {
        const headNow = gitHead(root);
        if (jc.head && headNow && jc.head !== headNow) fails.push('journey-check 記錄不是當前 HEAD（驗的是舊 code）——重跑 flow-state journey-check（秒級）。');
        else if (journeyWaivedCC) {
          let wat = '';
          try { wat = (JSON.parse(readFileSync(journeyWaiverPath, 'utf8')).at || '').slice(0, 10); } catch { /* 時戳非關鍵 */ }
          console.log(`  ⚠ journey-waiver 生效${wat ? `（${wat} 建立）` : ''}——只豁免特定 mock/goto 違規，非跳過走查；ship 前確認豁免的外部服務 mock 仍合理。`);
        }
      }
    }
    // C-23：一次列印所有未達項（不逐類擋）。
    if (fails.length) {
      console.error(`✗ 完成謂詞未達（共 ${fails.length} 項，全部處理完才能 COMPLETE）：`);
      for (const f of fails) console.error('  - ' + f);
      process.exit(2);
    }
    // Stop hook（W3-5）據此判「收工前完成謂詞真的過了」——成功即落機讀記錄（綁 HEAD）。
    await S.writeCompleteCheck(root, { head: gitHead(root) });
    // C-26：完成謂詞達成＝出貨完成。原子寫 manifest.phase=shipped（phase 單一事實來源），
    // SessionStart 的 briefStatus 據此靜默、不再每 session 喊「task 全交付、待驗證/出貨」。
    await S.writeManifest(root, { ...(await S.readManifest(root)), phase: 'shipped' });
    console.log(`✓ 所有 ${cov.audit.total} 條 REQ-E2E-* 驗綠${perfIds.length ? `＋${perfIds.length} 條 REQ-PERF 達標` : ''}＋${codeReview ? 'code-review red flag 全終局' : 'code-review 已豁免'}。完成謂詞達成（phase=shipped）。`);
    break;
  }
  case 'verify-e2e': {
    // Evaluator 在某條 REQ-E2E journey 真跑綠後記一筆（coverage 對賬的機讀來源）。
    // 用法：flow-state verify-e2e <REQ-E2E-id> --status <pass|fail|n/a> --evidence "<trace/test ref 或 n/a 原因>"
    const id = argv[1];
    if (!id || id.startsWith('--')) { console.error('usage: flow-state verify-e2e <REQ-E2E-id> --status <pass|fail|n/a> --evidence "<ref>"'); process.exit(1); }
    if (!/^REQ-E2E-/i.test(id)) console.error(`⚠ 「${id}」不像 REQ-E2E-* id（仍記錄；coverage 以 requirements.md 的 REQ-E2E-* 為準）`);
    const status = (flag('--status') || 'pass').toLowerCase();
    if (!/^(pass|fail|n\/?a)$/.test(status)) { console.error('--status 須為 pass / fail / n/a'); process.exit(1); }
    const norm = /^n\/?a$/.test(status) ? 'n/a' : status;
    const evidence = flag('--evidence') || '';
    if ((norm === 'pass' || norm === 'n/a') && !evidence) {
      console.error(norm === 'pass'
        ? 'pass 須附 --evidence（真綠證據 ref：trace 路徑 / 測試名 / API+DB 讀回摘要）——堵空綠。'
        : 'n/a 須附 --evidence 說明為何此 journey 無法自動化驗證。');
      process.exit(1);
    }
    // W3-2 pass 證據驗真：evidence（或 --evidence-file）SHALL 指向實存非空檔——堵「寫一句『我保證通過』就算證據」。
    if (norm === 'pass') {
      const ep = evidenceProblem(evidence, flag('--evidence-file'));
      if (ep) { console.error('✗ ' + ep); process.exit(2); }
    }
    // W2-3 n/a 收緊：n/a 不再是自由逃生口——SHALL 附 --decision 指向實存 decision，且該 decision 不得被別條 REQ-E2E 重用
    //（堵「一張拋棄式 decision 洗掉全批 n/a」）。
    const naDecision = flag('--decision');
    if (norm === 'n/a') {
      if (!naDecision) { console.error('n/a 須附 --decision <id>（先 flow-state decision <id> --choice "此 journey 無法自動化" --why "<原因>" 留檔）——堵「批量 n/a 洗掉難驗 journey」。'); process.exit(1); }
      if (/[\/\\]|\.\./.test(naDecision)) { console.error('✗ --decision id 不得含路徑分隔或 ..'); process.exit(1); }
      if (!existsSync(path.join(root, '.flow', 'decisions', naDecision + '.json'))) { console.error(`✗ 查無 decision「${naDecision}」——先 flow-state decision ${naDecision} --choice … --why … 留檔。`); process.exit(2); }
      const reused = (await S.listVerifyRecords(root)).find(r => r.decision === naDecision && String(r.id).toUpperCase() !== id.toUpperCase());
      if (reused) { console.error(`✗ decision「${naDecision}」已被 ${reused.id} 的 n/a 用過——每條難驗 journey 各自表態一次，別一張 decision 洗全批。`); process.exit(2); }
    }
    // W2-3 證據綁版本：自動記 HEAD sha＋現行 requirements.md hash——complete-check 據此驗「這條 journey 驗的是凍結那版 spec」。
    const rpv = path.join(root, 'specs', 'requirements.md');
    const reqHash = existsSync(rpv) ? S.sha256Text(readFileSync(rpv, 'utf8')) : '';
    try { await S.writeVerifyRecord(root, id.toUpperCase(), { status: norm, evidence, by: 'evaluator', head: gitHead(root), reqHash, ...(naDecision ? { decision: naDecision } : {}) }); }
    catch (e) { if (e && e.code === 'UNSAFE_ID') { console.error('✗ ' + e.message); process.exit(1); } throw e; }
    console.log(`✓ 已記 REQ-E2E 驗證：${id.toUpperCase()} = ${norm}${evidence ? `（${evidence}）` : ''}`);
    console.log('  ship 出口 flow-state complete-check / coverage 會逐條對賬 requirements.md 的 REQ-E2E-*。');
    break;
  }
  case 'journey-check': {
    // journey 真實性閘門（確定性，web 驗證宣稱綠前 SHALL 跑）：掃 Playwright journey 測試檔，
    // 出現網路攔截/假後端 或 單一 test 內 >1 goto → exit 2。守導航版「禁 mock 假綠」。
    // 用法：flow-state journey-check [--dir <測試根目錄，預設掃整個 repo>]
    const givenDir = flag('--dir');
    const base = givenDir ? path.resolve(root, givenDir) : root;
    const journeyFiles = [], fileProblems = [], configProblems = [], warningsAll = [];
    for (const f of walkTestFiles(base)) {
      let content = '';
      try { content = readFileSync(f, 'utf8'); } catch { continue; }
      const a = S.auditJourneyTest(content);
      if (!a.isJourney) continue;
      const rel = path.relative(root, f).replace(/\\/g, '/');
      journeyFiles.push(rel);
      for (const p of a.problems) fileProblems.push(`${rel}: ${p}`);
      for (const w of a.warnings) warningsAll.push(`${rel}: ${w}`);
    }
    // W2-3 playwright.config 掃描：retries 非 0＝flaky 洗綠（除非 retry-waiver）；webServer 用 dev server＝禁 dev 噪音。
    const retryWaived = existsSync(path.join(root, '.flow', 'decisions', 'retry-waiver.json'));
    const DEV_SERVER_RE = /\b(run\s+dev|next\s+dev|vite(\s+dev)?|nuxt\s+dev|ng\s+serve|astro\s+dev|remix\s+dev|start:dev|dev:)\b|['"\`]dev['"\`]/i;
    for (const cf of walkConfigFiles(base)) {
      let c = '';
      try { c = readFileSync(cf, 'utf8'); } catch { continue; }
      const rel = path.relative(root, cf).replace(/\\/g, '/');
      const stripped = c.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');   // 去註解，別誤刪 http://
      const rm = stripped.match(/retries\s*:\s*([^,}\n]+)/);
      if (rm && !retryWaived) {
        const val = rm[1].trim();
        if (/^0\b/.test(val)) { /* retries: 0 → 放行 */ }
        else if (/^\d+$/.test(val)) configProblems.push(`${rel}: retries: ${val}（非 0＝flaky 靠重試洗綠；CI 真 flaky 才留，須 flow-state decision retry-waiver 留檔）`);
        else if (/[1-9]/.test(val)) warningsAll.push(`${rel}: retries: ${val}（條件式含非 0——確認 CI 才重試、非掩蓋 flaky；要擋請留 retry-waiver）`);
      }
      const wm = stripped.match(/webServer[\s\S]{0,200}?command\s*:\s*['"\`]([^'"\`]+)['"\`]/);
      if (wm && DEV_SERVER_RE.test(wm[1])) configProblems.push(`${rel}: webServer command 疑用 dev server（"${wm[1].trim()}"）——驗證禁 dev 噪音，改 build && preview/start`);
    }
    // W3-4 journey-waiver 逃生口（限測試檔內 mock/多 goto 命中；config 的 retries/dev-server 各有既有處理）：
    // 合法 mock（如攔第三方 analytics/金流 sandbox）經使用者拍板留檔後降級為警告——沒豁免照擋，防「誤殺疲勞→整個閘門被關」。
    const journeyWaived = existsSync(path.join(root, '.flow', 'decisions', 'journey-waiver.json'));
    if (journeyWaived && fileProblems.length) {
      for (const p of fileProblems) warningsAll.push(`${p}（journey-waiver 已豁免——確認豁免理由仍涵蓋此檔）`);
      fileProblems.length = 0;
    }
    const problemsAll = [...fileProblems, ...configProblems];
    if (!journeyFiles.length) {
      console.log('⚠ 未找到 Playwright journey 測試檔（*.spec/.test/.e2e 內含 @playwright/test 或 page.goto）。');
      console.log('  若本專案有 web 前端，代表還沒有「從入口真實點擊」的端到端驗證——請補 playwright-real-data-template 的 journey 測試。');
      console.log('  （非 web 專案無此要求，可忽略。）');
      break;
    }
    console.log(`掃描到 ${journeyFiles.length} 個 journey 測試檔：`);
    for (const f of journeyFiles) console.log(`  · ${f}`);
    if (warningsAll.length) { console.log('\n⚠ 提醒（不擋，但請人工確認非抄捷徑）：'); for (const w of warningsAll) console.log('  ' + w); }
    if (problemsAll.length) {
      console.error('\n✗ journey 真實性未過（導航版「禁 mock 假綠」）：');
      for (const p of problemsAll) console.error('  ' + p);
      console.error('  修正：拆掉 mock/網路攔截改走真 API/真 DB；每個 test 只留一個入口 goto、其後用 getByRole().click() 真實點擊串接。別繞過本閘門。');
      process.exit(2);
    }
    // W3-1：通過即落機讀記錄（綁 HEAD）——complete-check 對 web 專案據此對賬「防假綠檢查真的跑過且是當前 code」。
    await S.writeJourneyCheck(root, { head: gitHead(root), files: journeyFiles.length, waived: journeyWaived });
    console.log('\n✓ journey 真實性通過：無 mock/網路攔截、每個 test 單一入口 goto。');
    console.log('  已落 .flow/trace/journey-check.json（綁 HEAD）——ship 出口 complete-check 會對賬。');
    break;
  }
  case 'spec-ready': {
    // 需求訪談收斂閘門（凍結的「正門」）：掃 specs/requirements.md。
    // ### 開放問題 沒清零、或缺 REQ-/REQ-E2E-/REQ-PERF- → exit 2。直接餵自駕安全：
    // spec 沒問乾淨就凍結＝自駕途中 AI 只能猜＝跑歪；這裡擋住「沒收斂就往下」。
    // 用法：flow-state spec-ready            僅檢查（訪談收斂後、產互動原型前跑；綠了才往下）
    //       flow-state spec-ready --freeze   檢查通過才寫 phase="spec-done"（凍結唯一正門，取代裸寫 state.json）
    const rp = path.join(root, 'specs', 'requirements.md');
    if (!existsSync(rp)) {
      console.error('✗ 查無 specs/requirements.md——還沒有可凍結的需求。先跑 /flow-spec 訪談並寫 requirements.md。');
      process.exit(2);
    }
    const { open, problems: specProblems, warnings, perfNA } = S.specReadiness(readFileSync(rp, 'utf8'));
    const problems = [...specProblems];
    // REQ-PERF 標 N/A 的逃生口對賬（W0-3）：效能豁免 SHALL 使用者拍板留檔，不能一句 N/A 洗掉效能驗收。
    if (perfNA && !existsSync(path.join(root, '.flow', 'decisions', 'perf-waiver.json')))
      problems.push('REQ-PERF 標了 N/A 但查無 .flow/decisions/perf-waiver.json——效能豁免 SHALL 使用者彈窗拍板後留檔：flow-state decision perf-waiver --choice "REQ-PERF N/A" --why "<拍板原因>"');
    if (warnings.length) {
      console.error('⚠ 需求品質提醒（不擋，建議回訪談補問）：');
      for (const w of warnings.slice(0, 5)) console.error('  · ' + w);
      if (warnings.length > 5) console.error(`  · …其餘 ${warnings.length - 5} 條略`);
    }
    if (problems.length) {
      console.error('✗ 需求尚未收斂，不能凍結／推進：');
      for (const p of problems) console.error('  - ' + p);
      if (open.length) { console.error('  未收斂的開放問題：'); for (const q of open.slice(0, 12)) console.error('    · ' + q); }
      console.error('  繼續蘇格拉底訪談 + grill-me + lens 審查矩陣（spec-redteam/spec-consistency），把每一項問到拍板（彈窗）後全清零再凍結。別手改檔繞過閘門。');
      process.exit(2);
    }
    if (argv.includes('--freeze')) {
      // 凍結順序：spec-ready（收斂檢查）→ 產互動原型 → --freeze。projectType 正門（W0-5）：
      // 先對賬 flow-state project-type 落的記錄——web 類 SHALL 有互動原型或 mockup-waiver 豁免檔，
      // 封掉「不建 specs/ui-mockups/ 目錄＝靜默跳過原型驗證」的通道；非 web 的 enum 記錄本身即豁免。
      const manifest = await S.readManifest(root);
      const st0 = await S.readStateJson(root);
      const ptype = manifest.projectType || st0.projectType || '';
      if (!ptype) {
        console.error('✗ 凍結前 SHALL 先落檔專案類型：跟使用者彈窗確認後跑 flow-state project-type <type>。');
        console.error(`  合法值：${S.PROJECT_TYPES.join(' | ')}（${S.WEB_PROJECT_TYPES.join('/')}＝web 類，凍結時驗互動原型）`);
        process.exit(2);
      }
      if (!S.PROJECT_TYPES.includes(ptype)) {
        // 消費端也驗 enum——手寫 manifest 塞自創值（webapp/saas/frontend）會被歸類「非 web」靜默免原型，堵住
        console.error(`✗ projectType="${ptype}" 不在合法清單——只能經正門落檔：flow-state project-type <type>。`);
        console.error(`  合法值：${S.PROJECT_TYPES.join(' | ')}`);
        process.exit(2);
      }
      const mockDirRel = path.join('specs', 'ui-mockups');
      if (existsSync(path.join(root, mockDirRel))) {
        const { problems: mp } = mockupProblems(root, mockDirRel);
        if (mp.length) {
          console.error('✗ 互動原型走查台未過（specs/ui-mockups/ 存在即驗）：');
          for (const p of mp) console.error('  - ' + p);
          console.error('  修正：補齊走查台缺卡/斷鏈/空殼頁（flow-state mockup-check 可單獨重驗），或整目錄不做原型時刪除並 flow-state decision mockup-waiver 記豁免。');
          process.exit(2);
        }
      } else if (S.WEB_PROJECT_TYPES.includes(ptype)) {
        if (!existsSync(path.join(root, '.flow', 'decisions', 'mockup-waiver.json'))) {
          console.error(`✗ projectType=${ptype}（web 類）但查無 specs/ui-mockups/ 也查無豁免記錄——「不建目錄＝靜默跳過原型」已封死。`);
          console.error('  二選一：① 依 prototype-guide 產互動原型並過 flow-state mockup-check；② 使用者明說跳過才豁免：flow-state decision mockup-waiver --choice "跳過互動原型" --why "<使用者原話>"（UI 方向風險押到 build 才暴露，自負）。');
          process.exit(2);
        }
        console.log('⚠ web 類無互動原型、已有 mockup-waiver 豁免記錄——UI 方向風險自負（decision 已留審計）。');
      }
      // 第 1 波：多角度審查收斂判準（機讀，取代「某一輪問不出新問題」的模型自評）——
      // required lens（redteam/consistency）各 ≥2 輪、末輪零新發現（或滿 3 輪封頂）、末輪 docHash==現行文字、
      // 全部 findings 走到四種終局之一。codex lens 有 ledger 就一併對賬、沒裝不強制。
      // 收斂判準只看「最後一次凍結之後」的輪（週期斷代，防再凍結時舊週期輪數蒙混）；終局對賬吃全量（findings 不可蒸發）。
      const allLedgers = await S.listSpecReviewLedgers(root);
      const journal0 = await S.readJournal(root);
      const cycleLedgers = S.currentCycleLedgers(allLedgers, journal0);
      const reqText = readFileSync(rp, 'utf8');
      const curHash = S.sha256Text(reqText);
      const decisionExists = (did) => existsSync(path.join(root, '.flow', 'decisions', did + '.json'));
      const srProblems = [
        ...S.lensConvergenceAudit(cycleLedgers, curHash),
        ...S.reviewCheckAudit(allLedgers, await S.readSpecResolutions(root), reqText, decisionExists, curHash, S.lastFrozenAt(journal0)),
      ];
      if (srProblems.length) {
        console.error('✗ 多角度審查未收斂，不能凍結（迴圈細節見 references/spec-review-loop.md）：');
        for (const p of srProblems) console.error('  - ' + p);
        process.exit(2);
      }
      // C-22：Step 4 高風險獨立安全審查從散文 SHALL 升為機檢——requirements 命中高風險面（auth/權限/金流/注入…）
      // 但查無 security-review decision → exit 2（「漏做與沒觸發不可區分」的散文洞封死）。domain-presence 單訊號即可、
      // 不照搬紅軍三組共現（需求文字語境不同、硬搬會誤殺）；未命中也印稽核線（證明檢查跑過）。
      if (S.isHighRiskAttackText(reqText)) {
        if (!decisionExists('security-review')) {
          console.error('✗ requirements 命中高風險面（auth/權限/金流/注入等）但查無 security-review 記錄——Step 4 安全審查 SHALL 做並留檔：');
          console.error('  flow-state decision security-review --choice "<審了什麼/結論>" --why "<高風險點>"（使用者拍板後留可稽核檔）。');
          process.exit(2);
        }
        console.log('✓ 高風險面已有 security-review 記錄（Step 4 安全審查留檔）。');
      } else {
        console.log('  ⓘ requirements 未命中高風險關鍵字——Step 4 安全審查非強制（稽核線）。');
      }
      // UI 定版記錄（走了原型路才要求）：使用者彈窗定版後 SHALL 留檔——機器證明不了「使用者真點過」，
      // 但「沒有定版記錄就凍結」從此擋得住（decision 檔可由模型自寫屬蓄意欺騙級，靠彈窗雙寫＋git 審計線兜底）。
      if (existsSync(path.join(root, mockDirRel)) && !decisionExists('ui-signoff')) {
        console.error('✗ 互動原型存在但查無 UI 定版記錄——使用者照走查台點完、彈窗定版後 SHALL 留檔：');
        console.error('  flow-state decision ui-signoff --choice "<方向 OK/改了哪幾頁後 OK>" --why "<使用者原話>"');
        process.exit(2);
      }
      const st = await S.readStateJson(root);
      await S.writeStateJson(root, { ...st, phase: 'spec-done' });        // read-modify-write，保留 mode/tasks/verify/tdd
      // W2-1 凍結分母：落 .flow/trace/req-index.json（REQ 全集＋requirements.md hash＋HEAD）——
      // 下游 plan-check/verify-e2e/complete-check 一律以此為分母，凍結後偷改文字在下一道就被 hash 對賬抓。
      const head = gitHead(root);
      await S.writeReqIndex(root, reqText, head);
      await S.appendJournal(root, { ev: 'spec.frozen', reqHash: S.sha256Text(reqText), head });
      console.log('✓ 需求已收斂（### 開放問題 清零＋REQ-/REQ-E2E-/REQ-PERF- 齊）且已凍結：phase="spec-done"。');
      console.log('  凍結分母已落 .flow/trace/req-index.json；下游閘門對賬用。下一步：web 類先確認互動原型已彈窗定版，再進 /flow-plan（自駕會自動接續）。');
    } else {
      console.log('✓ 需求已收斂：### 開放問題 清零、REQ-/REQ-E2E-/REQ-PERF- 齊。可產互動原型 → 凍結（flow-state spec-ready --freeze）。');
    }
    break;
  }
  case 'mockup-check': {
    // 互動原型走查閘門：specs/ui-mockups/index.html（journey 走查台）SHALL 列出每條 REQ-E2E 的卡
    // 且連到的本地頁面實存——防「只產兩頁就宣稱 UI 定版」的偷工。覆蓋骨架機檢；原型好不好看
    // 仍由使用者開瀏覽器照走查台點過每條 journey 後彈窗定版（本閘門擋不了醜、只擋缺）。
    // 用法：flow-state mockup-check [--dir specs/ui-mockups]（產完原型、開瀏覽器定版前跑；--freeze 會再驗一次）
    const dirRel = flag('--dir', path.join('specs', 'ui-mockups'));
    const { problems, audit } = mockupProblems(root, dirRel);
    if (problems.length) {
      console.error('✗ 互動原型走查台未過：');
      for (const p of problems) console.error('  - ' + p);
      console.error('  補齊每條 REQ-E2E 的走查卡＋修斷鏈後重跑。別只產關鍵頁就請使用者定版——片面原型＝使用者要靠想像＝方向風險。');
      process.exit(2);
    }
    console.log(`✓ 互動原型走查台通過：${audit.reqIds.length} 條 REQ-E2E 全數列卡、${audit.hrefs.length} 個本地連結實存。`);
    console.log('  下一步：開瀏覽器把走查台每條 journey 真點一遍，再用彈窗跟使用者定版 UI。');
    break;
  }
  case 'spec-review': {
    // 收一輪 lens 審查 findings 落機讀 ledger（第 1 波）。docHash 由本 CLI 讀現行 requirements.md 自算
    // （模型不可自填）、round 自動遞增——「哪些 lens 跑過、跑了幾輪、審的是哪版文字」變成檔案事實。
    // 用法：flow-state spec-review <redteam|consistency|codex> --file <findings.json> [--exec "<cmd>"]
    //   findings.json 形狀：{ "findings": [{ "id":"SR-RT-001", "category":"…", "severity":"high|medium|low",
    //   "claim":"…（含 REQ 錨點）", "suggest":"…" }], "attestation": "…(選填)" }；零發現給空陣列。
    //   --exec：（codex 跨家族 lens 用）由 CLI 親自執行命令並把 stdout/exit 原文存進 ledger raw 欄位。
    const lens = argv[1];
    if (!S.SPEC_REVIEW_LENSES.includes(lens)) { console.error(`usage: flow-state spec-review <${S.SPEC_REVIEW_LENSES.join('|')}> --file <findings.json> [--exec "<cmd>"]`); process.exit(1); }
    const fp = flag('--file');
    if (!fp) { console.error('需給 --file <findings.json>（lens subagent 回傳的結構化 findings）'); process.exit(1); }
    const rp2 = path.join(root, 'specs', 'requirements.md');
    if (!existsSync(rp2)) { console.error('✗ 查無 specs/requirements.md——沒有可審的需求文件。'); process.exit(2); }
    let obj;
    try { const s = readFileSync(path.resolve(root, fp), 'utf8'); obj = JSON.parse(s.charCodeAt(0) === 0xfeff ? s.slice(1) : s); }  // strip BOM（PS5.1 utf8 帶 BOM）
    catch (e) { console.error(`✗ findings 檔讀取/解析失敗：${e.message}`); process.exit(1); }
    const shapeProblems = S.validateSpecReviewFindings(obj, lens);
    if (shapeProblems.length) {
      console.error('✗ findings 檔形狀不合法（schema 擋壞形狀，修好再收）：');
      for (const p of shapeProblems) console.error('  - ' + p);
      process.exit(1);
    }
    // 跨 lens／跨輪 id 全域查重：resolutions 以 id 為全域 key，撞號會讓一筆終局吃掉兩條不同質疑（無痕蒸發）
    const seenIds = new Map();
    for (const rec of await S.listSpecReviewLedgers(root)) for (const f of (rec.findings || [])) seenIds.set(String(f.id || '').toUpperCase(), `${rec.lens} r${rec.round}`);
    const clash = obj.findings.map(f => String(f.id || '').toUpperCase()).filter(id => seenIds.has(id));
    if (clash.length) {
      console.error('✗ finding id 與既有 ledger 撞號（跨 lens/輪唯一，防一筆終局蒸發兩條質疑）：');
      for (const id of clash) console.error(`  - ${id} 已存在於 ${seenIds.get(id)}——換流水號（${S.SPEC_LENS_ID_PREFIX[lens]}<新號>）`);
      process.exit(1);
    }
    let raw;
    const execCmd = flag('--exec');
    if (execCmd) {
      try { raw = { cmd: execCmd, stdout: execSync(execCmd, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).slice(0, 65536), exit: 0 }; }
      catch (e) { raw = { cmd: execCmd, stdout: String(e.stdout || e.message || '').slice(0, 65536), exit: (e.status ?? 1) }; }
    }
    const docHash = S.sha256Text(readFileSync(rp2, 'utf8'));
    const round = await S.writeSpecReviewLedger(root, lens, { findings: obj.findings, attestation: obj.attestation || '', ...(raw ? { raw } : {}), docHash });
    console.log(`✓ ${lens} r${round} 已落檔（${obj.findings.length} 條 findings；docHash 由 CLI 綁定現行 requirements.md）。`);
    console.log(obj.findings.length
      ? '  下一步：逐條 flow-state review-resolve <SR-id> --as <resolved:REQ-xxx|open|deferred:<id>|rejected:<id>>——發現不能無痕蒸發。'
      : '  零新發現——若已 ≥2 輪且全 findings 終局，spec-ready --freeze 的收斂判準可過。');
    break;
  }
  case 'review-resolve': {
    // 把一條 lens finding 走到四種終局之一（各附機器可驗指標；resolve 當下即驗、freeze 再驗一次）。
    // 用法：flow-state review-resolve <SR-id> --as <resolved:REQ-xxx|open|deferred:<decisionId>|rejected:<decisionId>>
    const fid = argv[1];
    const asStr = flag('--as');
    if (!fid || fid.startsWith('--') || !asStr) { console.error('usage: flow-state review-resolve <SR-id> --as <resolved:REQ-xxx|open|deferred:<id>|rejected:<id>>'); process.exit(1); }
    const ledgers = await S.listSpecReviewLedgers(root);
    const idU = fid.toUpperCase();
    if (!ledgers.some(r => (r.findings || []).some(f => String(f.id || '').toUpperCase() === idU))) {
      console.error(`✗ 查無 finding「${fid}」——它不在任何 .flow/spec-review/ ledger 裡（先 spec-review 落檔才有東西可終局）。`);
      process.exit(1);
    }
    const rp3 = path.join(root, 'specs', 'requirements.md');
    const reqMd = existsSync(rp3) ? readFileSync(rp3, 'utf8') : '';
    const curHash = S.sha256Text(reqMd);
    const fLedger = ledgers.find(r => (r.findings || []).some(f => String(f.id || '').toUpperCase() === idU));
    const prob = S.specResolutionProblem(idU, asStr, reqMd, (did) => existsSync(path.join(root, '.flow', 'decisions', did + '.json')),
      { findingDocHash: fLedger && fLedger.docHash, currentHash: curHash });
    if (prob) { console.error('✗ ' + prob); process.exit(2); }
    await S.writeSpecResolution(root, idU, { as: asStr });
    console.log(`✓ ${idU} → ${asStr}（指標已驗；freeze 前 diagnose review 會再驗一次）。`);
    break;
  }
  default:
    console.log(`flow-state <resume|status|done|checkpoint|mode|project-type|scope|wave|redteam|journey-check|run|verify-ok|verify-e2e|verify-perf|plan-check|review-code|code-resolve|diagnose|lesson|decision|pending|journal-archive|guardrail-check|complete-check|spec-ready|spec-review|review-resolve|mockup-check> [--root <path>]
  resume | status        冷啟動：reconstruct 印現況 + 下一步 + mid-task 進度 + 對帳 + 已知死路（換 session/電腦/中斷後接手；平行波看 /workflows）
  done <id> [--commit]   標一個 task 完成：翻 tasks.md [x] + ledger→delivered（自帶 verify 閘門；先標、再 commit）
  checkpoint <id> --phase <red|green|refactor|integrated> [--note]   記 mid-task 進度（開發中當機 → resume 帶出「上次做到第幾步」，只補沒做完的）
  mode <auto|manual>     設推進模式並寫進 git-tracked manifest（換機 clone 後自駕不掉回 manual）
  project-type <type>    落檔專案類型（Step 1 彈窗拍板後跑；--freeze 對賬：web 類 SHALL 有互動原型或 mockup-waiver 豁免檔）
  scope --wave <ids>     同 repo 平行檔案安全閘門：git 真實變動 vs 各 feature conflictZone，越界 exit 2（整合前跑；另對賬 wave-plan 成員/manifest 未漂移）
  wave --compute         算波次拓樸（blockedBy 依賴序＋conflictZone 互斥自動拆波）＋逐字抽每 task 承接的 REQ 區塊 → .flow/trace/wave-plan.json（dispatch 事實來源；/flow-build 起手跑）
  redteam --wave <ids>   紅軍對賬閘門：.flow/redteam/<id>.json 攻擊 <3、high 未全 covered、testFile 不實存、或高危關鍵字攻擊無痕 skipped（無 waiver decision）→ exit 2
  journey-check [--dir]  journey 真實性閘門：掃 Playwright 測試（mock/網路攔截、單一 test >1 goto）＋playwright.config（retries 非 0、webServer 用 dev）→ exit 2（web 驗證宣稱綠前跑）
  run --task <id> -- <cmd>   verify runner wrapper：真跑命令、捕真 exit code、綁 taskId 落 journal（done 據此擋「跑過但最後紅卻標 done」）
  verify-ok <id> --ref "<證據>" [--tdd <green|refactored|n/a|skipped:…>]   手動/無法自動化驗證的正門：寫 state.json verify/tdd（取代裸寫；spec-gate 擋裸寫）
  verify-e2e <id> --status <pass|fail|n/a> --evidence "<ref>" [--decision <id>]   記一條 REQ-E2E 驗證（自動記 HEAD/reqHash；n/a 須附 decision）
  verify-perf <REQ-PERF-id> --value <數字> --evidence "<ref>"   記 REQ-PERF 達標（從凍結 index 解析 budget、超標拒記；complete-check 對賬）
  plan-check             計畫出口對賬：REQ↔task 覆蓋＋tasks.md↔manifest 逐欄一致 → 落 plan-check.json＋phase="plan-done"，否則 exit 2（/flow-plan 出口跑）
  review-code --file <findings.json>   藍軍 code-review 落機讀檔（/flow-ship Step 1；red flag 進完成謂詞）
  code-resolve <CR-id> --as <fixed:<evidence>|waiver:<decisionId>>   把一條 red flag 走終局（沒處理完 complete-check 擋 ship）
  diagnose <code|coverage|review>   三合一診斷（原 code-check/coverage/review-check）：red flag 終局／REQ-E2E 覆蓋／findings 終局對賬，未過 exit 2（complete-check、freeze 內含同一檢查）
  lesson <id> --approach "<a>" --why "<w>"   記一條失敗記憶（防再生撞同一面牆；標 BLOCKED/stall 升級時記）
  decision <id> --choice "<c>" --why "<w>" [--by user|auto]   記決策留審計（waiver 類 id 預設 by:user＝使用者拍板；其餘預設 by:auto＝自駕自決；自駕下禁自建 waiver/signoff → 改記 pending）
  pending <add|list|resolve>   待決單（自駕碰重試仍過不了的關卡→記一張繼續跑，收尾一批彈窗請使用者拍板；complete-check 對 pending 非空 exit 2）
  guardrail-check        自駕前置：確認 settings.json 含 stall 斷路器，缺則 exit 2（/flow 寫 mode:auto 前跑）
  complete-check         完成謂詞硬閘門：tasks.md 全 [x] ＋ requirements.md 實存 ＋ 所有 REQ-E2E-* 有 pass/n-a 記錄 才准發 COMPLETE，否則 exit 2（/flow-ship 出口跑）
  spec-ready [--freeze]  需求收斂閘門：### 開放問題 段缺失/沒清零、缺 REQ-E2E·PERF、placeholder、REQ-E2E 缺 journey 結構、PERF N/A 無豁免檔 → exit 2（含糊詞僅警告；--freeze 另對賬 projectType＋走查台/mockup-waiver＋lens 收斂/findings 終局＋ui-signoff）
  spec-review <lens> --file <findings.json> [--exec "<cmd>"]   收一輪 lens 審查落 ledger（redteam|consistency|codex；docHash 由 CLI 自算、round 自動遞增）
  review-resolve <SR-id> --as <resolved:REQ-xxx|open|deferred:<id>|rejected:<id>>   把一條 finding 走到終局（附機器可驗指標，發現不能無痕蒸發）
  mockup-check [--dir]   互動原型走查閘門：specs/ui-mockups/index.html 缺 REQ-E2E 走查卡、本地連結 404、或連到的頁面是空殼（無 app.js/互動元素）→ exit 2（產完原型、開瀏覽器請使用者定版前跑）
決策/討論一律回 Claude（彈窗）；狀態都在專案的 .flow/。`);
}
