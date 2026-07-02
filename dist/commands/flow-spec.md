---
description: Flow Phase 1 — 訪談定版。蘇格拉底式一次一題彈窗澄清需求 → 凍結 requirements.md(EARS) → 產零依賴互動原型（全 journey 可點走查）對齊 UI 方向 → 定版
---

# /flow-spec — Phase 1：需求訪談 + UI 定版

**目標**：把模糊的一句話需求，透過對話收斂成凍結的 `specs/requirements.md`，並（web 類）用**可互動、像成品的原型**把 UI 方向釘死——使用者照走查台把每條 journey 真點一遍、感受開發完的樣子，不是看幾頁靜態圖靠想像。**這是整套流程最關鍵的閘門**——方向錯在這裡擋掉，比 deliver 到一半才發現便宜 10 倍。

> 對話優先（conversation-first）：別急著做東西。先把需求談清楚、寫成檔、凍結，之後每個迴圈都重讀這份凍結的 spec。

## Step 1：任務類型判定（決定後續切片與 UI 流程）

讀使用者那句需求先自行判定類型，**併入首輪訪談彈窗跟使用者確認**（AI 建議置首、不另開新停點），拍板後 SHALL 跑 `flow-state project-type <type>` 落檔（寫 manifest＋state.json）——**`spec-ready --freeze` 會對賬這筆記錄：缺檔凍不了；web 類無互動原型且無豁免檔也凍不了**（「不建目錄＝靜默跳過原型」已封死）：
- `web-saas` / `web-app` / `mobile`：走**垂直切片**（§ tasks），**且** Step 5 要做互動原型。
- `cli` / `api` / `data-pipeline` / `library` / `framework` / `desktop-gui`：走**水平拆解**（功能模組），**跳過** Step 5 互動原型（`desktop-gui` 的原生視窗用 HTML/Tailwind 原型不具代表性，故同列跳過）。
- 含「使用者/角色/權限/後台/admin」字樣 → Step 3 自動注入動態 RBAC 需求（禁 hardcode 角色；初始只 seed 一個 super admin）。

## Step 2：蘇格拉底訪談（一次一題彈窗，這是鐵則）

**SHALL 用 `AskUserQuestion` 彈窗，一次一題**，每題附 2–4 個 option，**推薦選項置首標「(建議)」**，每個 option 白話講「選了會怎樣／不選會怎樣」。**禁止**純文字「Q1 / Q2 / Q3 逐條回」。

能查 code / 查證的先自己查，不要把可自行判斷的事丟回使用者（grill-me 精神）。一輪最多 4 題，問完一輪看回答再決定下一輪。要挖到「決策樹每個分支都釐清」：
- 範圍邊界（in / out of scope）、主要 user 與其目標
- 每條主功能的 happy path 與**異常路徑**（空狀態、錯誤、權限不足、併發）
- 資料模型雛形（有哪些實體、關係、誰能看誰的資料 = scope）
- 非功能需求：**效能目標**（哪個畫面/操作要多快）、安全、相容
- 明確的**驗收條件**（怎樣算這條需求做完）

**異常路徑自檢閘門（SHALL，初輪收斂後、grill-me 前跑一次）**：對每條主功能，SHALL 用 `AskUserQuestion` 逐項確認這 **6 類異常**都已釐清處置——**空狀態 / 輸入錯（格式·型別·超長）/ 權限不足 / 併發衝突 / 相依故障（上游 5xx·timeout）/ 網路斷**（interview-guide：「異常路徑是最常漏的」）。任一未覆蓋 → 補問一輪，釘成 EARS `Unwanted` 條（`若 <異常>，系統應 <處置>`）。**這直接餵自駕**：自駕途中 AI 要猜的 C 類需求分歧，多半就是這裡沒問乾淨的異常處置——**spec 釘得越死，自駕（T1 放手）途中要猜的越少、放手越安全**。

**蘇格拉底初輪收斂後，grill-me 深挖閘門（SHALL，不可跳）**：初輪訪談一收斂，**就 SHALL 用 `AskUserQuestion` 跳一題**「要進 grill-me 對決策樹逐分支深挖，還是直接凍結？」（選項①深挖（建議）②直接凍結）。**這一問是鐵則、漏問＝流程缺陷**（別自行假設使用者要直接凍結就略過）。選深挖 → 實際呼叫 `grill-me` skill（mattpocock/skills，安裝檔已裝整套）對需求 **連續質問到每個決策分支釐清**（一次一題、能查 code 先查、每題給推薦答案）。grill-me ＝「在主 context 跟使用者互動深挖」。

接著（可選但建議）對「你自己整理出的需求」呼叫獨立 `spec-reviewer` subagent（另開 context、**看不到主對話＝外部視角，與 grill-me 互補不重疊**），請它回一份 5–7 條質疑清單（邊界、衝突、隱含假設、缺失異常路徑），把質疑帶回再彈窗跟使用者對焦。

## Step 3：寫 `specs/requirements.md`（EARS，凍結用）

格式見 `references/ears-cheatsheet.md`。一律：
- **User Story**：作為 `<role>`，我想要 `<action>`，以便 `<benefit>`。
- **EARS 驗收條件**：`REQ-001：當 <trigger> 時，系統應 <response>`（API 名/欄位/狀態碼保留英文）。
- **`REQ-E2E-*`**：可 demo 的端到端 user journey（Phase 4/5 的驗證來源）。**SHALL 從入口寫到目標**（例：`登入 → 首頁 → 點 X 卡片 → 進 Y 頁 → 操作 Z → 斷言結果`），不是只描述目標頁——驗證要從真實起點走完整導航（禁直接 goto 目標頁，見 `playwright-real-data-template.md` 第五鐵則）。**`spec-ready` 機檢結構**：單行箭頭鏈 ≥3 段、或欄位式「入口：/步驟：（≥2 步）/斷言：」，範本見 `references/ears-cheatsheet.md`。
- **`REQ-PERF-*`**：效能 budget（例：`REQ-PERF-001：dashboard 首屏 LCP < 2.5s（p95）`）——**這是 Phase 5 的硬閘門，沒寫等於放棄效能驗收**。真無效能敏感路徑寫 `REQ-PERF-001：N/A`，但 SHALL 先彈窗請使用者拍板並 `flow-state decision perf-waiver --choice "REQ-PERF N/A" --why "<拍板原因>"` 留檔（`spec-ready` 對賬豁免檔，一句 N/A 洗不掉效能驗收）。
- RBAC 命中 → 注入 `REQ-RBAC-001..007`（動態角色/權限存 DB、super admin short-circuit）。
- 一個 concern 一段，清楚可逐條對應。`### 開放問題` 收訪談途中還沒拍板的——但**凍結前 SHALL 全部清零**（見 Step 4.5）：每一項要嘛解決成 REQ/EARS、要嘛移到 `### 延後決策` 段並 `flow-state decision` 記錄（附 AI 建議預設），**不留懸空項給自駕猜**。真的零開放問題就寫「無」。

## Step 4：高風險獨立審查（命中才做）

requirements 含 auth / 權限 / payment / 個資 / 合規 / audit 關鍵字 → 建議跑獨立模型對抗審查（若裝了 Codex companion）。不命中靜默跳過。

## Step 4.5：需求收斂閘門（鐵則，產互動原型前先過）

訪談是**收斂迴圈**，不是問一輪就算：grill-me + spec-reviewer 反覆問，把每個決策分支問到拍板、`### 開放問題` 一項項清掉，直到**某一輪問不出新問題**才算收斂。收斂後 SHALL 跑確定性閘門：

```
flow-state spec-ready
```

它機檢 `specs/requirements.md`：`### 開放問題` **段缺失**或沒清零、缺 `REQ-`/`REQ-E2E-`/`REQ-PERF-` 任一、有 placeholder（TODO/TBD/待定/???）、REQ-E2E 缺 journey 結構、REQ-PERF 標 N/A 但無 perf-waiver 豁免檔 → **exit 2**，把未收斂項列回來繼續問（含糊詞/缺規範動詞僅警告不擋，帶回訪談補問）。**綠了才往下做 Step 5 互動原型**。這直接堵自駕跑歪——**spec 沒問乾淨就凍結，自駕途中 AI 只能猜（C 類分歧），猜歪了沒人擋**。真無法當場拍板的，移到 `### 延後決策` 段並 `flow-state decision` 記錄（附 AI 建議預設），**不留懸空項在 `### 開放問題`**。

> 為什麼這裡要硬閘門：訪談「問完了沒」本是模型自評的散文判斷，會被滑過。把「開放問題清零」做成 exit 2 的 `spec-ready`，模型才真的乖乖問到底（憲法確定性閘門原則）。

## Step 5：UI 方向對齊——互動原型（**僅 web 類**，鐵則）

mockup ≠ 幾頁靜態圖靠想像。產的是**零依賴互動原型**：可點導航走完每條 journey、表單可填有驗證回饋、假資料 CRUD 有真實感、可切空/錯誤/權限不足狀態——使用者「感受到開發完的樣子」再定版。詳細規格見 `references/prototype-guide.md`。

0. **選品牌設計系統基底（先做，lazy 載入）**：讀 `references/design-systems/index.md`（150 套大廠設計語言的分類索引，僅清單、約幾 KB），用 `AskUserQuestion` 讓使用者選一套當基底——依 `projectType`/需求推薦 3–4 個置首（工具/SaaS 類推 `shadcn`/`linear-app`/`vercel`、金流推 `stripe`、AI 產品推 `claude`/`openai`），**選項含「不用基底，純 ui-ux-pro-max」**。選定後**只讀選中那套**的 `references/design-systems/<slug>/DESIGN.md`（9 段規範）+ `tokens.css`（CSS 變數），**不全載**（context 零負擔）。設計系統為美學靈感、**非官方品牌資產**（見 `design-systems/NOTICE.md`）。
1. 呼叫 `ui-ux-pro-max:ui-ux-pro-max` skill 取設計建議（style / palette / font pairing / product-type 規範）——**有選基底時：以基底 `DESIGN.md`/`tokens.css` 的色彩·排版·間距為準，ui-ux-pro-max 補強元件級互動/狀態/a11y 與 shadcn 範例**。未裝 → 提示使用者跑安裝檔的 ui-ux-pro-max 安裝指令（見 README），不提供 fallback。
2. 依 `prototype-guide.md` 產互動原型到 `specs/ui-mockups/`：**全旅程覆蓋**（所有 `REQ-E2E-*` 途經畫面每頁都做、頁頁互連可點到終點）＋共用假資料層 `app.js`（localStorage、CRUD 有後果、可重置）＋每頁狀態切換器（空/載入/錯誤/權限不足）＋`index.html` **journey 走查台**（每條 REQ-E2E 一張卡：id＋步驟＋入口連結）。Tailwind CDN、零依賴、`file://` 直接開；**有基底時把該套 `tokens.css` 的 `:root` 變數 verbatim inline、不臆造**。**含中文寫檔一律 UTF-8**（PowerShell 加 `-Encoding utf8`）。
3. **SHALL 跑 `flow-state mockup-check`（確定性閘門）**：走查台缺任一 REQ-E2E 卡、零本地入口連結、本地連結 404、或連到的頁面是空殼（無 app.js／互動元素、引用的 script 缺檔）→ exit 2 補齊再來——堵「只產兩頁就請使用者定版」與「有卡但頁面空殼」的偷工（`spec-ready --freeze` 會再驗一次）。
4. **主動開瀏覽器**把走查台送到使用者眼前（mac `open <url>` / Windows `Start-Process <url>` / Linux `xdg-open <url>`；0 摩擦，避免被滑過）。
5. `AskUserQuestion` 收方向：「照走查台把 journey 點完了嗎？方向 OK / 某幾頁要改 / 整個方向錯」。**改到使用者點頭才凍結**，後續 plan/build 以原型為錨點反推 API/DB（build 沿用其 markup/tokens、把假資料層換真 API）。**凍結時記錄選用的品牌基底 slug**（寫進 requirements 或 `.flow/state.json`，plan/build 沿用其 tokens）。

> 例外：`cli`/`api`/純後端跳過整個 Step 5（Step 1 落檔的非 web enum 本身即豁免記錄）；**web 類**使用者明說「跳過 mockup」才可豁免，SHALL `flow-state decision mockup-waiver --choice "跳過互動原型" --why "<使用者原話>"` 留檔（**不是寫進 `### 開放問題`**——那會被 spec-ready 閘門擋住凍結），並警告「整體方向風險押到 build 才暴露」。`--freeze` 機檢：web 類無 `specs/ui-mockups/` 且無 mockup-waiver 檔 → exit 2（「不建目錄＝靜默豁免」已封死）。

## Step 6：凍結閘門

`AskUserQuestion` 白話問：「需求已凍結成 `specs/requirements.md`＋UI 方向已定，是否進 `/flow-plan` 設計？」——使用者明確說繼續才推進（流程鐵則：每階段須使用者拍板）。拍板後 SHALL 走凍結的**唯一正門**：

```
flow-state spec-ready --freeze
```

它先再驗一次收斂（開放問題清零＋REQ 齊；`specs/ui-mockups/` 存在時一併驗走查台覆蓋），通過才寫 `.flow/state.json`：`phase="spec-done"`＋落 journal `spec.frozen`。**別手改 state.json 裸寫 `phase=spec-done` 繞過**——`flow-spec-gate` hook 會 exit 2 擋裸寫轉移（自駕下模型竄改不了）。

## 完成判準（self-check）
- [ ] 訪談全程用彈窗、一次一題、有推薦答案
- [ ] projectType 已彈窗拍板並 `flow-state project-type` 落檔（`--freeze` 會對賬）
- [ ] **grill-me 深挖閘門已彈窗問過**（深挖／直接凍結二選一）——漏問即不合格
- [ ] `specs/requirements.md` 存在，含 REQ-XXX + REQ-E2E-* + REQ-PERF-*
- [ ] **`### 開放問題` 已收斂為零、`flow-state spec-ready` 綠**（產互動原型前）——這是防自駕跑歪的源頭閘門
- [ ] web 類：互動原型全旅程覆蓋＋`flow-state mockup-check` 綠 + 已開瀏覽器讓使用者照走查台點過 + 已彈窗定版
- [ ] 凍結走 `flow-state spec-ready --freeze`（非裸寫 state.json）、使用者已拍板
