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
| `/flow-spec` | 訪談定版 | 蘇格拉底彈窗 → 凍結 requirements → UI mockup 定版 |
| `/flow-plan` | 設計 | 架構 + 接縫契約 + 垂直切片分波 |
| `/flow-build` | 多工交付 | 波次內 worktree 平行 worker，紅軍→TDD→真實鏈路自檢 |
| `/flow-verify` | 獨立驗證 | 獨立 Evaluator + Playwright 真點擊 + 真 API/DB + 效能硬閘門 |
| `/flow-ship` | 整合出貨 | 跨 feature e2e + 完整效能 + 全 diff 審查 + 完成謂詞 |

## References（按需載入）

- `references/ears-cheatsheet.md` — EARS 需求語法（`/flow-spec` 用）
- `references/interview-guide.md` — 蘇格拉底 + grill-me 訪談法、UI 對齊流程（`/flow-spec` 用）
- `references/tasks-template.md` — P-*/F-*/X- 三層分組範本 + 依賴分波（`/flow-plan` 用）
- `references/orchestration-guide.md` — 混合多工編排、成本路由、effort 分級、recipe 用法（`/flow-build` 用）
- `references/verification-playbook.md` — TDD 三相 + 驗證矩陣 + 兩層 sensor + 修復迴圈（`/flow-verify` 用）
- `references/playwright-real-data-template.md` — Playwright 真實資料鏈路 spec 範本（`/flow-verify`、`/flow-ship` 用）
- `references/perf-budget.md` — 效能硬閘門：量什麼、budget 怎麼設、p50/p95（`/flow-verify`、`/flow-ship` 用）
- `references/convergence-guide.md` — context 預算、compaction、完成謂詞、文件生命週期（`/flow-compact` 用）
- `references/recipes/` — Workflow 多工腳本（parallel-build.js / parallel-verify.js / research-sweep.js）

## 工具腳本（直接 `node` 跑，不進 context）

- `dashboard.mjs` — 監控看板 server（`/flow-monitor` 用，唯讀投影）。
- `flow-state.mjs` — 狀態 CLI：`resume`（冷啟動重建現況）/`monitor`（冪等起看板）/`done <id>`（**標一個 task 完成**：翻 tasks.md `[x]` + ledger→delivered，先標再 commit；被 `flow-commit-gate` 擋下時就跑它）。
- `clean-verify-artifacts.mjs` — **commit 前清驗證垃圾**的確定性閘門（`/flow-build` Step 5、`/flow-ship` Step 5 用）：白名單刪驗證產物 + 一次性 debug 殘留、補 `.gitignore`，不碰 source 測試檔／specs／.flow ledger。`--apply` 才真刪、`--gitignore` 補忽略規則（細節見 `references/verification-playbook.md` §七）。

## 三條跨階段主軸（憲法摘要，細節見各 reference）

1. **Context 預算**：working set 壓 < 視窗 40–50%、specs 檔 >50KB 收束（flow-size-check hook）、薄 root、細節 on-demand、subagent context firewall。
2. **檔案耐久狀態**：specs/ + .flow/state.json + git；agent 可拋棄可恢復、純讀檔接手。
3. **確定性閘門**：commit / state 寫入 / verify runner 是確定性節點，模型不能假裝過關。
