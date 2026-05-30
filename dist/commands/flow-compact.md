---
description: Flow 文件收束 — 把過大的 specs/狀態歸檔到 archive/（不刪、可回溯），壓 context 預算，先刪尾保 cache prefix，避免長期膨脹與脈絡腐化
---

# /flow-compact — 文件收束（防無限寫入 + 防腐化）

**何時跑（三條觸發，任一命中即收）**：
1. **context**：利用率碰 ~60%（過程中防腐化）。
2. **size**：任一 `specs/` 檔 > ~50KB（≈12K tokens）——小功能輕量路徑長期累積會膨脹，這條把它壓住（實證：大型專案 design/tasks 常衝到 100–255KB，光一檔吃掉 1/3 視窗）。
3. **cycle**：`/flow-ship` 發 `COMPLETE` 後——把該迭代 delivered 細節歸檔，主檔只留「當前迭代 + 接縫契約 + 歷史一行索引」。
（staleness：已 shipped feature 細節與 code 對不上時，併入 cycle 收束處理。）

**目標**：把 working set 壓回視窗 ~40–50% 以下，但**不丟資訊**（歸檔可回溯）。

## 原則：先刪尾保 cache prefix

compaction **先壓縮/歸檔最新的尾巴與已完成段落**，保住開頭的系統/設定 prefix 穩定（cache hit 價 = miss 的 1/10）。**保留最近存取的熱檔**逐字不動。**禁止**先砍開頭的需求/設計骨幹。

## 做什麼

1. **已 delivered 的 task 詳情**：`tasks.md` 已 `[x]` 段的冗長子步驟 → 收成一行摘要，詳情移 `specs/archive/tasks-<date>.md`。
2. **過長 design/requirements**：已凍結、已實作的章節 → 摘要留主檔，全文移 `specs/archive/`。**接縫契約、未完成 REQ、open questions 一律留主檔**（還在用，不歸檔）。
3. **state journal**：`.flow/` 的已完成 action 紀錄 → 歸檔，保留當前 phase 與未完成 dangling。
4. **驗證 artifact**：成功的測試報告可清（失敗的保留）。

## 鐵則

- **歸檔不刪除**：一律移到 `specs/archive/<date>/`，可回溯。**禁止**真刪 tracked 非可重生檔。
- **完成謂詞相關的不動**：tasks 的 `[ ]`/`[x]` 狀態、未達成的 REQ-E2E-*/REQ-PERF-* 是收束終點的判據，保持可讀。
- 收束後回報：壓了多少、歸檔到哪、context 預算降到約多少。

## 與收束終點的關係

compact 是「**過程中**」的 context 衛生；真正的「**做完了**」是 `/flow-ship` 的完成謂詞（task 全 `[x]` + e2e 綠 + 效能達標 → `COMPLETE`）。兩者別混：compact 不代表完成，只是讓長流程不腐化。
