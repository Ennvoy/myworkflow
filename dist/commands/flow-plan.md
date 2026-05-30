---
description: Flow Phase 2 — 設計。讀凍結的 requirements 產出 architecture.md（架構＋路徑地圖）與 design.md（技術決策＋接縫契約），再拆 tasks.md（垂直切片＋依賴分波）
---

# /flow-plan — Phase 2：架構設計 + 任務分波

**目標**：把凍結的需求轉成「可並行交付的施工藍圖」。**計畫是可丟棄、可從 requirements 再生的**——別把它當聖物無止盡打磨，夠用就凍結進 build。

**前提**：`specs/requirements.md` 存在且已凍結。沒有 → 退回 `/flow-spec`（流程鐵則：沒需求不設計）。

## Step 1：讀凍結 specs，建立全景

完整讀 `specs/requirements.md`（+ web 類讀 `specs/ui-mockups/`）。**不要**把整個既有 codebase 預先塞進 context——用 Grep/Glob/Read 隨用隨查（just-in-time，省 context 防腐化）。

## Step 1.5：高變動領域查證（命中才做）

requirements 含 LLM / 雲端 / 支付 / 行動 / 前端框架關鍵字 → **WebSearch 查證**當前最佳實踐/版本，附**時間戳**寫進 design.md Decision Log（這些領域過時很快，憑記憶會錯）。

## Step 2：`specs/architecture.md`

- **架構全景**：分層、主要模組、資料流向（一張清楚的文字/mermaid 圖）。
- **路徑地圖**：每個主功能 → 會碰到哪些檔案/模組（讓 build 階段定位精準）。
- **技術選型**：語言/框架/DB/部署目標，每個選擇一句話理由。**model 當可抽換參數**，不 hardcode model-specific 行為。

## Step 2.5：UI 對焦結論（**僅 web 類**）

若 `specs/ui-mockups/` 存在，design.md SHALL 含一節「UI 對焦結論」：畫面清單、元件分解、互動流程、設計 token（color/font/spacing）。**後續技術方案以此為錨點反推 API / DB schema**（UI 先行，不是 schema 先行）。

## Step 3：`specs/design.md`（技術決策 + 接縫契約）

- **關鍵技術決策**：每個決策寫「選什麼／為什麼／不這樣會怎樣」（白話一段）。
- **接縫契約釘一處（鐵則）**：跨層/跨模組的介面（API ↔ UI、模組間）用 **type/schema 定義在單一檔**（zod / pydantic / TS type / Protobuf），兩邊 import 同一份。**編譯期**就擋掉「API 回的形狀 ≠ UI 期望」。這是並行交付不發散的關鍵。
- **Decision Log**：含時間戳的決策紀錄（含 Step 1.5 查證結果）。
- **資料模型 + scope 規則**：誰能讀寫誰的資料（餵 Phase 4 的 scope 驗證）。

## Step 4：`specs/tasks.md`（垂直切片 + 依賴分波）

**核心定義：一個 task = 一個能向使用者 demo 一次的 user story**，含完成它所需的所有層（UI + API + DB + tests + e2e）。三層分組（範本見 `references/tasks-template.md`）：

- **Prelude（`P-*`，0–3 個）**：跨 feature 共用且不屬任一 story 的基礎建設（全域 DB schema、auth foundation、UI foundation routing/layout/theme、deploy skeleton）。判準：「砍掉它任一 feature 都做不下去」才放，能 inline 就 inline。
- **Features（`F-*`，主體）**：每個 = 一條 user story = 全層。判準：「能 demo 一次」「對應一條完整 REQ 或 REQ-E2E-*」。
- **Cross-cutting（`X-*`，ship 前必清）**：等多個 feature 完才能做的跨 feature refactor / 效能優化。`/flow-ship` 強制檢查未清不放行。
- **Backlog**：本輪不做的（順手修延後、驗證/部署延後）。

**依賴分波（給多工用）**：標每個 task 的 `blockedBy`（依賴哪些 task）與 `conflictZone`（會改哪些檔/模組）。`/flow-build` 據此算「同一波可並行 = 依賴已完成 ∧ conflictZone 互不重疊」。共用檔/foundation 的 conflictZone 會跟很多 feature 重疊 → 自然被排到前面序列做。

水平拆解類（cli/api/framework）：Features 段語意改成「功能模組」（能獨立驗收的模組，不必 user-facing），其餘不變。

## Step 5：凍結閘門

`AskUserQuestion` 白話問：「設計＋任務分波完成，是否進 `/flow-build` 開始多工交付？」使用者拍板才推進。寫 `.flow/state.json`：`phase="plan-done"`，並把 tasks 寫入機讀版（TaskCreate）與人讀版 `tasks.md` 雙軌同步。

## 完成判準（self-check）
- [ ] architecture.md + design.md + tasks.md 三檔齊全
- [ ] 接縫契約釘在單一 type/schema 檔
- [ ] tasks 有 P-*/F-*/X-* 分組 + 每個 task 標了 blockedBy / conflictZone
- [ ] REQ-PERF-* 有對應到能驗的 task
- [ ] 凍結閘門已問、state.json + TaskCreate 已更新
