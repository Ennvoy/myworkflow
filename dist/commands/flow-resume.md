---
description: Flow 換手/接手 — 純從檔案狀態（.flow/state.json + specs/ + git）重建現況，呈現進度與待決策，有決策用彈窗請使用者拍板後接續
---

# /flow-resume — 從檔案狀態接手

**核心**：Flow 的狀態全在**檔案**（`.flow/`、`specs/`、git），不在對話 context（harness 鐵則：狀態外部化、agent 可拋棄可恢復）。所以換 session / 換電腦 / 中斷後，純讀檔就能無痛接手，不靠上一輪記憶。

## Step 1：純讀檔重建現況（statelib reconstruct）

用 statelib 冷啟動 reconstruct 印現況 + 下一步（**只讀 `.flow/`，不讀對話**）：
```bash
# mac/linux
node ~/.claude/skills/flow-toolkit/flow-state.mjs resume
```
```powershell
# Windows PowerShell（先設 console UTF-8）
[Console]::OutputEncoding=[Text.Encoding]::UTF8; node "$env:USERPROFILE\.claude\skills\flow-toolkit\flow-state.mjs" resume
```
輸出含：已交付/開發中/驗收中/待開發/⚠️等你決策 計數、待決策清單、**↻ 未完成動作（dangling：journal 有 `actionStart` 但無 `actionDone`，並行多 worker 各自獨立不互蓋）**、**⚠️ 已知死路（lessons：再生計畫別重走的失敗 approach）**、下一步。
補充來源：`specs/`（讀 `[ ]`/`[x]`）、`git`（branch、最後 commit）。
**換電腦也接得上**：`.flow/` 的 manifest/ledger/journal 進 git，clone 下來 reconstruct 一樣重建（細粒度進度不掉到 task 級）。進度跑 `flow-state status`；平行波看 `/workflows`。

## Step 1.5：模式感知續跑（自駕斷線重連別退回每階段問）

`flow-state resume` 輸出已**確定性印出「推進模式」**（讀 `.flow/state.json.mode`，不靠記憶）：
- **🤖 自駕（`mode:"auto"`）**：續跑自駕——**不每階段問**，從 `下一步` 的斷點自動推進 `plan→build→verify→ship`，只在 **T1 必停集合**（見 `references/autonomous-mode.md`）同步彈窗。掃 `.flow/decisions/` 把自駕期間的自決摘要列給使用者掃一眼（可事後翻、要改再說）。發 COMPLETE 前 SHALL 跑 `flow-state complete-check`。
- **🙋 每階段停（`mode:"manual"` 或無 mode 欄，向後相容）**：維持下方 Step 4 人工閘門行為。

## Step 2：呈現進度

白話摘要：在哪個 phase、哪些 feature delivered / building / blocked / needs-decision、還剩哪些 task、有沒有上次中斷的 dangling（生成完但 verify/commit 沒收尾）。

## Step 3：補 dangling（冪等）

上次中斷留下的半成品：`verify` 空但 code 已寫 → 補跑 `/flow-verify` → `flow-state done` → commit；`actionStart` 有但 `actionDone` 無 → 重做該 action（冪等，不重做已 delivered 的）。

## Step 4：待決策彈窗

有 `needs-decision` 的 feature → `AskUserQuestion` 白話列出待拍板項，使用者拍板後納入下一波，接 `/flow-build` 或 `/flow`。

## 紀律
- 只讀檔重建，**不腦補**沒寫進檔案的進度。
- 不重做已 `delivered` 的 task（看 state + commit 核對）。
- 接手後狀態維持「未完成」直到真的跑到完成謂詞。
