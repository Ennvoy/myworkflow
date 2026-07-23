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
| `/flow-spec` | 訪談定版 | 蘇格拉底彈窗＋lens 審查矩陣（spec-redteam/spec-consistency 落 ledger 逐條終局）→ 收斂到開放問題清零＋lens 末輪零新發現（spec-ready/--freeze 對賬）→ 凍結 requirements → 互動原型定版（全 journey 可點走查，mockup-check 閘門＋ui-signoff） |
| `/flow-plan` | 設計 | 架構 + 接縫契約 + 垂直切片分波（plan-check 對賬 REQ↔task 覆蓋＋tasks.md↔manifest 一致） |
| `/flow-build` | 多工交付 | 波次內同 repo 平行生成 worker，紅軍→TDD→序列整合 |
| `/flow-verify` | 獨立驗證 | 獨立 Evaluator + Playwright 真點擊 + 真 API/DB + 效能硬閘門 |
| `/flow-ship` | 整合出貨 | 跨 feature e2e + 完整效能 + 全 diff 審查 + 完成謂詞 |

## References（按需載入）

- `references/ears-cheatsheet.md` — EARS 需求語法（`/flow-spec` 用）
- `references/interview-guide.md` — 蘇格拉底 + grill-me 訪談法、UI 對齊流程（`/flow-spec` 用）
- `references/spec-review-loop.md` — lens 審查矩陣收斂迴圈：五鏡頭、輪結構、findings 終局、fail 對策（`/flow-spec` 用）
- `references/prototype-guide.md` — 零依賴互動原型規格：假資料層、狀態切換器、journey 走查台、mockup-check 閘門（`/flow-spec` Step 5 用）
- `references/tasks-template.md` — P-*/F-*/X- 三層分組範本 + 依賴分波（`/flow-plan` 用）
- `references/orchestration-guide.md` — 混合多工編排、成本路由、effort 分級、recipe 用法（`/flow-build` 用）
- `references/verification-playbook.md` — TDD 三相 + 驗證矩陣 + 兩層 sensor + 修復迴圈（`/flow-verify` 用）
- `references/debugging-playbook.md` — 除錯紀律：連續修復失敗前的 tight feedback loop／可證偽假說／單變因實驗／清理（`/flow-build`、`/flow-verify` 用）
- `references/playwright-real-data-template.md` — Playwright 真實資料鏈路 spec 範本（`/flow-verify`、`/flow-ship` 用）
- `references/perf-budget.md` — 效能硬閘門：量什麼、budget 怎麼設、p50/p95（`/flow-verify`、`/flow-ship` 用）
- `references/ship-receipt.md` — 出貨收據：complete-check 通過後 on-demand 產單頁交付證明＋Artifact 發布，純 render 機讀記錄（`/flow-ship` Step 5.5 用）
- `references/convergence-guide.md` — context 預算、compaction、完成謂詞、文件生命週期（`/flow-compact` 用）
- `references/recipes/` — Workflow 多工腳本（parallel-build.js / parallel-verify.js / research-sweep.js）
- `references/design-systems/` — **150 套大廠品牌設計系統**（每套 `DESIGN.md` 9 段 + `tokens.css` CSS 變數 + `components.html`），`/flow-spec` UI 階段選一套當基底、**lazy 只讀選中的**（context 零負擔）；`index.md` 分類索引（22 類）、`build-index.mjs` 可重生、`NOTICE.md` 授權（取自 open-design Apache-2.0，美學靈感·非官方品牌資產）

## 工具腳本（直接 `node` 跑，不進 context）

flow-state.mjs 完整 subcommand 清單與閘門語意：見 `references/gates-reference.md`（唯一詳述處）或 `node flow-state.mjs help`。

## 三條跨階段主軸（憲法摘要，細節見各 reference）

1. **Context 預算**：working set 壓 < 視窗 40–50%、specs 檔 >50KB 收束（flow-size-check hook）、薄 root、細節 on-demand、subagent context firewall。
2. **檔案耐久狀態**：specs/ + .flow/state.json + git；agent 可拋棄可恢復、純讀檔接手。
3. **確定性閘門**：commit / state 寫入 / verify runner 是確定性節點，模型不能假裝過關。
