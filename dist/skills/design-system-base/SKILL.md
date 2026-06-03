---
name: design-system-base
description: 當使用者要做 UI、視覺設計、前端頁面、元件、儀表板、landing page、後台介面，或要選設計風格／品牌調性（如 Linear、Stripe、Apple、shadcn、glassmorphism 風）時啟用。提供 Flow 內建的 150 套大廠品牌設計系統（DESIGN.md 9 段規範 + tokens.css CSS 變數），讓 UI 從大廠級設計語言起步、拒絕平庸的框架預設樣式。lazy 只讀使用者選中的那一套，不限走不走 /flow-spec。
---

# design-system-base — 品牌設計系統基底

UI／視覺工作的第一步：從 **150 套大廠品牌設計系統**選一套當「深層客製化」(Deep Customization) 的起點，而非從零湊樣式或直接用框架預設。

## 何時用

任何要產出或調整 UI 的場景——landing page / dashboard / 元件 / mockup / 改視覺風格 / 選品牌調性。**不限走不走 `/flow-spec`**：`/flow-spec` 有自己的「選品牌基底」步驟；本 skill 補「隨手做 UI、不走 spec」時也能用上這個庫。

## 怎麼用（lazy — 永遠只讀選中那一套）

1. **讀索引**（僅清單、約幾 KB）：`<flow-toolkit>/references/design-systems/index.md`（150 套、22 類）。路徑依 host：
   - Windows：`%USERPROFILE%\.claude\skills\flow-toolkit\references\design-systems\`
   - mac/linux：`~/.claude/skills/flow-toolkit/references/design-systems/`
2. **選一套**：依專案類型用 `AskUserQuestion` 跟使用者選，推薦置首——工具/SaaS → `shadcn`/`linear-app`/`vercel`、金流 → `stripe`/`wise`、AI 產品 → `claude`/`openai`、風格實驗 → `glassmorphism`/`bento`/`brutalism`。使用者要純自訂就略過。
3. **只讀選中那套**（context 零負擔，別全載）：`<slug>/DESIGN.md`（9 段：色彩 / 排版 / 間距 / 佈局 / 元件 / 動效 / 語氣 / 品牌 / 反模式）+ `<slug>/tokens.css`（CSS 變數）+ 可選 `<slug>/components.html`。
4. **當基底實作**：`tokens.css` 的 `:root` 變數直接 inline 或餵 Tailwind（用 `var(--*)`），照 `DESIGN.md` 的規範組合版面與元件；**別臆造 palette 外的 token**。可疊用 `ui-ux-pro-max` 補元件級互動狀態 / a11y / shadcn 範例。

## 邊界

- **lazy 鐵則**：只讀使用者選中的那一套，絕不把 150 套全載進 context。
- 設計系統屬**美學靈感、非官方品牌資產**（見 `design-systems/NOTICE.md`），商用前自行確認各品牌商標與使用規範。
- 來源：open-design（Apache-2.0）。索引可由 `design-systems/build-index.mjs` 重生。
