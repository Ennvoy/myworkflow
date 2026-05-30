---
description: Flow Phase 1 — 訪談定版。蘇格拉底式一次一題彈窗澄清需求 → 凍結 requirements.md(EARS) → ui-ux-pro-max 產 HTML mockup 對齊 UI 方向 → 定版
---

# /flow-spec — Phase 1：需求訪談 + UI 定版

**目標**：把模糊的一句話需求，透過對話收斂成凍結的 `specs/requirements.md`，並（web 類）用實體 HTML mockup 把 UI 方向釘死。**這是整套流程最關鍵的閘門**——方向錯在這裡擋掉，比 deliver 到一半才發現便宜 10 倍。

> 對話優先（conversation-first）：別急著做東西。先把需求談清楚、寫成檔、凍結，之後每個迴圈都重讀這份凍結的 spec。

## Step 1：任務類型判定（決定後續切片與 UI 流程）

讀使用者那句需求，判定類型並記到 `.flow/state.json` 的 `projectType`：
- `web-saas` / `web-app` / `mobile`：走**垂直切片**（§ tasks），**且** Step 5 要做 UI mockup。
- `cli` / `api` / `data-pipeline` / `library` / `framework` / `desktop-gui`：走**水平拆解**（功能模組），**跳過** Step 5 UI mockup（`desktop-gui` 的原生視窗用 HTML/Tailwind mockup 不具代表性，故同列跳過）。
- 含「使用者/角色/權限/後台/admin」字樣 → Step 3 自動注入動態 RBAC 需求（禁 hardcode 角色；初始只 seed 一個 super admin）。

## Step 2：蘇格拉底訪談（一次一題彈窗，這是鐵則）

**SHALL 用 `AskUserQuestion` 彈窗，一次一題**，每題附 2–4 個 option，**推薦選項置首標「(建議)」**，每個 option 白話講「選了會怎樣／不選會怎樣」。**禁止**純文字「Q1 / Q2 / Q3 逐條回」。

能查 code / 查證的先自己查，不要把可自行判斷的事丟回使用者（grill-me 精神）。一輪最多 4 題，問完一輪看回答再決定下一輪。要挖到「決策樹每個分支都釐清」：
- 範圍邊界（in / out of scope）、主要 user 與其目標
- 每條主功能的 happy path 與**異常路徑**（空狀態、錯誤、權限不足、併發）
- 資料模型雛形（有哪些實體、關係、誰能看誰的資料 = scope）
- 非功能需求：**效能目標**（哪個畫面/操作要多快）、安全、相容
- 明確的**驗收條件**（怎樣算這條需求做完）

**蘇格拉底初輪收斂後，grill-me 深挖**：用 `AskUserQuestion` 問「要進 grill-me 對決策樹逐分支深挖，還是直接凍結？」（建議深挖）。選深挖 → 實際呼叫 `grill-me` skill（mattpocock/skills，安裝檔已裝整套）對需求/plan **連續質問到每個決策分支釐清**（一次一題、能查 code 先查、每題給推薦答案）。grill-me ＝「在主 context 跟使用者互動深挖」。

接著（可選但建議）對「你自己整理出的需求」呼叫獨立 `spec-reviewer` subagent（另開 context、**看不到主對話＝外部視角，與 grill-me 互補不重疊**），請它回一份 5–7 條質疑清單（邊界、衝突、隱含假設、缺失異常路徑），把質疑帶回再彈窗跟使用者對焦。

## Step 3：寫 `specs/requirements.md`（EARS，凍結用）

格式見 `references/ears-cheatsheet.md`。一律：
- **User Story**：作為 `<role>`，我想要 `<action>`，以便 `<benefit>`。
- **EARS 驗收條件**：`REQ-001：當 <trigger> 時，系統應 <response>`（API 名/欄位/狀態碼保留英文）。
- **`REQ-E2E-*`**：可 demo 的端到端 user journey（Phase 4/5 的驗證來源）。
- **`REQ-PERF-*`**：效能 budget（例：`REQ-PERF-001：dashboard 首屏 LCP < 2.5s（p95）`）——**這是 Phase 5 的硬閘門，沒寫等於放棄效能驗收**。
- RBAC 命中 → 注入 `REQ-RBAC-001..007`（動態角色/權限存 DB、super admin short-circuit）。
- 一個 concern 一段，清楚可逐條對應。結尾留 `### 開放問題` 收尚未拍板的。

## Step 4：高風險獨立審查（命中才做）

requirements 含 auth / 權限 / payment / 個資 / 合規 / audit 關鍵字 → 建議跑獨立模型對抗審查（若裝了 Codex companion）。不命中靜默跳過。

## Step 5：UI 方向對齊（**僅 web 類**，鐵則）

1. 呼叫 `ui-ux-pro-max:ui-ux-pro-max` skill 取設計建議（style / palette / font pairing / product-type 規範）。未裝 → 提示使用者跑安裝檔的 ui-ux-pro-max 安裝指令（見 README），不提供 fallback。
2. 依 `REQ-E2E-*` / 主功能列 **3–5 個關鍵畫面**，產靜態 HTML mockup 到 `specs/ui-mockups/`（Tailwind CDN + 設計 token；含一頁 `index.html` 總覽）。**含中文寫檔一律 UTF-8**（PowerShell 加 `-Encoding utf8`）。
3. **主動開瀏覽器**把總覽頁送到使用者眼前（mac `open <url>` / Windows `Start-Process <url>` / Linux `xdg-open <url>`；0 摩擦，避免被滑過）。
4. `AskUserQuestion` 收方向：方向 OK / 某幾頁要改 / 整個方向錯。**一次對焦完即凍結**，後續 plan/build 以此為錨點反推 API/DB。

> 例外：`cli`/`api`/純後端跳過整個 Step 5；使用者明說「跳過 mockup」可豁免，但 SHALL 寫進 `### 開放問題` 並警告「整體方向風險押到 build 才暴露」。

## Step 6：凍結閘門

`AskUserQuestion` 白話問：「需求已凍結成 `specs/requirements.md`＋UI 方向已定，是否進 `/flow-plan` 設計？」——使用者明確說繼續才推進（流程鐵則：每階段須使用者拍板）。寫 `.flow/state.json`：`phase="spec-done"`。

## 完成判準（self-check）
- [ ] 訪談全程用彈窗、一次一題、有推薦答案
- [ ] `specs/requirements.md` 存在，含 REQ-XXX + REQ-E2E-* + REQ-PERF-*
- [ ] web 類：`specs/ui-mockups/` 有 3–5 頁 + 已開瀏覽器 + 已彈窗定版
- [ ] 凍結閘門已問、state.json 已更新
