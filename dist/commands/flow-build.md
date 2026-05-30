---
description: Flow Phase 3 — 多工交付（混合基座）。取當前波次互不依賴的 features，用 Workflow 腳本 fan-out worktree 隔離的平行 worker，紅軍先行→TDD→真實鏈路自檢→merge→per-task commit，推進下一波
---

# /flow-build — Phase 3：多工並行交付

**目標**：把 `tasks.md` 的 features **真的並行**做掉，每個 task 從 UI 一路做到 DB、可 demo、可 commit、可放生。

**混合基座（已定）**：**波次內** fan-out 用 Workflow 腳本（背景跑、結構化回傳、可重播）；**階段/波次之間**保留互動式人工閘門，你拍板才推進。**前提**：當前專案是 git repo（worktree 需要）；不是 → 先 `git init`。

## Step 0：冷啟動讀現況 + 開監控看板

`node "$env:USERPROFILE\.claude\skills\flow-toolkit\flow-state.mjs" resume` 用 statelib **reconstruct** 純從磁碟重建「還剩什麼 + 未完成 dangling」（不靠對話記憶），有 dangling（上次中斷）先冪等補完；補 `specs/tasks.md` 的 `[ ]`/`[x]`。
**進 build 即冪等自動開看板**：`node ...\flow-state.mjs monitor`（已在跑就重用、不疊新分頁），讀印出的 port 用 `Start-Process` 開瀏覽器（0 摩擦）。

## Step 1：算當前波次可並行集合

可並行 = `state` 可推進 ∧ `blockedBy` 已 delivered ∧ `conflictZone` **互不重疊**。
- **foundation/共用檔先序列**：全域 router / 共享型別 / DB schema / auth（`P-*`）**SHALL 先做完並 merge 進 trunk**，features 才 fan-out——否則大家改同一個檔 = merge 地獄。
- **釘契約**：跨 worker 的接縫用 design.md 釘好的單一 type/schema，各 worker import 同一份。
- **波次寬度合理控制**：多工 ~15x token，只把「真互不依賴＋夠份量」的放進同一波。簡單/相依的別硬塞平行。

## Step 2：紅軍先行（平行、唯讀、零隔離）

對本波每個 feature **平行**跑 `red-team` subagent（獨立 context、唯讀 → 可直接並行），各列 3–5 個攻擊面並標 severity（邊界值、併發、惡意輸入、相依故障、配置漂移）。結果餵進對應 worker。任一 high severity → 建議跑 codex 獨立對抗審查補強（裝了才問）。

## Step 3：fan-out 平行 worker（Workflow 腳本 + worktree 隔離）

用 `references/recipes/parallel-build.js`（Workflow 腳本）spawn worker，**每 feature 一個 worker**（`agent(..., {isolation:'worktree'})`），prompt 帶：
- task 描述 + 對應 REQ + design.md 釘的契約
- **紅軍攻擊面 → 先寫失敗安全測試、再用防禦碼轉綠**
- **TDD 三相**（見 `references/verification-playbook.md` §TDD）：Red 實跑出真 assertion failure → Green 最小實作轉綠 → Refactor
- **Tier-1 自檢**：production build + unit + API + headless smoke。**真實資料鏈路鐵則**：API/資料驗證 SHALL 打真後端真 DB、**禁 mock 假綠**、測試資料 seed 進真 DB；真依賴未 ready（上游 5xx/未實作）→ 標 **BLOCKED**，不准 mock fallback 假裝綠
- **小盒子工具**：每 worker 只給它任務需要的工具，不給全集
- **涉 UI 的 feature**：orchestrator 先呼叫 `ui-ux-pro-max` 取 component 級建議（structure / ARIA·keyboard·focus / hover·active·disabled / responsive / animation + shadcn 範例），沿用 spec 階段定的 palette/font/style 當 query context，附進 worker prompt；寫 Green 相時 accessibility 清單逐項實作
- 要求**結構化回傳** `{branch, commits, tier1, blockers, driveBy}`

每 spawn 前先 write-ahead：node 呼叫 `statelib.actionStart(root, id, 'building')`（寫 **append-only journal**，N 個並行 worker 各記各的、**不互蓋**）+ `transition(root, id, 'pending', 'building')`。確定性節點不靠模型判斷。

## Step 4：收斂 merge（序列）

worker 回來 → 依拓樸序把 branch merge 回 trunk、解衝突。**安全/資料正確性 red flag（SQL injection、auth bypass、密碼明文、destructive query 缺 WHERE）一律暫停**告知使用者（順手修紀律）。merge 後過時 worktree 移除。

## Step 5：feature 自身驗證 + per-task commit

整個 feature 全層寫完 → 在 merged trunk 上跑**該 feature 的 happy path**（呼叫 `/flow-verify` 的窄範圍模式：Playwright headed + 真實資料鏈路 + 效能 budget）。**綠了才 commit**。
- 完成一項：先 TaskUpdate completed → 再 `tasks.md` `[ ]`→`[x]`（**不跨段移動**）→ **per-task smart commit**（scope 帶 task ID，例 `feat(F-005): ...`）。commit 移交 git-tools 風格智慧提交。
- 狀態落 `.flow/`（殺不死）：worker 綠 + merge → node 呼叫 `statelib.transition(root, id, 'building', 'delivered', { commit:<sha> })` + `actionDone(root, id, 'building')`；同步 `writeStateJson`（task/phase/verify/commit）給既有 `flow-verify-gate`/`flow-session-start` hook 讀。
- commit 成功前不領下個 task；commit 失敗（hook/衝突）→ 整個 build 暫停告知。
- `flow-verify-gate` hook 會在 `verify` 空/`none` 時擋下 TaskUpdate completed——**別沒真跑就填 `verify=ok`（系統性違規）**。

## Step 6：推進下一波

重複 Step 1–5 到無波次。`needs-decision` 的 feature 跳過、看板亮旗、`/flow-resume` 彈窗拍板後才納入。跨 feature 才能驗的整合 journey **記進 `X-*` / Backlog**（`Spotted:` footer），留給 `/flow-ship` 統一跑，**不在 feature 結尾重複跑**。

## Step 7：可恢復（狀態進 git，跨電腦也接得上）

狀態在 `.flow/` + 各 branch（殺不死）；中斷後 `/flow-resume` 重新 fan-out 未完成的，不重做已 delivered 的。
**git-track 鐵則**：`.flow/manifest.json` + `.flow/ledger/` + `.flow/journal.ndjson` SHALL 進 git（換電腦 clone 即 reconstruct 重建細粒度進度）；`.flow/state.json`、`.flow/monitor.port`、`.flow/*.log` 進 `.gitignore`（可衍生 / 一次性，勿污染 repo）。

## 完成判準（self-check）
- [ ] foundation 先序列 merge、features 才平行（conflictZone 算準）
- [ ] 每 feature 紅軍先行、worker 走 TDD + 真實資料鏈路（無 mock 假綠）
- [ ] 每個完成的 task：TaskUpdate + tasks.md [x] + per-task commit 都做了
- [ ] BLOCKED / 安全 red flag 有暫停回報，沒靜默略過
- [ ] 跨 feature 項已記進 X-*/Backlog 留給 ship
