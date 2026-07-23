---
description: Flow 一鍵總控 — 偵測起始 phase，選自駕（spec 定版後自動跑到出貨、只 T1 分歧停）或每階段停，依序跑 spec→plan→build→verify→ship
---

# /flow — 一鍵總控

把整套工作流串起來跑，**自動偵測起始 phase**（從 `.flow/state.json` + `specs/` 現況），從對的地方接續。**兩種推進模式**（起手選一次）：**自駕**（spec 定版後自動跑到出貨、只在 T1 必要分歧停）或**每階段停**（混合基座的人工閘門，舊預設）。

## Step 0：偵測起始 phase（檔案耐久狀態）

讀 `.flow/state.json` 的 `phase` 欄與磁碟現況決定從哪接：
- 無 `.flow/` 或無 `specs/requirements.md` → 從 **Phase 1 `/flow-spec`** 起。
- `phase="spec-done"`（有凍結 requirements，無 design/tasks）→ 從 **Phase 2 `/flow-plan`**。
- `phase="plan-done"`（有 design+tasks，尚有 task `[ ]`）→ 從 **Phase 3 `/flow-build`**。
- 所有 task `[x]` 但完成謂詞未達 → 從 **Phase 5 `/flow-ship`**。
- `phase="shipped"` → 回報已完成，問是否開新需求。

偵測結果**先用 `AskUserQuestion` 跟使用者確認**「我判斷從 Phase N 接續，對嗎？」再動。

## Step 0.4：選推進模式（起手一次性彈窗）

用 `AskUserQuestion` 問一次（之後不再每階段問）：

- **自駕到出貨**（`mode:"auto"`）：spec 仍互動定版，**凍結後 plan→build→verify→ship 自動接續、階段交界不暫停**，只在 **T1 必停集合**同步彈窗（見 `references/autonomous-mode.md`）。完成謂詞達標即 COMPLETE。
- **每階段停**（`mode:"manual"`，舊預設）：每個階段之間都暫停等你拍板。

拍板後跑 `flow-state mode <auto|manual>` 寫入推進模式——它寫進 **`.flow/manifest.json`（進 git，換機 clone 後自駕不掉回 manual）** ＋ state.json（相容既有讀取），讓 `/flow-resume` 知道用哪種模式續跑。

**自駕護欄前置檢查（SHALL，確定性閘門）**：寫 `mode:"auto"` 前 **SHALL 跑 `flow-state guardrail-check`**（mac/linux `node ~/.claude/skills/flow-toolkit/flow-state.mjs guardrail-check`；Windows PS `[Console]::OutputEncoding=[Text.Encoding]::UTF8; node "$env:USERPROFILE\.claude\skills\flow-toolkit\flow-state.mjs" guardrail-check`）。它驗 `settings.json` 含 `flow-stall-monitor`（斷路器在線）——**exit 2 即護欄缺失：提醒使用者重跑 `install`、本次退回「每階段停」，不假裝自駕**（無花費上限＋無斷路器＝可能整夜燒錢，Ask-first 等級風險）。

## Step 0.5：小功能輕量路徑（跳訪談、仍寫 SDD）

使用者明說「小調整 / 不用訪談」**或** `/flow` 判斷改動範圍小（單一既有 feature 的局部調整、**無新實體 / 無新角色 / 無新外部整合**）→ 走輕量分支，貫徹 SDD 但不重，共 7 個節點：

1. **精簡 SDD**：往 `specs/requirements.md` 的「當前迭代」段補一條精簡 `REQ-XXX`（EARS）+ 往 `specs/tasks.md` 補一個 `F-*` task。跳過 `/flow-spec` 蘇格拉底全套訪談、互動原型對焦、lens 審查矩陣（spec-redteam/spec-consistency）。
   - **design.md（C-29 澄清「沒 design.md 不寫 code」對輕量路徑的適用）**：輕量路徑是**既有 feature 的局部調整**，SHALL **沿用既有 `specs/design.md`**——不必為小改動另起完整設計；若既有 design.md 缺這塊接縫，補**一小節**（動到的接縫/契約）即可，不寫全套。真的無任何 design.md 可沿用（＝其實是新東西）就不算小改動、升回完整 `/flow-spec`。code-reviewer 會抓「實作與 design 漂移」補洞。
2. **`plan-check` 照跑**（便宜）：REQ↔task 覆蓋對賬不因輕量路徑而免。
3. **紅軍不 spawn 獨立 agent**：orchestrator 親列 3 個攻擊情境（邊界值/惡意輸入/相依故障擇要）落 `.flow/redteam/<id>.json`（CLI 本就允許非 agent 手動落檔）。
4. **TDD 紅→綠**：經 `flow-state run` 真跑，真實資料鏈路鐵則不減（禁 mock、真依賴未 ready 標 BLOCKED）。
5. **驗證走 `/flow-verify` 輕量路徑例外**：主迴圈親自真跑 runner／真點擊，免 spawn 獨立 Evaluator；其餘鐵則（真實資料鏈路、Web 三鐵則、效能門）照常適用。
6. **全 diff 自審一次**：沒有獨立 code-reviewer context，也要有這道眼過一遍變動。
7. **`flow-state done` → 一次 commit**：per-task commit 紀律不變，狀態落 `.flow/`。

無新 journey 的純小修 → `flow-state decision` 落 `e2e-waiver`（附理由），`complete-check` 認得（僅 0 條 `REQ-E2E-*` 時適用；有 ≥1 條時該 waiver 無效）。

**安全閘門（升回完整 `/flow-spec`）**：偵測到**需求級**變動——新實體 / 新角色 / auth / RBAC / payment / 個資 scope——**強制升回完整 `/flow-spec`**（自駕下這也是 T1 必停）。

## Step 1：依序跑各階段（推進方式依模式）

依偵測結果呼叫對應命令（`/flow-spec` → `/flow-plan` → `/flow-build` → `/flow-verify`（build 內含）→ `/flow-ship`）。

- **`mode:"manual"`**：每個階段的凍結/推進閘門 SHALL 用 `AskUserQuestion` 白話問，使用者明確說繼續才進下一階段。
- **`mode:"auto"`**：spec 互動定版（訪談/異常路徑自檢/UI 對焦照常，這是「談需求」、人本來就在）；**凍結走 `flow-state spec-ready --freeze`＝`### 開放問題` 清零才放行**，故自駕 spec→plan 不會帶「沒問乾淨」的需求衝出去（源頭防跑歪）。**凍結後階段交界不暫停、自動推進**。只有 **T1 必停集合**（需求骨架變動／裝新相依／破壞性 DB／安全紅旗／stall 升級／波次策略偏離平行）同步彈窗；其餘 spec 沒釘死的 C 類需求分歧 **AI 自決並 `flow-state decision <id>` 記審計線**，不打斷使用者。細節見 `references/autonomous-mode.md`。

## Step 2：SDD 檔案收束

`flow-size-check` hook 偵測 specs 任一檔 >50KB 自動提醒 → 主動建議或直接幫使用者跑 `/flow-compact` 把已交付細節歸檔（**自駕模式無人盯著，碰到提醒就主動收束**）。各階段把狀態寫進 `specs/` + `.flow/state.json`，**中斷後 `/flow-resume` 可無痛接手**（`mode:"auto"` 續跑自駕）。

## 紀律
- **manual**：不自己往下衝，每階段等使用者拍板。
- **auto**：自動推進，但每個自決 C 類分歧 SHALL `flow-state decision` 記審計線；碰 T1 必停集合就同步彈窗，不硬闖。
- 不跳過驗證：Phase 4 的綠燈是 Phase 3 task 完成的前提（兩模式皆然）。
- 完成謂詞達成（task 全 `[x]` + **所有 `REQ-E2E-*` 綠** + 效能達標；發 COMPLETE 前 SHALL 跑 `flow-state complete-check`）→ 發 `COMPLETE` 收束，不繼續打磨。
