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
    const md = r.tasksMd.changed ? 'tasks.md [x] 已翻' : (r.tasksMd.found ? 'tasks.md 本已 [x]' : '⚠ tasks.md 無對應行（id 對不上？）');
    const lg = r.alreadyDelivered ? 'ledger 本已 delivered' : 'ledger→delivered';
    console.log(`✓ ${r.id}：${md}；${lg}${commit ? `；commit=${commit}` : ''}`);
    console.log('  下一步：照常 git commit（commit gate 已可放行此 task）。');
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
      const coverage = rec.coverage || [];
      for (const a of (rec.attacks || [])) {
        const sev = String(a.severity || '').toLowerCase();
        const c = coverage.find((x) => x.attackId === a.id && x.status === 'covered');
        if (sev === 'high' && !c) { problems.push(`${id}/${a.id}（high）：無 covered 對應項——high 攻擊不准 skipped，先補失敗安全測試轉綠`); continue; }
        // 任何 covered（含 medium/low）都驗 testFile 真實有效（非空 + 含測試關鍵字），堵「touch 空檔即過閘」
        if (c) { const prob = testFileProblem(c.testFile); if (prob) problems.push(`${id}/${a.id}（${sev || '?'}）：${prob}——coverage 是自報的，檔案得真的是測試`); }
      }
    }
    if (problems.length) {
      console.error('✗ 紅軍對賬未過：');
      for (const x of problems) console.error('  ' + x);
      console.error('  暫停整合：補測試/落檔後重跑。別跳過本閘門硬整合（high 攻擊面沒防禦＝出貨即漏洞）。');
      process.exit(2);
    }
    console.log('✓ 紅軍對賬通過：本波 high 攻擊全數 covered 且 testFile 實存。');
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
    try { await S.recordDecision(root, rid, { question: flag('--question') || '', choice, why: flag('--why') || '', by: 'auto' }); }
    catch (e) { if (e && e.code === 'UNSAFE_ID') { console.error('✗ ' + e.message); process.exit(1); } throw e; }
    console.log(`✓ 已記自決：${rid}：${choice}${flag('--why') ? `（${flag('--why')}）` : ''}`);
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
    if (cov.skipped) { console.error('⚠ 查無 specs/requirements.md——略過 REQ-E2E 覆蓋對賬（ship 階段不該缺，請確認）。'); break; }
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
    // 用法：flow-state spec-ready            僅檢查（訪談收斂後、產 mockup 前跑；綠了才往下）
    //       flow-state spec-ready --freeze   檢查通過才寫 phase="spec-done"（凍結唯一正門，取代裸寫 state.json）
    const rp = path.join(root, 'specs', 'requirements.md');
    if (!existsSync(rp)) {
      console.error('✗ 查無 specs/requirements.md——還沒有可凍結的需求。先跑 /flow-spec 訪談並寫 requirements.md。');
      process.exit(2);
    }
    const { open, problems } = S.specReadiness(readFileSync(rp, 'utf8'));
    if (problems.length) {
      console.error('✗ 需求尚未收斂，不能凍結／推進：');
      for (const p of problems) console.error('  - ' + p);
      if (open.length) { console.error('  未收斂的開放問題：'); for (const q of open.slice(0, 12)) console.error('    · ' + q); }
      console.error('  繼續蘇格拉底訪談 + grill-me + spec-reviewer，把每一項問到拍板（彈窗）後全清零再凍結。別手改檔繞過閘門。');
      process.exit(2);
    }
    if (argv.includes('--freeze')) {
      const st = await S.readStateJson(root);
      await S.writeStateJson(root, { ...st, phase: 'spec-done' });        // read-modify-write，保留 mode/tasks/verify/tdd
      await S.appendJournal(root, { ev: 'spec.frozen' });
      console.log('✓ 需求已收斂（### 開放問題 清零＋REQ-/REQ-E2E-/REQ-PERF- 齊）且已凍結：phase="spec-done"。');
      console.log('  下一步：web 類先確認 UI mockup 已彈窗定版，再進 /flow-plan（自駕會自動接續）。');
    } else {
      console.log('✓ 需求已收斂：### 開放問題 清零、REQ-/REQ-E2E-/REQ-PERF- 齊。可產 mockup → 凍結（flow-state spec-ready --freeze）。');
    }
    break;
  }
  default:
    console.log(`flow-state <resume|status|done|checkpoint|mode|scope|redteam|journey-check|verify-e2e|coverage|lesson|decision|guardrail-check|complete-check|spec-ready> [--root <path>]
  resume | status        冷啟動：reconstruct 印現況 + 下一步 + mid-task 進度 + 對帳 + 已知死路（換 session/電腦/中斷後接手；平行波看 /workflows）
  done <id> [--commit]   標一個 task 完成：翻 tasks.md [x] + ledger→delivered（自帶 verify 閘門；先標、再 commit）
  checkpoint <id> --phase <red|green|refactor|integrated> [--note]   記 mid-task 進度（開發中當機 → resume 帶出「上次做到第幾步」，只補沒做完的）
  mode <auto|manual>     設推進模式並寫進 git-tracked manifest（換機 clone 後自駕不掉回 manual）
  scope --wave <ids>     同 repo 平行檔案安全閘門：git 真實變動 vs 各 feature conflictZone，越界 exit 2（整合前跑）
  redteam --wave <ids>   紅軍對賬閘門：.flow/redteam/<id>.json 的 high 攻擊須全 covered 且 testFile 實存，否則 exit 2
  journey-check [--dir]  journey 真實性閘門：掃 Playwright 測試，出現 mock/網路攔截 或 單一 test 內 >1 goto → exit 2（web 驗證宣稱綠前跑）
  verify-e2e <id> --status <pass|fail|n/a> --evidence "<ref>"   記一條 REQ-E2E journey 驗證結果（Evaluator 真綠後落檔，供 coverage 對賬）
  coverage               REQ-E2E 覆蓋對賬：requirements.md 的 REQ-E2E-* vs .flow/verify 記錄，缺/未過 exit 2
  lesson <id> --approach "<a>" --why "<w>"   記一條失敗記憶（防再生撞同一面牆；標 BLOCKED/stall 升級時記）
  decision <id> --choice "<c>" --why "<w>"   記一個自駕自決分歧（T1 放手下 AI 自決的 C 類需求分歧留審計）
  guardrail-check        自駕前置：確認 settings.json 含 stall 斷路器，缺則 exit 2（/flow 寫 mode:auto 前跑）
  complete-check         完成謂詞硬閘門：tasks.md 全 [x] ＋ 所有 REQ-E2E-* 有 pass/n-a 記錄 才准發 COMPLETE，否則 exit 2（/flow-ship 出口跑）
  spec-ready [--freeze]  需求收斂閘門：requirements.md ### 開放問題 沒清零/缺 REQ-E2E·PERF → exit 2（產 mockup 前＋凍結前跑；--freeze 通過才寫 spec-done）
決策/討論一律回 Claude（彈窗）；狀態都在專案的 .flow/。`);
}
