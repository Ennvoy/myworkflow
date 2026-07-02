# 訪談指南：蘇格拉底 + grill-me + UI 對齊（/flow-spec 用）

**核心**：別急著做東西。先把需求談清楚、寫成檔、凍結，之後每迴圈重讀（conversation-first）。方向錯在這裡擋掉，比 build 到一半才發現便宜 10 倍。

## 一、彈窗紀律（鐵則）

**SHALL 用 `AskUserQuestion` 一次一題**，不要純文字「Q1/Q2/Q3 逐條回」。每題：
- 2–4 個 option，**推薦選項置首標「(建議)」**
- 每個 option 白話講「選了會怎樣 / 不選會怎樣 / trade-off」
- 開放式問題也包成 2–4 個方向 option（系統會自動加「其他」讓使用者自填）
- 一輪最多 4 題，看回答再決定下一輪

## 二、grill-me 精神：能查就先查，不要丟回給使用者

問之前先自己做功課：能從現有 code / 慣例 / 公認預設判斷的，自己查、自己定、回覆時說明，**不要把可自行判斷的事當問題丟回去**。只有「真的需要使用者決策 / 釐清 / 授權」的才彈窗。

## 三、要挖到「決策樹每個分支都釐清」

逐層深挖，每層用彈窗收斂：

1. **範圍邊界**：什麼在 scope 內、什麼明確不做（防範圍蔓延）
2. **使用者與目標**：主要 user 是誰、要達成什麼、成功長什麼樣
3. **每條主功能的路徑**：
   - happy path（順順走完會怎樣）
   - **異常路徑**（空狀態 / 輸入錯 / 權限不足 / 併發 / 相依故障 / 網路斷）——這是最常漏的
4. **資料模型雛形**：有哪些實體、關係、**scope（誰能看誰的資料）**
5. **非功能需求**：
   - **效能**：哪個畫面/操作要多快（逼出 REQ-PERF-*，含分位數）
   - 安全、相容、可用性
6. **驗收條件**：每條需求「怎樣算做完」（逼出可驗的 EARS 句）

**收斂是迴圈、不是一輪**：grill-me + spec-reviewer 反覆問，把 `### 開放問題` 一項項清掉，直到**某一輪問不出新問題**才算收斂。收斂後跑 `flow-state spec-ready`（確定性閘門）——`### 開放問題` 段缺失/沒清零、缺 `REQ-E2E-`/`REQ-PERF-`、placeholder（TODO/待定）、REQ-E2E 缺 journey 結構、REQ-PERF 標 N/A 沒有 perf-waiver 豁免檔，任一就 exit 2，把未收斂項列回來繼續問（含糊詞/缺規範動詞僅警告，帶回訪談補問）；**綠了才往下產互動原型**。真無法當場拍板的，移到 `### 延後決策` 段並 `flow-state decision` 記錄，**不留懸空項**——懸空項就是自駕途中 AI 拿去亂猜、跑歪的源頭。

## 四、獨立 spec-reviewer（建議）

整理出初版需求後，對「你整理的需求」呼叫獨立 `spec-reviewer` subagent（另開 context），請它回 5–7 條質疑清單：邊界、衝突、隱含假設、缺失異常路徑。把質疑帶回，用彈窗跟使用者對焦。**這跟 grill-me 互補**：grill-me 是與使用者的連續對話、spec-reviewer 是一次性獨立質疑清單。

## 五、UI 方向對齊——互動原型（僅 web 類，鐵則）

需求收斂後、凍結前，產**零依賴互動原型**（不是靜態圖）；完整規格見 `references/prototype-guide.md`：

1. 呼叫 `ui-ux-pro-max:ui-ux-pro-max` 取設計建議（style / palette / font / product-type 規範）。
2. 產互動原型到 `specs/ui-mockups/`：**全旅程覆蓋**（所有 `REQ-E2E-*` 途經畫面、頁頁互連可點到終點）＋假資料層 `app.js`（localStorage、CRUD 有後果）＋每頁狀態切換器（空/載入/錯誤/權限不足）＋`index.html` journey 走查台（每條 REQ-E2E 一張卡）。Tailwind CDN、零依賴、`file://` 直接開；含中文寫檔一律 UTF-8（PowerShell 加 `-Encoding utf8`）。
3. SHALL 跑 `flow-state mockup-check`（確定性閘門）：走查台缺 REQ-E2E 卡、連結 404、或連到的頁面是空殼（無 app.js/互動元素）→ exit 2 補齊再來。
4. **主動開瀏覽器**開 index.html（mac `open` / Windows `Start-Process` / Linux `xdg-open`）（0 摩擦原則，把實體送到使用者眼前，避免被文字滑過）。
5. `AskUserQuestion` 收方向：「照走查台把 journey 點完了嗎？方向 OK / 某幾頁要改 / 整個方向錯」。**改到使用者點頭才凍結**，後續以原型為錨點反推 API/DB（build 沿用 markup/tokens、假資料層換真 API）。

> 為什麼鐵則：使用者 build 到一半才喊「整個方向錯了」是最大的重做災難。UI-first 把方向釘死在最早能「親手點過」實體的時點——靜態圖看不出流程與異常態，可互動原型才能讓使用者真的感受成品再拍板。

## 六、凍結

`### 開放問題` 清零（`flow-state spec-ready` 綠）+ UI 方向都定 → 彈窗問「是否進 /flow-plan」→ 使用者拍板 → 走凍結正門 `flow-state spec-ready --freeze`（再驗收斂一次才寫 `phase="spec-done"`＋落 journal）。**別手改 state.json 裸寫繞過**——`flow-spec-gate` hook 會擋裸寫轉移。**凍結後不再回頭改**（要改走正式變更，不在 build 中途漂移）。
