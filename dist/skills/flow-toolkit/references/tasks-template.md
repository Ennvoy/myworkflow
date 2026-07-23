# tasks.md 三層分組範本（/flow-plan 用）

**核心定義：一個 task = 一個能向使用者 demo 一次的 user story**，含完成它所需的所有層（UI + API + DB + tests + e2e）。每完成一個 task 都能用上新功能，不會出現「做完三個 task 還是看不到任何完整功能」的半成品狀態。

## 範本

```markdown
# Tasks — <專案名>

> 進度雙軌：本檔人讀（[ ]/[x]）+ `.flow/manifest.json` 機讀同步（完成走 `flow-state done`，一步翻 [x]＋寫 ledger）。**不跨段移動**：task 從 pending 到 done 就在原段把 [ ] 改 [x]。

## Prelude（P-*，跨 feature 基礎建設，0–3 個）
判準：「砍掉它任一 feature 都做不下去」才放，能 inline 進第一個用到的 feature 就 inline。

- [ ] P-1 全域 DB schema + migration foundation
      blockedBy: —  | conflictZone: db/schema, migrations/
- [ ] P-2 Auth foundation（session / 中介層 / super admin seed）
      blockedBy: P-1 | conflictZone: auth/, middleware/
- [ ] P-3 UI foundation（routing + layout + Tailwind config + theme + 共用 component shell）
      blockedBy: —  | conflictZone: app/layout, ui/theme

## Features（F-*，每個 = 一條 user story = 全層）
判準：「能向使用者 demo 一次」「對應一條完整 REQ 或 REQ-E2E-*」。

- [ ] F-1 訪客註冊登入（對應 REQ-E2E-001）
      blockedBy: P-1,P-2,P-3 | conflictZone: features/auth-ui, api/auth | mockupPages: pages/register.html, pages/login.html
- [ ] F-2 建立/列出 item（對應 REQ-E2E-002）
      blockedBy: P-1,P-3 | conflictZone: features/items, api/items | mockupPages: pages/items.html, pages/item-new.html
- [ ] F-3 item 搜尋/分頁（對應 REQ-E2E-003、REQ-PERF-002）
      blockedBy: F-2 | conflictZone: features/items, api/items | mockupPages: pages/items.html

## Cross-cutting（X-*，ship 前必清）
判準：「跨 feature 才能做」「不屬任一 user story」。/flow-ship Step 4 強制檢查未清不放行。

- [ ] X-1 跨 feature 效能 budget 整體驗收（REQ-PERF-*）
- [ ] X-2 auth/role 橫切矩陣整合 e2e

## Backlog（本輪不做）
順手修延後（§ 順手修）、驗證/部署延後、migration 未部署。
- [ ] （deliver 過程動態發現的記這裡，footer 帶 Spotted:）
```

## 依賴分波（給多工用）

每個 task 標欄位，`/flow-build` 的 `wave --compute` 據此算可並行波次（判準與拓樸細節見 `build-playbook.md` §一，單一事實來源）：
- **`blockedBy`**：依賴哪些 task 先完成。
- **`conflictZone`**：這個 task 會改哪些檔/模組。共用檔（schema/router/theme）的 conflictZone 會跟很多 feature 重疊 → 自然被排到前面序列做（避免 merge 地獄）。
- **`mockupPages`**（僅 web 類、有互動原型時）：這個 task 承接哪些定版原型頁（相對 `specs/ui-mockups/` 的 `pages/*.html`）。`wave --compute` 把它帶進 worker prompt（worker 對著定版畫面做、不用猜）；`plan-check` 機檢：宣告的頁要實存、每個原型頁要被某 task 承接（漏承接＝畫面會漏做）。同一頁可被多個 task 承接（如共用列表頁）。

**分波範例**：
- Wave 0（序列）：P-1 → P-2、P-3（foundation 先做完 merge 進 trunk）
- Wave 1（並行）：F-1、F-2（conflictZone 不重疊，可同時 fan-out）
- Wave 2：F-3（blockedBy F-2）

## 寬幅重構：expand–contract

**定義**：單一機械式改動、但 blast radius 橫跨全庫（如改一個共用型別名、換一個全域介面簽章）——這種不硬塞進某個 `F-*` 的垂直切片，改走三段式：

- **expand**：新增新形式，新舊並存、不壞任何既有呼叫端（一個獨立 task，先做，`blockedBy` 無）。
- **migrate**：逐一呼叫端搬去新形式，按目錄/模組分批，各自成一個 task、`blockedBy: expand`、依各自觸及目錄分 `conflictZone`（可並行）。
- **contract**：確認所有呼叫端都搬完後，刪掉舊形式（一個獨立 task，`blockedBy` 全部 migrate task）。

判準：改動夠機械（不需要每處都做決策）但涉及檔案面太廣、硬拆進某個 feature 會讓 conflictZone 互撞——才用這個模式；一般垂直切片能覆蓋的功能開發不套用。

## task size

以「**能向使用者 demo 一次的 user story**」衡量，不用時間衡量。size 自然會大（數小時甚至更長）；task 內部可包多個 commit，但維持 **per-task 一輪驗收 + 一個 feature 完成 commit**。

## 雙軌拆解

- **垂直切片**（預設）：web-saas / web-app / 多人系統 / 一般 app — Features = user story。
- **水平拆解 fallback**：framework / installer / CLI / 資料管線 / 純後端 — 沒有 user-demoable feature，Features 段語意改成「**功能模組**」（能獨立驗收的模組，不必 user-facing），三層分組不變。
