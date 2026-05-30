---
description: Flow 一鍵總控 — 偵測起始 phase 並從該處接續，依序跑 spec→plan→build→verify→ship，每階段暫停等使用者拍板
---

# /flow — 一鍵總控

把整套工作流串起來跑，**自動偵測起始 phase**（從 `.flow/state.json` + `specs/` 現況），從對的地方接續，**每階段之間暫停等你拍板**（混合基座的人工閘門）。

## Step 0：偵測起始 phase（檔案耐久狀態）

讀 `.flow/state.json` 的 `phase` 欄與磁碟現況決定從哪接：
- 無 `.flow/` 或無 `specs/requirements.md` → 從 **Phase 1 `/flow-spec`** 起。
- `phase="spec-done"`（有凍結 requirements，無 design/tasks）→ 從 **Phase 2 `/flow-plan`**。
- `phase="plan-done"`（有 design+tasks，尚有 task `[ ]`）→ 從 **Phase 3 `/flow-build`**。
- 所有 task `[x]` 但完成謂詞未達 → 從 **Phase 5 `/flow-ship`**。
- `phase="shipped"` → 回報已完成，問是否開新需求。

偵測結果**先用 `AskUserQuestion` 跟使用者確認**「我判斷從 Phase N 接續，對嗎？」再動。

## Step 0.5：小功能輕量路徑（跳訪談、仍寫 SDD）

使用者明說「小調整 / 不用訪談」**或** `/flow` 判斷改動範圍小（單一既有 feature 的局部調整、**無新實體 / 無新角色 / 無新外部整合**）→ 走輕量分支，貫徹 SDD 但不重：
- **跳過**：`/flow-spec` 蘇格拉底全套訪談、UI mockup 對焦、spec-reviewer。
- **仍 SHALL 寫 SDD**：往 `specs/requirements.md` 的「當前迭代」段補一條精簡 `REQ-XXX`（EARS）+ 往 `specs/tasks.md` 補一個 `F-*` task。
- **照走 build 紀律**：紅軍（針對小範圍）→ TDD 三相 → 真實資料鏈路驗證 → per-task commit → 狀態落 `.flow/`。
- **安全閘門（升回完整 `/flow-spec`）**：偵測到**需求級**變動——新實體 / 新角色 / auth / RBAC / payment / 個資 scope——**強制升回完整 `/flow-spec`**。

## Step 1：依序跑各階段，閘門暫停

依偵測結果呼叫對應命令（`/flow-spec` → `/flow-plan` → `/flow-build` → `/flow-verify`（build 內含）→ `/flow-ship`）。**每個階段的凍結/推進閘門 SHALL 用 `AskUserQuestion` 白話問**，使用者明確說繼續才進下一階段（流程鐵則）。

## Step 2：context 預算自我監控

長流程中留意 context 利用率，碰 ~70% → 主動建議 `/flow-compact` 收束再繼續（防腐化）。各階段把狀態寫進 `specs/` + `.flow/state.json`，**中斷後 `/flow-resume` 可無痛接手**。

## 紀律
- 不自己往下衝：每階段等使用者拍板。
- 不跳過驗證：Phase 4 的綠燈是 Phase 3 task 完成的前提。
- 完成謂詞達成（task 全 `[x]` + e2e 綠 + 效能達標）→ 發 `COMPLETE` 收束，不繼續打磨。
