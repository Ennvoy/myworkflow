---
description: Flow Phase 2 — 設計。讀凍結的 requirements 產出 architecture.md（架構＋路徑地圖）與 design.md（技術決策＋接縫契約），再拆 tasks.md（垂直切片＋依賴分波）
---

# /flow-plan — Phase 2：架構設計 + 任務分波

**目標**：把凍結的需求轉成「可並行交付的施工藍圖」。**計畫是可丟棄、可從 requirements 再生的**——別把它當聖物無止盡打磨，夠用就凍結進 build。

**前提**：`specs/requirements.md` 存在且已凍結。沒有 → 退回 `/flow-spec`（流程鐵則：沒需求不設計）。

## Step 1：讀凍結 specs，建立全景

完整讀 `specs/requirements.md`（+ web 類讀 `specs/ui-mockups/` 互動原型：走查台 index.html＋各頁結構）。**不要**把整個既有 codebase 預先塞進 context——用 Grep/Glob/Read 隨用隨查（just-in-time，省 context 防腐化）。**盤點既有 codebase 找接縫/既有模式/可重用點時 SHALL 走 `references/recipes/research-sweep.js` fan-out**（便宜模型平行讀、蒸餾成 1-2k 摘要回傳）——orchestrator 只拿摘要做架構決策，主迴圈**不得**親自 grep/read 整個 repo 做大範圍掃描；對關鍵接縫檔（確定要動的少數檔）仍保留直讀權。

**先取已知死路**（防再生撞同一面牆）：跑 `flow-state resume` 看 `.flow/lessons.ndjson` 的「⚠️ 已知死路」。**計畫可丟棄、但失敗教訓不該丟**——再生時別重選上次失敗過的 approach（`reconstruct` 已自動帶出、delivered task 的死路會自動失效）。

## Step 1.5：高變動領域查證（命中才做）

requirements 含 LLM / 雲端 / 支付 / 行動 / 前端框架關鍵字 → **WebSearch 查證**當前最佳實踐/版本，附**時間戳**寫進 design.md Decision Log（這些領域過時很快，憑記憶會錯）。

## Step 2：`specs/architecture.md`

- **架構全景**：分層、主要模組、資料流向（一張清楚的文字/mermaid 圖）。
- **路徑地圖**：每個主功能 → 會碰到哪些檔案/模組（讓 build 階段定位精準）。
- **技術選型**：語言/框架/DB/部署目標，每個選擇一句話理由。**model 當可抽換參數**，不 hardcode model-specific 行為。

## Step 2.5：UI 對焦結論（**僅 web 類**）

若 `specs/ui-mockups/` 存在，design.md SHALL 含一節「UI 對焦結論」：**畫面清單（逐頁列 `pages/*.html` 檔名——plan-check 機檢每頁都被提及）**、元件分解、**互動狀態機（hover/active/disabled/loading——原型已做出來的狀態，逐一承接、別只寫「互動流程」四個字）**、**異常態（空狀態/載入中/錯誤/權限不足——原型狀態切換器展示過的畫面，build 要照做）**、設計 token（color/font/spacing）、選用的品牌設計系統基底 slug（`flow-state design-base` 落檔的那個，build 沿用其 `tokens.css`）。**後續技術方案以此為錨點反推 API / DB schema**（UI 先行，不是 schema 先行）。互動原型是定版合約：**build 沿用原型的 markup/tokens/版面，把 `app.js` 假資料層換成真 API**（原型 CRUD 動過的資料形狀直接餵 schema 設計）；但原型檔不直接搬進 src/ 當完成——照走 TDD＋真實資料鏈路驗證。

## Step 3：`specs/design.md`（技術決策 + 接縫契約）

- **關鍵技術決策**：每個決策寫「選什麼／為什麼／不這樣會怎樣」（白話一段）。
- **接縫契約釘一處（鐵則）**：跨層/跨模組的介面（API ↔ UI、模組間）用 **type/schema 定義在單一檔**（zod / pydantic / TS type / Protobuf），兩邊 import 同一份。**編譯期**就擋掉「API 回的形狀 ≠ UI 期望」。這是並行交付不發散的關鍵。
  - **C-33 跨語言專案（Python 後端＋TS 前端等，兩端無法 import 同一實體檔）**：改用 **codegen 從單一權威來源生兩端定義**——OpenAPI/JSON Schema/Protobuf `.proto` 當唯一真相，跑產生器輸出各語言型別（如 openapi→zod/pydantic、protobuf→ts+py）。「釘一處」精神不變（真相仍在單一 schema 檔），只是兩端拿的是**生成物**而非同一檔；design.md 記明「權威 schema 檔＋各端生成路徑」，並把「schema 改了要重跑 codegen」列進接縫維護紀律。
- **Decision Log**：含時間戳的決策紀錄（含 Step 1.5 查證結果）。
- **資料模型 + scope 規則**：誰能讀寫誰的資料（餵 Phase 4 的 scope 驗證）。

## Step 4：`specs/tasks.md`（垂直切片 + 依賴分波）

**核心定義：一個 task = 一個能向使用者 demo 一次的 user story**，含完成它所需的所有層（UI + API + DB + tests + e2e）。三層分組（範本見 `references/tasks-template.md`）：

- **Prelude（`P-*`，0–3 個）**：跨 feature 共用且不屬任一 story 的基礎建設（全域 DB schema、auth foundation、UI foundation routing/layout/theme、deploy skeleton）。判準：「砍掉它任一 feature 都做不下去」才放，能 inline 就 inline。
- **Features（`F-*`，主體）**：每個 = 一條 user story = 全層。判準：「能 demo 一次」「對應一條完整 REQ 或 REQ-E2E-*」。
- **Cross-cutting（`X-*`，ship 前必清）**：等多個 feature 完才能做的跨 feature refactor / 效能優化。`/flow-ship` 強制檢查未清不放行。
- **Backlog**：本輪不做的（順手修延後、驗證/部署延後）。

**依賴分波（給多工用）**：標每個 task 的 `blockedBy`（依賴哪些 task）與 `conflictZone`（會改哪些檔/模組）。`/flow-build` 據此算「同一波可並行 = 依賴已完成 ∧ conflictZone 互不重疊」。共用檔/foundation 的 conflictZone 會跟很多 feature 重疊 → 自然被排到前面序列做。

**mockupPages（僅 web 類、有互動原型時，SHALL）**：每個涉 UI 的 F-task 加 `mockupPages:` 欄位，機讀宣告它承接哪些定版原型頁（相對 `specs/ui-mockups/`，如 `pages/login.html`）——`wave --compute` 把對應頁帶進 worker prompt（worker 對著定版畫面實作、不是憑 REQ id 想像），`plan-check` 機檢「宣告的頁實存＋每個原型頁被某 task 承接」。範本見 `references/tasks-template.md`。

水平拆解類（cli/api/framework/desktop-gui）：Features 段語意改成「功能模組」（能獨立驗收的模組，不必 user-facing），其餘不變。

## Step 4.5：並行度自檢（拆 conflictZone + 消 blockedBy）

**並行度的天花板在這一步決定，不在 build**——build 只是執行這裡算出的波次。標完 blockedBy/conflictZone 後回頭做兩個檢查，把「假性序列」轉成真並行：

- **拆 conflictZone（消重疊）**：若某中央檔（router 路由表、單檔 `db/schema`、共用 component 匯總檔）被多個 feature 的 conflictZone 同時點到 → 它正卡死這些 feature 同波並行。評估能否把擴充點從「大家都改中央檔」改成「各 feature 加自己的檔」（file-based routing、每 feature 一個 migration、register/plugin 模式），讓 conflictZone 不再重疊。
- **消 blockedBy（斬依賴）**：若 `F-b blockedBy F-a` 只是因為「F-b 要 import F-a 定義的型別/介面」（不是真要等 F-a 的執行結果）→ 把那個介面抽進 Step 3 的接縫契約、排進 Wave 0 先序列釘死，F-a/F-b 即可解耦、同波並行。

**護欄（別過度拆，對齊 Karpathy Simplicity First）**：只拆「本來就該屬於各 feature、彼此獨立」的東西；天生該集中統一看的（全域 middleware 順序、設計 token、共用型別契約、全域 config）留在 Prelude 序列做、不拆。界線一句話 = 「**這東西需不需要被統一看著**」。需另加「自動聚合」機制（框架掃描/runner）才能拆的，要評估膠水成本與「忘了註冊」風險。專案小、並行需求低時，結論可以是「不用拆」——那就別拆，在 design.md 記一句理由即可。

## Step 5：計畫對賬閘門 + 凍結

先把 tasks 寫入機讀版（TaskCreate / `.flow/manifest.json`）與人讀版 `tasks.md` 雙軌同步，然後 SHALL 跑計畫出口對賬（**唯一正門**，取代裸寫 `phase=plan-done`）：

```
flow-state plan-check
```

它機檢（全數確定性、模型偽造不了）——**C-15 誠實邊界：只驗「REQ id 有沒有被承接」的字面覆蓋，不驗 task 描述的實質品質/深度**（實質由 lens 審查、紅軍、TDD、藍軍那幾層人工智慧把關；別把 plan-check 綠當成「需求真的被完整實作」的保證）：① **REQ↔task 覆蓋**——凍結 index（`.flow/trace/req-index.json`）的每條 REQ id 都要在 tasks.md 出現（被某 task 承接），tasks.md 引用的 REQ id 都要實存於 index（防幻覺）；② **tasks.md↔manifest 逐欄一致**——task 集合／`blockedBy`／`conflictZone`／`mockupPages` 不一致就 exit 2（堵「manifest 比 tasks.md 寬＝scope/wave 閘門被靜默調鬆」）；③ requirements.md hash 對賬凍結分母（凍結後偷改在這裡就被抓）；④ **mockup 鏈路（`specs/ui-mockups/` 存在時）**——原型與定版快照（`mockup-index.json`）hash 對賬（凍結後偷改原型即擋）＋design.md「UI 對焦結論」節存在且逐頁提及每個 `pages/*.html`＋每個原型頁被某 task 的 `mockupPages` 承接（宣告的頁要實存）。通過才落 `.flow/trace/plan-check.json`（記 manifest hash，complete-check 對賬）＋寫 `phase="plan-done"`。它也順手印一張 **REQ↔design 對照表**給你在凍結彈窗掃一眼（design 語意矛盾機器驗不了、留人工）。

- **機讀版每個 task SHALL 帶 `blockedBy` + `conflictZone`**：`/flow-build` 據此算波次，且 `flow-state scope --wave` 會讀 `manifest.json` 的 `conflictZone` 擋 worker 越界。**tasks.md 與 manifest 對不上、或有 REQ 沒被任何 task 承接，plan-check 直接 exit 2**——把「計畫完整承接需求」從散文升級成硬閘門。
- 別手改 state.json 裸寫 `phase=plan-done` 繞過——`flow-spec-gate` hook 會 exit 2 擋（與 spec-done 同構）。

`AskUserQuestion` 白話問：「設計＋任務分波完成、plan-check 綠，是否進 `/flow-build`？」使用者拍板才推進。

## 完成判準（self-check）
- [ ] architecture.md + design.md + tasks.md 三檔齊全
- [ ] 接縫契約釘在單一 type/schema 檔
- [ ] tasks 有 P-*/F-*/X-* 分組 + 每個 task 標了 blockedBy / conflictZone
- [ ] 已做並行度自檢（Step 4.5）：中央檔 conflictZone 重疊評估過可否拆、型別型 blockedBy 評估過可否靠提早釘契約消解（過度拆有護欄）
- [ ] REQ-PERF-* 有對應到能驗的 task
- [ ] **`flow-state plan-check` 綠**（REQ↔task 全覆蓋＋tasks.md↔manifest 一致）、state.json + TaskCreate 已更新
