---
name: flow-toolkit
description: Flow 工作流的參考檔倉庫與提示者。當使用者談到「需求/規格/設計/架構/實作/驗證/多工開發/出貨」但沒打 /flow 等指令時，主動提示一次可走 Flow。提供 EARS 語法、驗證範本、訪談指南、多工編排、收束策略等按需載入的 reference。
---

# flow-toolkit — Flow 工作流參考倉庫

本 skill 是 Flow 的 **on-demand 細節層**。Flow 的 always-on 憲法刻意保持薄（`~/.claude/rules/flow.md`），把細節放這裡，用到才載——這是 harness engineering 的「薄目錄 + 細節 on-demand」原則（巨型 always-on 檔會稀釋注意力、降成功率）。

## 何時主動提示

使用者談到「需求 / 規格 / 系統 / 架構 / 要做一個 X / 多工 / 驗證 / 出貨」但**沒打**任何 `/flow*` 指令 → 主動提示一次：「要走 Flow 工作流嗎？`/flow` 一鍵，或 `/flow-spec` 從需求訪談開始。」**不重複提示**。

## 五階段速查

| 指令 | 階段 | 一句話 |
|---|---|---|
| `/flow-spec` | 訪談定版 | 蘇格拉底彈窗 → 收斂到開放問題清零（spec-ready 閘門）→ 凍結 requirements → 互動原型定版（全 journey 可點走查，mockup-check 閘門） |
| `/flow-plan` | 設計 | 架構 + 接縫契約 + 垂直切片分波 |
| `/flow-build` | 多工交付 | 波次內同 repo 平行生成 worker，紅軍→TDD→序列整合 |
| `/flow-verify` | 獨立驗證 | 獨立 Evaluator + Playwright 真點擊 + 真 API/DB + 效能硬閘門 |
| `/flow-ship` | 整合出貨 | 跨 feature e2e + 完整效能 + 全 diff 審查 + 完成謂詞 |

## References（按需載入）

- `references/ears-cheatsheet.md` — EARS 需求語法（`/flow-spec` 用）
- `references/interview-guide.md` — 蘇格拉底 + grill-me 訪談法、UI 對齊流程（`/flow-spec` 用）
- `references/prototype-guide.md` — 零依賴互動原型規格：假資料層、狀態切換器、journey 走查台、mockup-check 閘門（`/flow-spec` Step 5 用）
- `references/tasks-template.md` — P-*/F-*/X- 三層分組範本 + 依賴分波（`/flow-plan` 用）
- `references/orchestration-guide.md` — 混合多工編排、成本路由、effort 分級、recipe 用法（`/flow-build` 用）
- `references/verification-playbook.md` — TDD 三相 + 驗證矩陣 + 兩層 sensor + 修復迴圈（`/flow-verify` 用）
- `references/playwright-real-data-template.md` — Playwright 真實資料鏈路 spec 範本（`/flow-verify`、`/flow-ship` 用）
- `references/perf-budget.md` — 效能硬閘門：量什麼、budget 怎麼設、p50/p95（`/flow-verify`、`/flow-ship` 用）
- `references/convergence-guide.md` — context 預算、compaction、完成謂詞、文件生命週期（`/flow-compact` 用）
- `references/recipes/` — Workflow 多工腳本（parallel-build.js / parallel-verify.js / research-sweep.js）
- `references/design-systems/` — **150 套大廠品牌設計系統**（每套 `DESIGN.md` 9 段 + `tokens.css` CSS 變數 + `components.html`），`/flow-spec` UI 階段選一套當基底、**lazy 只讀選中的**（context 零負擔）；`index.md` 分類索引（22 類）、`build-index.mjs` 可重生、`NOTICE.md` 授權（取自 open-design Apache-2.0，美學靈感·非官方品牌資產）

## 工具腳本（直接 `node` 跑，不進 context）

- `flow-state.mjs` — 狀態 CLI：`resume`/`status`（冷啟動 reconstruct 印現況 + 下一步）/`done <id>`（**標一個 task 完成**：翻 tasks.md `[x]` + ledger→delivered，先標再 commit；被 `flow-commit-gate` 擋下時就跑它。**自帶 done 閘門**：state.json `verify`/`tdd` 空/`none` → exit 2、交付即歸零綠燈）/`scope --wave <ids>`（檔案越界閘門）/`redteam --wave <ids>`（紅軍對賬閘門：high 攻擊未全 covered 或 testFile 不實存 → exit 2）/`journey-check [--dir]`（journey 真實性閘門：Playwright 測試出現 mock/網路攔截 或 單一 test 內 >1 goto → exit 2）/`verify-e2e <id> --status <pass\|fail\|n/a> --evidence`（記一條 REQ-E2E 驗證結果，供對賬）/`coverage`、`complete-check`（REQ-E2E 覆蓋對賬：requirements.md 的 REQ-E2E-* vs `.flow/verify` 記錄，缺/未過 exit 2）/`mockup-check [--dir]`（互動原型走查閘門：`specs/ui-mockups/index.html` 缺 REQ-E2E 走查卡或本地連結 404 → exit 2；`spec-ready --freeze` 在目錄存在時一併驗）。
- `clean-verify-artifacts.mjs` — **commit 前清驗證垃圾**的確定性節點（`/flow-build` Step 5、`/flow-ship` Step 6、`/flow-verify` 全綠後用；判斷函數同時被 `flow-commit-gate` 閘門一 import＝單一事實來源）：白名單整刪驗證產物（含 **Playwright MCP 的 `.playwright-mcp/`：console-*.log／page-*.yml a11y snapshot／截圖**）+ 一次性 debug 殘留、補 `.gitignore`，不碰 source 測試檔／specs／.flow ledger／baseline。Tier A 絕對垃圾無條件清、Tier B（散落截圖／`*.webm` 錄影）僅 git untracked 才清。`--apply` 才真刪、`--gitignore` 補忽略規則（細節見 `references/verification-playbook.md` §七）。

## 三條跨階段主軸（憲法摘要，細節見各 reference）

1. **Context 預算**：working set 壓 < 視窗 40–50%、specs 檔 >50KB 收束（flow-size-check hook）、薄 root、細節 on-demand、subagent context firewall。
2. **檔案耐久狀態**：specs/ + .flow/state.json + git；agent 可拋棄可恢復、純讀檔接手。
3. **確定性閘門**：commit / state 寫入 / verify runner 是確定性節點，模型不能假裝過關。
