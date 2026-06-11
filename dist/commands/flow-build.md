---
description: Flow Phase 3 — 多工交付（混合基座）。取當前波次互不依賴的 features，用 Workflow 腳本在同 repo fan-out 平行生成 worker，紅軍先行→TDD→序列整合（build/驗證/commit 一個個）→per-task commit，推進下一波
---

# /flow-build — Phase 3：多工並行交付

**目標**：把 `tasks.md` 的 features **真的並行**做掉，每個 task 從 UI 一路做到 DB、可 demo、可 commit、可放生。

**混合基座（已定）**：**波次內** fan-out 用 Workflow 腳本（背景跑、結構化回傳、可重播）；**階段/波次之間**保留互動式人工閘門，你拍板才推進。**同 repo 模型**：worker 在同一個工作目錄平行**生成**（只寫各自不重疊的檔），build/驗證/commit 由主流程**序列**做。**前提**：當前專案是 git repo（per-task commit 需要）；不是 → 先 `git init`。

## Step 0：冷啟動讀現況

跑 flow-toolkit 的 `flow-state.mjs resume`（路徑/shell 依 flow.md 環境慣例——mac/linux `node ~/.claude/skills/flow-toolkit/flow-state.mjs resume`、Windows PS `node "$env:USERPROFILE\.claude\skills\flow-toolkit\flow-state.mjs" resume`）用 statelib **reconstruct** 純從磁碟重建「還剩什麼 + 未完成 dangling」（不靠對話記憶），有 dangling（上次中斷）先冪等補完；補 `specs/tasks.md` 的 `[ ]`/`[x]`。
**進度怎麼看**：跑 `flow-state status`（in-chat 文字進度）；平行生成那段看 Workflow 的 `/workflows`（每 worker 即時進度/token/狀態）。

## Step 1：算當前波次可並行集合

可並行 = `state` 可推進 ∧ `blockedBy` 已 delivered ∧ `conflictZone` **互不重疊**。
- **foundation/共用檔先序列**：全域 router / 共享型別 / DB schema / auth（`P-*`）**SHALL 先做完並 merge 進 trunk**，features 才 fan-out——否則大家改同一個檔 = merge 地獄。
- **釘契約**：跨 worker 的接縫用 design.md 釘好的單一 type/schema，各 worker import 同一份。
- **波次寬度合理控制**：多工 ~15x token，只把「真互不依賴＋夠份量」的放進同一波。簡單/相依的別硬塞平行。
- **fan-out 前就緒探針（fail-fast，研究 LocalContextMiddleware）**：先確認環境就緒——依專案 package manager 跑一次 deps install/ci（mac/linux 如 `npm ci`）。lockfile drift / 裝不起來 / 缺工具 → **停下回報**，別讓整波 worker 在壞環境上空轉一輪才一起失敗（這一輪重跑成本 = 整波 ~15x token）。

## Step 1.5：執行策略閘門（偏離預設平行 SHALL 彈窗，別在散文裡自己降級）

**預設路徑 = 本波可並行集合逐 feature fan-out 平行生成（Step 3）**。要偏離這個預設——把**已算出的並行波降級成序列**、或只**部分平行**（常見理由：features 簡單/相似/複用同一元件、不夠份量、想省 ~15x token）——**SHALL 先 `AskUserQuestion` 彈窗讓使用者拍板**，白話列：可並行集合是哪些、你建議的策略＋理由、trade-off（省 token/一致性 ↔ 速度）。
- 照預設全 fan-out 平行 → **不必問**，直接進 Step 2/3。
- **禁止在 thinking/散文裡自行把並行波降級成序列**——那是 `Ask first` 等級的 trade-off（見 flow.md 三層邊界），不是 orchestrator 可單方拍板的事。
- 拍板後把選定策略＋一句 rationale 寫進 `.flow/state.json`（如 `wave[n].strategy` / `strategyReason`），讓 `/flow-resume` 與審查看得到「這波為何這樣跑」，不靠對話記憶。

## Step 2：紅軍先行（單一執行點＝fan-out recipe 的 Stage 1）

紅軍由 `parallel-build.js` **Stage 1** 對本波每個 feature 平行執行（`red-team` agentType、獨立 context、唯讀），攻擊面（含編號 id）直接餵進同 pipeline 的 worker——**不在主迴圈另跑一輪紅軍**（雙重執行＝token 雙燒，且 markdown 報告會佔 orchestrator context）。Workflow 回來後 orchestrator SHALL：
- **紅軍落檔**：把每個 feature 回傳的 `redTeam`＋`attackCoverage` 寫進 `.flow/redteam/<id>.json`（格式 `{ "attacks": <redTeam>, "coverage": <attackCoverage> }`；機讀，`/flow-ship` 的 code-reviewer **必讀輸入**，不靠對話記憶傳遞）。沒落檔會被 Step 4 的 `flow-state redteam` 閘門 exit 2 擋整合。
- 任一 high severity → 建議跑 codex 獨立對抗審查補強（裝了才問）。

## Step 3：fan-out 平行生成 worker（Workflow 腳本，同 repo）

用 `references/recipes/parallel-build.js` spawn worker，**每 feature 一個**，在同一個工作目錄平行生成。prompt 帶：
- task 描述 + 對應 REQ + design.md 釘的契約 + 該 feature 的 conflictZone（worker 只准碰這些檔）
- **紅軍攻擊面 → 先寫失敗安全測試、再用防禦碼轉綠**
- **TDD 三相**（見 `references/verification-playbook.md` §TDD）：Red 寫自己的測試檔、單跑出真 assertion failure → Green 最小實作 → Refactor
- **真實資料鏈路鐵則**：涉 API/資料 SHALL 打真後端真 DB、**禁 mock 假綠**、測試資料 seed 進真 DB；真依賴未 ready（上游 5xx/未實作）→ 標 **BLOCKED**，不准 mock fallback
- **檔案邊界（鐵則）**：worker 只新增/改自己 conflictZone 內的檔；不碰共用檔（全域 router／共享型別／`package.json`／lockfile／DB migration／中央 config，那些走序列 foundation）；只單跑自己的單元測試檔，不跑整包 build／tsc／dev server／`git commit`
- **涉 UI 的 feature**：orchestrator 先呼叫 `ui-ux-pro-max` 取 component 級建議（structure / ARIA·keyboard·focus / hover·active·disabled / responsive / animation + shadcn 範例），沿用 spec 階段定的 palette/font/style 當 query context，附進 worker prompt；寫 Green 相時 accessibility 清單逐項實作
- **小盒子工具**：每 worker 只給它任務需要的工具，不給全集
- **成本路由（Reasoning Sandwich）**：平行苦工 worker 走較便宜 model（recipe 的 `args.workerModel`，預設 Sonnet、可覆寫、不 hardcode 行為）——省 token＝同預算能 fan-out 更寬的波；紅軍／Evaluator 是高價值對抗審查，**維持高階不降級**
- 要求**結構化回傳** `{feature, files, selfCheck{unitGreen,realData}, blockers, driveBy}`

fan-out 前 orchestrator 先 write-ahead：對本波每個 id 呼叫 `statelib.transition(root, id, 'pending', 'building')`，讓 `flow-state status` 反映這波在生成中。

## Step 4：序列整合（逐 feature，主流程序列做）

Workflow 回來後，orchestrator 依拓樸序**一個一個**收尾每個 feature：
- **檔案安全閘門（確定性，整合前 SHALL 先跑、不靠模型自律）**：跑 `flow-state scope --wave <本波 ids>`（mac/linux `node ~/.claude/skills/flow-toolkit/flow-state.mjs scope --wave F-1,F-2`、Windows PS 對應路徑）。它用 **git 真實變動**比對各 feature 宣告的 `conflictZone`——任一檔落在**所有** conflictZone 之外（worker 越界改了共用檔/foundation）→ **exit 2 暫停**，查清是哪個 worker 越界、該檔該不該走序列 foundation，**別硬整合**（這是同 repo 平行的檔案安全底線，模型偽造不了 git diff）。`overlap` 警告＝規劃時 conflictZone 沒切乾淨（同波兩 feature 改同檔有覆寫風險）→ 回 plan 修。
- **紅軍對賬閘門（確定性，與 scope 同點 SHALL 跑）**：跑 `flow-state redteam --wave <本波 ids>`（路徑同 scope）。它讀 `.flow/redteam/<id>.json`——缺檔、任一 **high** 攻擊無 `covered` 對應項、或其 `testFile` 實際不存在（檔案存在性 script 親驗，worker 自報偽造不了）→ **exit 2 暫停**該波整合，補失敗安全測試轉綠／補落檔後重跑。
- 掃每個結果的 `driveBy`：**安全/資料正確性 red flag（SQL injection、auth bypass、密碼明文、destructive query 缺 WHERE）一律暫停**告知使用者（順手修紀律）。
- 有 `blockers` 的標 BLOCKED／needs-decision，跳過。
- 其餘一次一個進 Step 5（驗證 → 清垃圾 → done → commit）。

## Step 5：feature 自身驗證 → per-task commit（序列，一次一個；驗證與 commit 解耦）

接 Step 4 逐 feature。**便宜 sensor 先跑、一錯馬上停（fail-fast）**：先跑秒級的 type-check / lint / 單元測試擋掉笨錯誤，**過了才**燒分鐘級的行為驗證（呼叫 `/flow-verify` 窄範圍：Playwright headed + 真實資料鏈路）——別在貴的 headed e2e 上為一個 typo 燒一輪。**貴迴圈有界**：headed e2e 失敗 → 1 次自動修 + 1 次重跑仍紅 → 暫停問你（連 3 輪未過 / 同錯連 2 輪無效 = check-in，狀態維持未完成，不放生半成品）。
- **效能：每 feature 只跑便宜 smoke**（少量請求抓粗暴退化、fail-fast 早擋）；**嚴謹 p50/p95（代表性資料量、N+1/index/分頁）留到 `/flow-ship` 的完整效能閘門量一次**——避免「最貴又不可平行的嚴謹量測」在每 feature ×N 重燒，且 ship 完成謂詞本來就硬擋效能、不漏接。
- **驗證與 commit 解耦**：驗證 PASS 才進 commit；某 feature FAIL/BLOCKED **不擋其他已 PASS feature 的 commit**（路由乾淨）。**綠了才 commit**。
- **commit 前清驗證垃圾（雙軌、確定性閘門，呼叫 git-tools 之前 SHALL 做）**：
  - ① **檔案型產物**（確定性）→ 跑 flow-toolkit 的 clean script（mac/linux `node ~/.claude/skills/flow-toolkit/clean-verify-artifacts.mjs --apply --gitignore`、Windows PS `node "$env:USERPROFILE\.claude\skills\flow-toolkit\clean-verify-artifacts.mjs" --apply --gitignore`）：白名單整刪 **Playwright MCP `.playwright-mcp/`（console-*.log／page-*.yml／截圖）**、Playwright `test-results/`/report、coverage、`*.log`、`.last-run.json`、一次性 debug 截圖/tmp，並補 `.gitignore`。**白名單式、不碰 source 測試檔／specs／.flow ledger／baseline**（省 `--apply` 為 dry-run 預覽）。**沒清就 commit 會被 `flow-commit-gate` 閘門一 exit 2 擋**。
  - ② **語意型殘留**（靠 review）→ 看本次 `git diff`，刪掉遷在 source 的一次性 debug code（`console.log`/`print`/暫時註解掉的塊／臨時驗證腳本）。clean script 不碰 source，這軌靠 review。
  - 清完才 commit，避免驗證垃圾污染交付 diff（對齊 Karpathy『極簡清理』；範圍/紀律見 `references/verification-playbook.md` §七）。
- 完成一項（順序鐵則：**先標、再 commit**，閘門會強制）：
  1. TaskUpdate completed（`flow-verify-gate` hook 會在 `verify` 空/`none` 時擋下——**別沒真跑就填 `verify=ok`**）。
  2. **跑 `flow-state done <id>`**（一個指令做完原本三件會被漏的事：翻 `tasks.md` 的 `[x]` + 寫 ledger `delivered` + 帶 commit）：mac/linux `node ~/.claude/skills/flow-toolkit/flow-state.mjs done <id>`、Windows PS `node "$env:USERPROFILE\.claude\skills\flow-toolkit\flow-state.mjs" done <id>`。`<id>` 用 canonical task id（tasks.md/manifest 那個，例 `F-1186-W0-5`）。**done 自帶確定性閘門**：`.flow/state.json` 的 `verify`/`tdd` 空/`none` → exit 2 拒標（先真跑 `/flow-verify` 寫入綠燈）；**交付成功即把全域 verify/tdd 歸零**——下一個 task 必須有自己的新綠燈，借不到上一個的。
  3. **per-task commit+push 走 `git-tools` skill**，**commit scope SHALL 帶 canonical task id**（例 `feat(F-1186-W0-5): ...`，別用 `v1.x/W0-5` 這種對不上 manifest 的裝飾 id）：smart commit 後即 `git push`（trunk 已有 upstream → 直接推；**push 失敗只警告、不中斷 build**）。
- **`flow-commit-gate` hook（PreToolUse/Bash）會擋**：commit scope 點名某 task 但它還沒 `done` → exit 2，先跑 `flow-state done` 再 commit。**別手改 ledger/tasks.md 繞過閘門**。
- commit 成功前不領下個 task；commit 失敗（hook/衝突）→ 整個 build 暫停告知。

## Step 6：推進下一波

重複 Step 1–5 到無波次。`needs-decision` 的 feature 跳過，`/flow-resume` 彈窗拍板後才納入。跨 feature 才能驗的整合 journey **記進 `X-*` / Backlog**（`Spotted:` footer），留給 `/flow-ship` 統一跑，**不在 feature 結尾重複跑**。

## Step 7：可恢復（狀態進 git，跨電腦也接得上）

狀態在 `.flow/` + git（殺不死）；中斷後 `/flow-resume` 重新 fan-out 未完成的，不重做已 delivered 的。
**git-track 鐵則**：`.flow/manifest.json` + `.flow/ledger/` + `.flow/journal.ndjson` + `.flow/redteam/` SHALL 進 git（換電腦 clone 即 reconstruct 重建細粒度進度；ship 審查讀得到紅軍清單）；`.flow/state.json`、`.flow/*.log` 進 `.gitignore`（可衍生 / 一次性，勿污染 repo）。

## 完成判準（self-check）
- [ ] foundation 先序列、features 才同 repo 平行（conflictZone 算準）
- [ ] **整合前跑 `flow-state scope --wave` 綠**：無 worker 越界改共用檔/foundation（被 exit 2 擋下＝有人越界，查清再整合，別繞）
- [ ] 執行策略沒在散文裡自決：偏離預設平行（降級序列/部分平行）有先彈窗拍板＋寫進 `.flow/state.json`
- [ ] 每 feature 紅軍先行（recipe Stage 1 單一執行點）、攻擊面已落檔 `.flow/redteam/<id>.json`、attackCoverage 對賬過（high 全 covered＋testFile 實存）、worker 走 TDD + 真實資料鏈路（無 mock 假綠）
- [ ] 每 feature 便宜 sensor 先跑/fail-fast、貴迴圈有界；效能只跑便宜 smoke（嚴謹 p50/p95 留 ship 量一次）
- [ ] 每個完成的 task：commit 前清驗證垃圾（clean script `--apply` + review 掉 source 內 debug 殘留）→ TaskUpdate completed → **`flow-state done <id>`**（翻 tasks.md [x] + ledger）→ per-task commit+push（scope 帶 canonical id，走 git-tools skill）。被 `flow-commit-gate` 擋下＝你跳過了 `flow-state done`，補跑即可
- [ ] BLOCKED / 安全 red flag 有暫停回報，沒靜默略過
- [ ] 跨 feature 項已記進 X-*/Backlog 留給 ship
