#!/usr/bin/env node
// flow-state — Flow .flow/ 狀態 CLI。換手接手用：冷啟動 reconstruct 純讀檔印現況 + 下一步 + 原子標完成。
// 全域裝一次（~/.claude/skills/flow-toolkit），對「當前專案」生效（讀 cwd 或 --root 的 .flow/）。
// 決策/討論一律回 Claude（彈窗）；狀態都在各專案的 .flow/。進度看這支的文字輸出；平行波看 /workflows。
import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
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

// git 真實變動檔（staged + unstaged + untracked）。模型偽造不了——這是 scope 閘門的事實來源。
function gitChangedFiles(r) {
  let out = '';
  // -uall：展開未追蹤目錄到「個別檔」（預設會把整個未追蹤目錄收合成一行，scope 比對需要檔案層級）。
  // core.quotepath=false：中文/非 ASCII 檔名輸出 UTF-8 原文而非 octal escape（否則 zone 比對必假陽性）。
  try { out = execSync('git -c core.quotepath=false status --porcelain -uall', { cwd: r, encoding: 'utf8' }); } catch { return []; }
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let p = line.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ')[1]; // rename：取新路徑
    files.push(p.replace(/^"(.*)"$/, '$1'));         // 去掉 git 對特殊字元加的引號
  }
  return files;
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
    const md = r.tasksMd.changed ? 'tasks.md [x] 已翻' : (r.tasksMd.found ? 'tasks.md 本已 [x]' : '⚠ tasks.md 無對應行（id 對不上？）');
    const lg = r.alreadyDelivered ? 'ledger 本已 delivered' : 'ledger→delivered';
    console.log(`✓ ${r.id}：${md}；${lg}${commit ? `；commit=${commit}` : ''}`);
    console.log(`  下一步：照常 git commit（commit gate 已可放行此 task）${staged ? '；已自動 stage .flow 耐久證據＋tasks.md、不會落隊' : ''}。`);
    break;
  }
  case 'mode': {
    // 設定推進模式，寫進 git-tracked manifest（換機 clone 後自駕不掉回 manual）+ state.json（相容既有讀取）。
    // 用法：flow-state mode <auto|manual>
    const m = argv[1];
    if (m !== 'auto' && m !== 'manual') { console.error('usage: flow-state mode <auto|manual>'); process.exit(1); }
    const manifest = await S.readManifest(root);
    await S.writeManifest(root, { ...manifest, mode: m });
    const st = await S.readStateJson(root);
    await S.writeStateJson(root, { ...st, mode: m });
    console.log(`✓ 推進模式設為 ${m}：寫進 .flow/manifest.json（進 git、換機 clone 後保留）+ state.json。`);
    if (m === 'auto') console.log('  提醒：啟用自駕前 SHALL 先過 flow-state guardrail-check（stall 斷路器在線）。');
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
    const r = S.checkScope(gitChangedFiles(root), zonesByFeature);
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
    // 審計語意：waiver/signoff 類（perf-waiver/mockup-waiver/redteam-waiver-*/ui-signoff）規格上是
    // 「使用者彈窗拍板後留檔」，預設記 by:'user'；其餘（自駕 C 類自決）預設 by:'auto'。--by 可明示覆寫。
    const by = flag('--by') || (/waiver|signoff/i.test(rid) ? 'user' : 'auto');
    if (by !== 'user' && by !== 'auto') { console.error('--by 須為 user / auto'); process.exit(1); }
    try { await S.recordDecision(root, rid, { question: flag('--question') || '', choice, why: flag('--why') || '', by }); }
    catch (e) { if (e && e.code === 'UNSAFE_ID') { console.error('✗ ' + e.message); process.exit(1); } throw e; }
    console.log(`✓ ${by === 'user' ? '已記使用者拍板' : '已記自決'}：${rid}：${choice}${flag('--why') ? `（${flag('--why')}）` : ''}`);
    console.log('  審計線在 .flow/journal.ndjson（ev:decision）；最新快照在 .flow/decisions/。使用者可事後翻、要改再說。');
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
    // 自駕前置硬閘門：確認 stall 斷路器在線（settings.json PostToolUse 含 flow-stall-monitor）。
    // /flow 寫 mode:auto 前 SHALL 跑；缺則 exit 2，退回每階段停、不假裝自駕（無花費上限下唯一剎車不能缺）。
    const home = flag('--claude-home') || process.env.CLAUDE_HOME ||
      path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude');
    let raw = '';
    try { raw = readFileSync(path.join(home, 'settings.json'), 'utf8'); }
    catch { console.error(`✗ 找不到 ${path.join(home, 'settings.json')}——無法確認護欄在線。先跑 install 裝 Flow hooks 再啟用自駕。`); process.exit(2); }
    if (!/flow-stall-monitor\.mjs/.test(raw)) {
      console.error('✗ 自駕護欄缺失：settings.json 沒有 flow-stall-monitor（doom-loop 斷路器）。');
      console.error('  無花費上限下這是唯一剎車。重跑 install 裝齊 hooks 再啟用自駕，或本次走「每階段停」。');
      process.exit(2);
    }
    console.log('✓ 自駕護欄在線：stall 斷路器（flow-stall-monitor）已註冊，可啟用自駕。');
    break;
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
    // REQ-E2E 覆蓋對賬（把原本的散文提示升級成確定性節點）。requirements.md 缺則提醒不擋（不破壞既有最小用法）。
    const cov = await coverageReport(root);
    // W0-7：缺 requirements.md 從警告升 exit 2——「歸檔/改名 spec ＝ 整段 REQ-E2E 完成謂詞靜默關閉」的洞封死。
    if (cov.skipped) { console.error('✗ 查無 specs/requirements.md——REQ-E2E 完成謂詞無從對賬，不准發 COMPLETE（spec 被歸檔/改名？還原它，或用 --root 指對專案根）。'); process.exit(2); }
    // 檔案實存但被收束成 0 條 REQ-E2E 的殼（/flow-compact 歸檔變體）＝完成謂詞 0/0 空轉，同擋。
    if (cov.audit.total === 0) { console.error('✗ specs/requirements.md 實存但查無任何 REQ-E2E-*——spec 被收束成殼？（凍結底線＝至少 1 條）從 specs/archive/ 還原完整版再對賬，不准發 COMPLETE。'); process.exit(2); }
    printCoverage(cov.audit);
    if (!cov.audit.ok) {
      console.error('✗ 完成謂詞未達：上列 REQ-E2E-* 未全部驗綠，不准發 COMPLETE。');
      console.error('  每條 REQ-E2E journey 經 /flow-verify 真跑綠後，用 flow-state verify-e2e <id> --status pass --evidence "<ref>" 記錄；無法自動化的標 --status n/a 並附原因。');
      process.exit(2);
    }
    console.log(`✓ 所有 ${cov.audit.total} 條 REQ-E2E-* 都有 pass/n-a 驗證記錄。仍須人工確認 REQ-PERF-* 達 budget。`);
    break;
  }
  case 'coverage': {
    // REQ-E2E 覆蓋對賬（可單獨跑、診斷用；complete-check 內含同一檢查）。
    // 用法：flow-state coverage —— 比對 requirements.md 的 REQ-E2E-* vs .flow/verify/*.json 記錄。
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
    try { await S.writeVerifyRecord(root, id.toUpperCase(), { status: norm, evidence, by: 'evaluator' }); }
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
    const journeyFiles = [], problemsAll = [], warningsAll = [];
    for (const f of walkTestFiles(base)) {
      let content = '';
      try { content = readFileSync(f, 'utf8'); } catch { continue; }
      const a = S.auditJourneyTest(content);
      if (!a.isJourney) continue;
      const rel = path.relative(root, f).replace(/\\/g, '/');
      journeyFiles.push(rel);
      for (const p of a.problems) problemsAll.push(`${rel}: ${p}`);
      for (const w of a.warnings) warningsAll.push(`${rel}: ${w}`);
    }
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
    console.log('\n✓ journey 真實性通過：無 mock/網路攔截、每個 test 單一入口 goto。');
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
      const cycleLedgers = S.currentCycleLedgers(allLedgers, await S.readJournal(root));
      const reqText = readFileSync(rp, 'utf8');
      const curHash = S.sha256Text(reqText);
      const decisionExists = (did) => existsSync(path.join(root, '.flow', 'decisions', did + '.json'));
      const srProblems = [
        ...S.lensConvergenceAudit(cycleLedgers, curHash),
        ...S.reviewCheckAudit(allLedgers, await S.readSpecResolutions(root), reqText, decisionExists, curHash),
      ];
      if (srProblems.length) {
        console.error('✗ 多角度審查未收斂，不能凍結（迴圈細節見 references/spec-review-loop.md）：');
        for (const p of srProblems) console.error('  - ' + p);
        process.exit(2);
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
      await S.appendJournal(root, { ev: 'spec.frozen' });
      console.log('✓ 需求已收斂（### 開放問題 清零＋REQ-/REQ-E2E-/REQ-PERF- 齊）且已凍結：phase="spec-done"。');
      console.log('  下一步：web 類先確認互動原型已彈窗定版，再進 /flow-plan（自駕會自動接續）。');
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
    console.log(`✓ ${idU} → ${asStr}（指標已驗；freeze 前 review-check 會再驗一次）。`);
    break;
  }
  case 'review-check': {
    // findings 終局化對賬（可單獨跑、診斷用；spec-ready --freeze 內含同一檢查＋lens 收斂判準）。
    const ledgers = await S.listSpecReviewLedgers(root);
    if (!ledgers.length) { console.log('⚠ 查無任何 .flow/spec-review/ ledger——lens 審查還沒跑（freeze 會要求 redteam/consistency 各 ≥2 輪）。'); break; }
    const rp4 = path.join(root, 'specs', 'requirements.md');
    const reqMd = existsSync(rp4) ? readFileSync(rp4, 'utf8') : '';
    const problems = S.reviewCheckAudit(ledgers, await S.readSpecResolutions(root), reqMd,
      (did) => existsSync(path.join(root, '.flow', 'decisions', did + '.json')), S.sha256Text(reqMd));
    if (problems.length) {
      console.error('✗ findings 終局化對賬未過（發現不能無痕蒸發）：');
      for (const p of problems) console.error('  - ' + p);
      process.exit(2);
    }
    const total = ledgers.reduce((n, r) => n + (r.findings || []).length, 0);
    console.log(`✓ ${total} 條 findings 全數終局且指標有效（resolved/open/deferred/rejected）。`);
    break;
  }
  default:
    console.log(`flow-state <resume|status|done|checkpoint|mode|project-type|scope|redteam|journey-check|verify-e2e|coverage|lesson|decision|guardrail-check|complete-check|spec-ready|spec-review|review-resolve|review-check|mockup-check> [--root <path>]
  resume | status        冷啟動：reconstruct 印現況 + 下一步 + mid-task 進度 + 對帳 + 已知死路（換 session/電腦/中斷後接手；平行波看 /workflows）
  done <id> [--commit]   標一個 task 完成：翻 tasks.md [x] + ledger→delivered（自帶 verify 閘門；先標、再 commit）
  checkpoint <id> --phase <red|green|refactor|integrated> [--note]   記 mid-task 進度（開發中當機 → resume 帶出「上次做到第幾步」，只補沒做完的）
  mode <auto|manual>     設推進模式並寫進 git-tracked manifest（換機 clone 後自駕不掉回 manual）
  project-type <type>    落檔專案類型（Step 1 彈窗拍板後跑；--freeze 對賬：web 類 SHALL 有互動原型或 mockup-waiver 豁免檔）
  scope --wave <ids>     同 repo 平行檔案安全閘門：git 真實變動 vs 各 feature conflictZone，越界 exit 2（整合前跑）
  redteam --wave <ids>   紅軍對賬閘門：.flow/redteam/<id>.json 攻擊 <3、high 未全 covered、testFile 不實存、或高危關鍵字攻擊無痕 skipped（無 waiver decision）→ exit 2
  journey-check [--dir]  journey 真實性閘門：掃 Playwright 測試，出現 mock/網路攔截 或 單一 test 內 >1 goto → exit 2（web 驗證宣稱綠前跑）
  verify-e2e <id> --status <pass|fail|n/a> --evidence "<ref>"   記一條 REQ-E2E journey 驗證結果（Evaluator 真綠後落檔，供 coverage 對賬）
  coverage               REQ-E2E 覆蓋對賬：requirements.md 的 REQ-E2E-* vs .flow/verify 記錄，缺/未過 exit 2
  lesson <id> --approach "<a>" --why "<w>"   記一條失敗記憶（防再生撞同一面牆；標 BLOCKED/stall 升級時記）
  decision <id> --choice "<c>" --why "<w>" [--by user|auto]   記決策留審計（waiver 類 id 預設 by:user＝使用者拍板；其餘預設 by:auto＝自駕自決）
  guardrail-check        自駕前置：確認 settings.json 含 stall 斷路器，缺則 exit 2（/flow 寫 mode:auto 前跑）
  complete-check         完成謂詞硬閘門：tasks.md 全 [x] ＋ requirements.md 實存 ＋ 所有 REQ-E2E-* 有 pass/n-a 記錄 才准發 COMPLETE，否則 exit 2（/flow-ship 出口跑）
  spec-ready [--freeze]  需求收斂閘門：### 開放問題 段缺失/沒清零、缺 REQ-E2E·PERF、placeholder、REQ-E2E 缺 journey 結構、PERF N/A 無豁免檔 → exit 2（含糊詞僅警告；--freeze 另對賬 projectType＋走查台/mockup-waiver＋lens 收斂/findings 終局＋ui-signoff）
  spec-review <lens> --file <findings.json> [--exec "<cmd>"]   收一輪 lens 審查落 ledger（redteam|consistency|codex；docHash 由 CLI 自算、round 自動遞增）
  review-resolve <SR-id> --as <resolved:REQ-xxx|open|deferred:<id>|rejected:<id>>   把一條 finding 走到終局（附機器可驗指標，發現不能無痕蒸發）
  review-check           findings 終局化對賬：任一 finding 未終局/指標失效 → exit 2（freeze 內含同一檢查）
  mockup-check [--dir]   互動原型走查閘門：specs/ui-mockups/index.html 缺 REQ-E2E 走查卡、本地連結 404、或連到的頁面是空殼（無 app.js/互動元素）→ exit 2（產完原型、開瀏覽器請使用者定版前跑）
決策/討論一律回 Claude（彈窗）；狀態都在專案的 .flow/。`);
}
