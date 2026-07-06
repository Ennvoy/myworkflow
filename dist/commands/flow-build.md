---
description: Flow Phase 3 — 多工交付（混合基座）。取當前波次互不依賴的 features，用 Workflow 腳本在同 repo fan-out 平行生成 worker，紅軍先行→TDD→序列整合（build/驗證/commit 一個個）→per-task commit，推進下一波
---

# /flow-build — Phase 3：多工並行交付

**目標**：把 `tasks.md` 的 features **真的並行**做掉，每個 task 從 UI 一路做到 DB、可 demo、可 commit、可放生。

**混合基座（已定）**：**波次內** fan-out 用 Workflow 腳本（背景跑、結構化回傳、可重播）；**階段/波次之間**保留互動式人工閘門，你拍板才推進。**同 repo 模型**：worker 平行**生成**（只寫各自不重疊的檔），build/驗證/commit 由主流程**序列**做。**前提**：當前專案是 git repo；不是 → 先 `git init`。展開細節見 `references/build-playbook.md`。

## Step 0：冷啟動讀現況

跑 `flow-state resume`（mac/linux `node ~/.claude/skills/flow-toolkit/flow-state.mjs resume`、Windows PS 對應路徑）用 statelib **reconstruct** 純從磁碟重建「還剩什麼 + 未完成 dangling」，有 dangling 先冪等補完；補 `specs/tasks.md` 的 `[ ]`/`[x]`。**也帶出每個開發中 task 的 mid-task checkpoint——接續該相、別重跑整個 task**（語法見 build-playbook.md §四）。
**進度怎麼看**：`flow-state status`；平行生成看 Workflow 的 `/workflows`。

## Step 1：算當前波次可並行集合

**別在 thinking 裡心算波次**——SHALL 跑 `flow-state wave --compute`（mac/linux `node ~/.claude/skills/flow-toolkit/flow-state.mjs wave --compute`、Windows PS 對應路徑）：讀 manifest 的 `blockedBy`/`conflictZone` ＋ ledger delivered 算拓樸序，落 `.flow/trace/wave-plan.json`（含 manifest hash + reqHash）＝本波 dispatch 的**唯一事實來源**；**成環/懸空依賴 exit 2**。manifest 事後改動 → 重跑本指令。拓樸細節/foundation 先序列/契約釘法/波次寬度/就緒探針見 `build-playbook.md` §一。

## Step 1.5：執行策略閘門（偏離預設平行 SHALL 彈窗，別在散文裡自己降級）

**預設路徑 = 本波可並行集合逐 feature fan-out 平行生成（Step 3）**。要偏離——降級成序列或只部分平行——**SHALL 先 `AskUserQuestion` 彈窗讓使用者拍板**，白話列可並行集合、建議策略＋理由、trade-off（省 token/一致性 ↔ 速度）。照預設全平行 → **不必問**，直接進 Step 2/3。**禁止在 thinking/散文裡自行降級**——那是 `Ask first` 等級的 trade-off（flow.md 三層邊界），非 orchestrator 可單方拍板。拍板後把策略＋一句 rationale 寫進 `.flow/manifest.json`（進 git）或 journal（`waveStrategy`/`strategyReason`）——**別寫進 gitignored 的 `.flow/state.json`**。

## Step 2：紅軍先行（單一執行點＝fan-out recipe 的 Stage 1）

紅軍由 `parallel-build.js` **Stage 1** 對本波每個 feature 平行執行（`red-team` agentType、獨立 context、唯讀），攻擊面（含編號 id）直接餵進同 pipeline 的 worker——**不在主迴圈另跑一輪紅軍**（雙重執行＝token 雙燒）。Workflow 回來後 orchestrator SHALL 把 `redTeam`＋`attackCoverage` 落檔 `.flow/redteam/<id>.json`（`/flow-ship` code-reviewer **必讀輸入**）——沒落檔會被 Step 4 的 `flow-state redteam` 閘門 exit 2 擋整合。任一 high severity → 建議跑 codex 獨立審查補強（裝了才問）。

## Step 3：fan-out 平行生成 worker（Workflow 腳本，同 repo）

用 `references/recipes/parallel-build.js` spawn worker，**每 feature 一個**，同一工作目錄平行生成。prompt 帶逐字 REQ（`wave-plan.json` 的 `reqText`，別叫 worker 自讀 requirements.md）+ 契約 + conflictZone、紅軍攻擊面轉失敗安全測試、TDD 三相（每過一相落 checkpoint）、真實資料鏈路鐵則（禁 mock、真依賴未 ready 標 BLOCKED）、涉 UI 先取 `ui-ux-pro-max` 建議、檔案/工具邊界、要求結構化回傳。**完整 prompt 模板＋worker 禁令清單**見 `build-playbook.md` §二、§三。
- **成本路由（Reasoning Sandwich）**：平行苦工 worker 走較便宜 model（recipe 的 `args.workerModel`，預設 Sonnet、可覆寫、不 hardcode 行為）——省 token＝同預算能 fan-out 更寬的波；紅軍／Evaluator 高價值對抗審查，**維持高階不降級**。

fan-out 前 orchestrator 先 write-ahead：對本波每個 id 呼叫 `statelib.transition(root, id, 'pending', 'building')`，讓 `flow-state status` 反映生成中；並落 `flow-state checkpoint --phase dispatched/worker-returned/integrated` 三個確定性節點守中斷重啟接續（語法見 `build-playbook.md` §四）。

## Step 4：序列整合（逐 feature，主流程序列做）

Workflow 回來後，orchestrator 依拓樸序**一個一個**收尾每個 feature：
- **檔案安全閘門（整合前 SHALL 先跑）**：`flow-state scope --wave <本波 ids>`（mac/linux `node ~/.claude/skills/flow-toolkit/flow-state.mjs scope --wave F-1,F-2`、Windows PS 對應路徑）——worker 越界改共用檔/foundation → **exit 2 暫停**，查清再整合。展開見 `build-playbook.md` §五。
- **紅軍對賬閘門（與 scope 同點 SHALL 跑）**：`flow-state redteam --wave <本波 ids>`（路徑同 scope）——覆蓋率不足/high 未 covered/testFile 不存在/高危攻擊無痕 skipped → **exit 2 暫停**整合。展開見 `build-playbook.md` §五。
- 掃 `driveBy`：**安全/資料正確性 red flag（SQLi、auth bypass、密碼明文、destructive query 缺 WHERE）一律暫停**告知使用者。
- 有 `blockers` 的標 BLOCKED／needs-decision，跳過；**順手 `flow-state lesson <id> --approach "<試過什麼>" --why "<為何卡住>"`** 記失敗記憶。其餘一次一個進 Step 5。

## Step 5：feature 自身驗證 → per-task commit（序列，一次一個；驗證與 commit 解耦）

接 Step 4 逐 feature。**便宜 sensor 先跑、一錯馬上停**：秒級 type-check / lint / 單元測試擋笨錯誤，**過了才**燒分鐘級行為驗證（`/flow-verify` 窄範圍：Playwright headed + 真實資料鏈路）——別在貴的 headed e2e 上為一個 typo 燒一輪。**貴迴圈有界＋check-in 間隔**見 `verification-playbook.md` §四。
- **Context firewall（computational sensor 蒸餾，鐵則）**：type-check / lint / 單元測試 / build SHALL 包進獨立 subagent 或 `flow-state run` 腳本跑，只把蒸餾後的「pass/fail ＋ 前 N 條錯誤摘要」回傳主迴圈——冗長完整輸出**不得**直接灌進 orchestrator context（見 flow.md「Context 預算」）。
- **效能：每 feature 只跑便宜 smoke**；**嚴謹 p50/p95 留到 `/flow-ship` 量一次**，避免嚴謹量測在每 feature ×N 重燒。
- **驗證與 commit 解耦**：驗證 PASS 才進 commit；某 feature FAIL/BLOCKED **不擋其他已 PASS feature 的 commit**。
- **commit 前清驗證垃圾**（雙軌流程、白名單、`flow-commit-gate` 擋法）：見 `references/verification-playbook.md` §七。
- 完成一項（順序鐵則：**先標、再 commit**，閘門會強制）：
  1. TaskUpdate completed（`flow-verify-gate` hook 會在 `verify` 空/`none` 時擋下）。
  2. **跑 `flow-state done <id>`**（mac/linux `node ~/.claude/skills/flow-toolkit/flow-state.mjs done <id>`、Windows PS 對應路徑；`<id>` 用 canonical task id）。**`verify`/`tdd` 空/`none` → exit 2 拒標**；交付成功即歸零全域 verify/tdd。展開見 `build-playbook.md` §六。
  3. **per-task commit+push 走 `git-tools` skill**，**commit scope SHALL 帶 canonical task id**（例 `feat(F-1186-W0-5): ...`）：smart commit 後即 `git push`（失敗只警告、不中斷 build）。
  4. **成功後補 `flow-state done <id> --commit <sha>`**（冪等記 sha 進 ledger）。
- **`flow-commit-gate` hook** 擋 commit scope 點名但還沒 `done` 的 task → exit 2，先跑 `flow-state done` 再 commit（**別手改 ledger/tasks.md 繞過**）；commit 成功前不領下個 task，失敗 → 整個 build 暫停告知。

## Step 6：推進下一波

重複 Step 1–5 到無波次。`needs-decision` 的 feature 跳過，`/flow-resume` 彈窗拍板後才納入。跨 feature 才能驗的整合 journey **記進 `X-*` / Backlog**（`Spotted:` footer），留給 `/flow-ship` 統一跑，不在 feature 結尾重複跑。

## Step 7：可恢復（狀態進 git，跨電腦也接得上）

狀態在 `.flow/` + git（殺不死）；中斷後 `/flow-resume` 重新 fan-out 未完成的，不重做已 delivered 的。
**git-track（現已自動）**：`.flow/.gitignore` 由 flow-toolkit 於 `init`/SessionStart 自動落檔，忽略瞬時衍生檔（`state.json`等）；`manifest.json`＋`ledger/`＋`redteam/`＋`verify/`＋`decisions/`＋`journal.ndjson`＋`lessons.ndjson` 照常進 git，`flow-state done` 交付時自動 `git add` 這些耐久證據＋`specs/tasks.md`。

## 完成判準（self-check）
- [ ] foundation 先序列、features 才同 repo 平行（conflictZone 算準）
- [ ] **`flow-state wave --compute` 綠**：拓樸/逐字 reqText 落 wave-plan.json，dispatch 用它的 `reqText`
- [ ] **整合前 `flow-state scope --wave` 綠**：無 worker 越界改共用檔；另對賬 wave-plan 成員/manifest 未漂移
- [ ] 執行策略沒在散文裡自決：偏離預設平行有先彈窗拍板＋寫進 manifest/journal
- [ ] 每 feature 紅軍先行、攻擊面已落檔 `.flow/redteam/<id>.json`、attackCoverage 對賬過、worker 走 TDD + 真實資料鏈路（無 mock 假綠）
- [ ] 每 feature 便宜 sensor 先跑/fail-fast（蒸餾後回主迴圈，不灌原始輸出）、貴迴圈有界；效能只跑便宜 smoke
- [ ] 每個完成的 task：清垃圾 → TaskUpdate completed → **`flow-state done <id>`** → per-task commit+push（scope 帶 canonical id）；被 `flow-commit-gate` 擋下＝跳過了 `flow-state done`
- [ ] BLOCKED / 安全 red flag 有暫停回報，沒靜默略過
- [ ] 跨 feature 項已記進 X-*/Backlog 留給 ship
