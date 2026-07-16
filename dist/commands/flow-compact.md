---
description: Flow 文件收束 — 把過大的 specs/狀態歸檔到 archive/（不刪、可回溯），壓 context 預算，先刪尾保 cache prefix，避免長期膨脹與脈絡腐化
---

# /flow-compact — 文件收束（防無限寫入 + 防腐化）

**何時跑（兩條觸發，任一命中即收）**：
1. **size（檔案大小，`flow-size-check` hook 在 SessionStart + 送訊息時自動提醒）**：任一 `specs/` 檔 > ~50KB（≈12K tokens）——小功能輕量路徑長期累積會膨脹，這條把它壓住（實證：大型專案 design/tasks 常衝到 100–270KB）。
2. **cycle**：`/flow-ship` 發 `COMPLETE` 後——把該迭代 delivered 細節歸檔，主檔只留「當前迭代 + 接縫契約 + 歷史一行索引」。
（staleness：已 shipped feature 細節與 code 對不上時，併入 cycle 收束處理。）

**目標**：把 working set 壓回視窗 ~40–50% 以下，但**不丟資訊**（歸檔可回溯）。

## 原則：先刪尾保 cache prefix

compaction **先壓縮/歸檔最新的尾巴與已完成段落**，保住開頭的系統/設定 prefix 穩定（cache hit 價 = miss 的 1/10）。**保留最近存取的熱檔**逐字不動。**禁止**先砍開頭的需求/設計骨幹。

## 做什麼

**委派門檻（C-44，非無條件 SHALL）**：**純機械搬移優先走確定性路徑**——journal 用 `flow-state journal-archive`（CLI，見下 3）、檔案搬移用 shell `mv`/`git mv`（別叫 LLM 逐字搬、避免幻覺漏內容）。**需要判斷的摘要壓縮**（把冗長段落收成一行、決定哪些章節可歸檔）才委派便宜 subagent，且**僅在收束量大時**（多檔 >50KB 或章節眾多）；小收束主迴圈直接做。主迴圈只確認結果與彈窗。

1. **已 delivered 的 task 詳情**：`tasks.md` 已 `[x]` 段的冗長子步驟 → 收成一行摘要，詳情移 `specs/archive/tasks-<date>.md`。
2. **過長 design/requirements**：已凍結、已實作的章節 → 摘要留主檔，全文移 `specs/archive/`。**接縫契約、未完成 REQ、open questions 一律留主檔**（還在用，不歸檔）；**requirements.md 主檔摘要 SHALL 保留全部 `REQ-E2E-*` id 行**——收束成零 REQ-E2E 的殼會被 `complete-check` exit 2 擋（完成謂詞不能被歸檔關閉）。
3. **state journal**：跑 `flow-state journal-archive`（確定性 CLI，已終局 task 事件搬 `.flow/archive/journal.ndjson`、未終局＋全域事件留主檔；`done` 交付時也會自動順手做）。
4. **驗證 artifact**：成功的測試報告可清（失敗的保留）。

## 鐵則

- **歸檔不刪除**：一律移到 `specs/archive/<date>/`，可回溯。**禁止**真刪 tracked 非可重生檔。
- **完成謂詞相關的不動**：tasks 的 `[ ]`/`[x]` 狀態、未達成的 REQ-E2E-*/REQ-PERF-* 是收束終點的判據，保持可讀。
- 收束後回報：壓了多少、歸檔到哪、context 預算降到約多少。

## 與收束終點的關係

compact 是「**過程中**」的 context 衛生；真正的「**做完了**」是 `/flow-ship` 的完成謂詞（task 全 `[x]` + 所有 `REQ-E2E-*` 綠 + 效能達標 → `COMPLETE`）。兩者別混：compact 不代表完成，只是讓長流程不腐化。
