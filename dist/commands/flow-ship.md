---
description: Flow Phase 5 — 出貨收束。跨 feature 整合 e2e + 完整效能 budget + 全 diff 獨立審查 + 清 X-* cross-cutting + 達成完成謂詞，準備出貨
---

# /flow-ship — Phase 5：跨 feature 整合 + 收束出貨

**目標**：把各自驗過的 features 串成整體驗收，達成**完成謂詞**才出貨。**不重跑單個 feature 的驗證**（那在 `/flow-build` 已做），只做 per-feature 跑不了的跨 feature 事。

## Step 1：全 diff 獨立審查（藍軍）

對 `main..HEAD` 全 diff 跑獨立 `code-reviewer` subagent（另開 context）：紅軍攻擊面（讀 `.flow/redteam/*.json`，build 落檔的機讀清單，**必有輸入**——缺檔＝build 流程缺陷，列為問題）是否真有防禦、每個 REQ 找不找得到對應實作、code smell、安全/效能潛在問題。**finding 不論是否在本次 diff 範圍 SHALL 全列**（順手修紀律）；安全 red flag 一律暫停。diff 含 auth/RBAC/migration/payment/金錢/個資 → 建議跑 codex 獨立對抗審查（裝了才問）。

**red flag SHALL 落機讀檔**：把 code-reviewer 回的結構化 findings 存暫存檔 → `flow-state review-code --file <findings.json>` 落 `.flow/code-review/findings.json`（零 red flag 也落空陣列＝證明審過）。接著逐條把 red flag 走終局：修了 → `flow-state code-resolve <CR-id> --as fixed:<file:line/commit/測試名>`；使用者拍板不修 → `--as waiver:<decisionId>`（先 `flow-state decision` 留檔）。**Step 5 的 complete-check 逐條對賬，未終局的 red flag 擋 ship**——把「藍軍 red flag」從散文清單升級成完成謂詞的一部分（yellow flag 記錄不擋）。

## Step 2：跨 feature 整合 journey

跑 `references/playwright-real-data-template.md` 三鐵則，對象是**單 feature 驗不到的**：
- `REQ-E2E-*` 跨 feature workflow（feature A 的輸出餵進 feature C 的串接）
- **auth / role 橫切矩陣**（不同角色看到/做得到不同的事，驗 scope 正確）
- 真實資料鏈路（真後端真 DB、禁 mock），headed 序列跑（headed 無法多開，此限制不因用 recipe/subagent 而解除）

**SHALL 用 `references/recipes/parallel-verify.js` 或另開 evaluator subagent（另開 context）執行**，不在主迴圈直接跑——高噪音 Playwright 輸出留在子 context，主迴圈只收 PASS/FAIL + 數字證據摘要（1-2k 蒸餾，對齊 `references/orchestration-guide.md` §6 context firewall）。宣稱整合 e2e 綠前 SHALL 跑 `flow-state journey-check`（掃 mock/網路攔截＋單一入口 goto，exit 2 擋假綠）。每條跨 feature `REQ-E2E-*` 真綠後同樣 `flow-state verify-e2e <id> --status pass --evidence "<ref>"` 記錄，供 Step 5 對賬。

## Step 3：完整效能 budget（僅 REQ-PERF-*）

對所有 `REQ-PERF-*` 跑完整效能驗收（`references/perf-budget.md`）：load + render + API 延遲，p50 + p95，**任一維度不達標 = FAIL**（硬閘門不准平均）。讀取/渲染太慢一律不放行。

**SHALL 用 `references/recipes/parallel-verify.js` 或另開 evaluator subagent（另開 context）執行**，同 Step 2 理由——k6/autocannon/lighthouse 等高噪音輸出不得灌進主迴圈，主迴圈只收每個 `REQ-PERF-*` 的 PASS/FAIL + p50/p95 數字摘要。

## Step 4：Cross-cutting 必清檢查

`specs/tasks.md` 的 `X-*` 段**全部 `[x]` 才放行**；未清 → 暫停列出，問使用者本輪清還是進 Backlog（明說延後才寫 Backlog 留紀錄）。

## Step 5：完成謂詞（收束的終點，確定性閘門守）

**發 COMPLETE 前 SHALL 跑 `flow-state complete-check`**（mac/linux `node ~/.claude/skills/flow-toolkit/flow-state.mjs complete-check`、Windows PS 對應路徑）——它確定性守**全鏈**：① 掃 `specs/tasks.md` 任一未完成 `[ ]` 即 exit 2；② `requirements.md` 缺檔/查無任何 `REQ-E2E-*`（被歸檔/收束成殼）即 exit 2；③ **現行 `requirements.md` hash == 凍結 index**（凍結後被偷改即 exit 2，還原或重跑 `spec-ready --freeze`）；④ **逐條對賬 `REQ-E2E-*` vs `.flow/verify/` pass/n-a 記錄**（n/a 醒目列出）；⑤ **逐條對賬 `REQ-PERF-*` vs `flow-state verify-perf` 達標記錄**（把「仍須人工確認 REQ-PERF」的死散文換成機讀謂詞——每條 REQ-PERF 要嘛有達標記錄、要嘛標 N/A＋perf-waiver decision）；⑥ **`plan-check.json` 的 manifest hash == 現行 manifest**（plan 後 manifest 被改＝scope/wave 事實來源漂移，重跑 plan-check）；⑦ **藍軍 code-review 已跑且 red flag 全終局**——ship SHALL 過藍軍：`.flow/code-review/findings.json` 須存在（Step 1 的 review-code 落檔）且每條 red flag 都 fixed/waiver，否則 exit 2；真要跳過藍軍走 `flow-state decision code-review-waiver` 留一筆可稽核豁免（與 build 端 redteam --wave 對稱、不留「整段不跑就繞過」的洞）。任一未過 exit 2。自駕無人盯著時尤其要，防模型自報全中提早收工。

**REQ-PERF 達標記錄怎麼來**：`/flow-verify` 或本階段量到 p50/p95 後，`flow-state verify-perf <REQ-PERF-id> --value <實測數字> --evidence "<k6/autocannon/lighthouse 輸出 ref>"`——CLI 從凍結 index 解析 budget、**超標拒記**（含 5% 容差），達標才落 pass。

通過後：寫 state.json `phase="shipped"`、發 `<promise>COMPLETE</promise>`，**停止迭代**（滿足謂詞就收，不再打磨）。任一未中 → 回對應階段，**不准出通過報告**。

## Step 6：全系統垃圾兜底 + 出貨準備

- **全系統清驗證垃圾（commit 前 SHALL 做）**：跑 `clean-verify-artifacts.mjs --apply --gitignore`（整合 e2e／效能驗收會生最多 **`.playwright-mcp/` MCP 殘留**，ship 前尤其多）。**沒清就 commit 會被 `flow-commit-gate` 閘門一 exit 2 擋**。細節見 `references/verification-playbook.md` §七。
- D-source 改動 commit 前精準單點 revert（禁 `git checkout .`/`reset --hard`）。
- 出貨準備：**呼叫 `git-tools` skill** 做智慧 commit+push（push 失敗回報、不擅自 `--force`）+ PR description（對應 REQ、列驗證證據與效能數字）。merge 衝突 / `.env` 等敏感檔才問使用者。

## 完成判準（self-check）
- [ ] 全 diff 獨立審查跑過、finding 全列、安全 red flag 已處理
- [ ] 跨 feature e2e + auth/role 矩陣綠（真實資料鏈路）
- [ ] 所有 REQ-PERF-* 達 budget（p50+p95）
- [ ] X-* 清空、完成謂詞全中、發 COMPLETE
- [ ] 出貨物（commit/PR）就緒，驗證證據附上
