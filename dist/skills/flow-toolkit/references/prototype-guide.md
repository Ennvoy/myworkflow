# 互動原型指南（/flow-spec Step 5 用）

**目標**：mockup 不是「幾頁靜態圖靠想像」，而是**可互動、像成品的原型**——使用者照走查台把每條 journey 真點一遍，「感受到開發完的樣子」再定版。方向錯在這裡擋掉，比 build 到一半才發現便宜 10 倍。

**定位**：原型是 **UI 錨點、不是產品 code**。build 沿用它的 markup / tokens / 版面，把假資料層換成真 API——但仍走完整 TDD＋真實資料鏈路驗證，**禁把原型檔直接搬進 src/ 當完成**。

## 一、技術形式（零依賴，鐵則）

- 純 HTML＋Tailwind CDN＋vanilla JS＋`localStorage`。**禁** framework／build step／npm 依賴／dev server——`file://` 雙擊直接開，0 摩擦。
- 含中文寫檔一律 UTF-8。**C-59 編碼分流**：`.ps1` 腳本檔用 PowerShell `-Encoding utf8`（PS 5.1 會帶 BOM，`.ps1` 刻意要 BOM，見全域規範）；但**原型 web 資產（`.html`/`.js`/`.css`/`.json`）別用 PS 5.1 `-Encoding utf8`（BOM 會讓部分 linter/打包工具讀壞）——改用 Write 工具或 Node 寫（無 BOM）、或 PS7 的 `utf8NoBOM`。
- 有品牌基底時：該套 `tokens.css` 的 `:root` 變數 **verbatim inline** 進共用 `<style>`／`tokens.css`，不臆造。

## 二、檔案佈局（`specs/ui-mockups/`）

```
specs/ui-mockups/
├── index.html      # journey 走查台（入口，見 §五）
├── app.js          # 共用假資料層 + 互動 helper（一份，各頁引用）
├── tokens.css      # 設計 token（品牌基底 verbatim；無基底則 ui-ux-pro-max 產出）
└── pages/*.html    # 每個畫面一檔（全旅程覆蓋，見 §四）
```

## 三、假資料層（讓 CRUD 有真實感）

- `app.js` 集中管：`seed` 初始假資料（貼近真實的名稱/數量/日期，**禁 lorem ipsum**）＋ `localStorage` 持久化＋ CRUD helper。
- **操作要有後果**：新增一筆→列表真的多一筆；刪除→真的消失；編輯→真的變。跨頁共享同一份資料（都讀 `localStorage`）。
- 走查台放「**重置假資料**」鈕（清 `localStorage` 回 seed）——使用者亂點壞了一鍵復原。
- 假資料層在 `app.js` 頂部標註 `// PROTOTYPE fake data layer — build 時換成真 API`，build 的接縫一目了然。

## 四、互動與覆蓋要求

- **全旅程覆蓋**：所有 `REQ-E2E-*` 途經的**每個畫面**都有頁；每條 journey 從入口可一路點到終點（真實 `<a>`/JS 跳轉，不是「請想像下一頁」）。
- **互動元素真的動**：表單可填＋驗證回饋（錯誤訊息長怎樣）、modal/dropdown/tab 可開合、按鈕有 hover/active/disabled/loading 態（完整狀態機，對齊 ui-ux-pro-max 規範）。
- **異常路徑看得到**：每頁右下角固定一個「原型狀態切換器」小工具（`app.js` 提供），一鍵切換**空狀態／載入中／錯誤／權限不足**檢視——spec 訪談問出來的異常處置（EARS Unwanted 條）在這裡變成看得見的畫面。**C-43 條件化**：狀態切換器只在「該頁真有這些異常態」時放（純展示頁/無資料互動的靜態頁免放）；**純 API / headless（無 UI）專案**由 `flow-state project-type` 判定為非 web 類 → freeze 自動跳過互動原型與 `mockup-check`，**不必手動 mockup-waiver**（有畫面的 web 類才強制原型）。
- 響應式至少驗 desktop＋mobile 寬度不破版。

## 五、journey 走查台（`index.html`，mockup-check 閘門機檢）

每條 `REQ-E2E-*` 一張卡，含：**REQ-E2E id**（原文，閘門靠它對賬）＋ journey 標題＋逐步驟清單（走到哪頁、點什麼、該看到什麼）＋**入口連結**。另放：畫面總覽縮圖連結、重置假資料鈕、選用的品牌基底 slug。

使用者的定版體驗＝「開 index.html → 挑一條 journey → 照步驟點完 → 回來點下一條」。

## 六、確定性閘門與定版

1. 產完原型 SHALL 跑 `flow-state mockup-check`：`index.html` 缺任一 REQ-E2E 走查卡、走查台連到的本地頁 404、或連到的頁面是**空殼**（未引用 `app.js` 或無任何 form/button/連結互動元素）→ **exit 2**（堵「只產兩頁就請使用者定版」與「有卡但頁面空殼」的偷工；`spec-ready --freeze` 在 `specs/ui-mockups/` 存在時會再驗一次）。閘門只守覆蓋骨架——**好不好看、對不對味仍由使用者定版**。
2. 綠了才**主動開瀏覽器**送 index.html 到使用者眼前（mac `open` / Windows `Start-Process` / Linux `xdg-open`）。
3. `AskUserQuestion` 收方向：「照走查台點完了嗎？方向 OK / 某幾頁要改 / 整個方向錯」。改到使用者點頭才凍結。

## 七、成本與護欄

- 互動原型成本約靜態 mockup 2–3 倍——**值**：UI 方向是最貴的返工來源，且 build 沿用原型 markup/tokens 會省回來。頁數多時可 fan-out 平行產頁（共用 `tokens.css`/`app.js` 先序列釘死，各頁互不重疊）。
- 原型內**禁**過度工程：不抽共用元件系統、不寫 router、不做真 auth——夠讓使用者走完 journey、感受成品即可（Simplicity First）。
- 原型定版後就是錨點，**且這條錨鏈全程有閘門**（不再是散文期望）：`spec-ready --freeze` 把整個 `specs/ui-mockups/` 逐檔 hash 凍成 `mockup-index.json`（偷改必抓）；`/flow-plan` 的「UI 對焦結論」與 task 的 `mockupPages` 承接每一頁（plan-check 機檢）；`wave --compute` 把 `tokens.css` 逐字＋各 task 原型頁投餵 build worker；`ui-fidelity` 在 verify/ship 驗 tokens 真的被沿用（complete-check 對賬）。build 改了版面＝需求級變更，worker 標 BLOCKED 回頭走正式變更。
