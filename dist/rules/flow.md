# Flow — 開發工作流憲法（薄目錄，每 session 載入）

> 本檔是 always-on root。**刻意保持薄**（ETH 實證：巨型指令檔讓成功率 −3%、成本 +20%）。細節一律放 `~/.claude/skills/flow-toolkit/references/`，用到才載。
> 核心信念：**Agent = Model + Harness**。模型可一行抽換；這套 harness（流程、閘門、驗證）才是產品。~75% 的失敗是 harness 可修的。

## 操作迴圈（5 階段，打 `/flow` 一鍵或單階段跑）

1. `/flow-spec` — **訪談定版**：蘇格拉底一次一題彈窗 → 凍結 `specs/requirements.md`(EARS) → ui-ux-pro-max 產 HTML mockup、開瀏覽器、彈窗定 UI → 凍結。
2. `/flow-plan` — **設計**：讀凍結 specs → `specs/design.md`（架構＋接縫契約釘一處）＋ `specs/tasks.md`（垂直切片＋依賴分波）。計畫可丟棄再生，不打磨。
3. `/flow-build` — **多工交付**：波次內 fan-out 同 repo 平行生成 worker、序列整合，階段間你拍板。紅軍先行、TDD、per-task commit。
4. `/flow-verify` — **獨立驗證**：另開 context 的 Evaluator 用 Playwright headed 真點擊、打真 API、查真 DB，對照契約。真實資料鏈路＋效能硬閘門。
5. `/flow-ship` — **跨 feature 整合＋收束**：整合 e2e＋完整效能 budget＋全 diff 審查＋達成完成謂詞 → 出貨。

輔助：`/flow-resume`（從檔案狀態接手）、`/flow-compact`（文件收束）。

**小功能輕量路徑**：小調整可跳 `/flow-spec` 訪談但**仍寫 SDD**（精簡 REQ + F-task，照走 TDD/真實資料鏈路驗證）；踩到需求級變動（新實體/角色/auth/RBAC/payment/個資 scope）強制升回 `/flow-spec`。詳見 `/flow` Step 0.5。

## 三層邊界（唯一的全域硬規則；其餘細節在 references）

**Always do（一律做）**
- 完成 = **實跑綠燈**，不是 code 看起來對 → 細節 `references/verification-playbook.md`
- 涉資料的驗證走**真實鏈路**：假資料經真 create API seed 進真 DB、再 UI→真 API→真 DB 讀回
- 沒 `specs/requirements.md` 不設計；沒 `design.md`+`tasks.md` 不寫 code
- 狀態進**檔案**（`specs/`、`.flow/state.json`、git），不靠 in-context 記憶

**Ask first（先彈窗問，用 AskUserQuestion 白話講 trade-off）**
- 跨階段推進、UI 方向定版、裝新 dependency、破壞性 DB 操作（DROP/TRUNCATE/無 WHERE 的 DELETE/UPDATE）
- **波次執行策略偏離預設平行**：把 `/flow-build` 已算出的並行波降級成序列/部分平行 → 先彈窗講清 token↔速度 trade-off，**禁在 thinking/散文裡自決**

**Never（一律禁，每條都配正解）**
- ❌ 用 mock/stub/寫死 fixture 冒充功能完成 → ✅ 真依賴未 ready 就標 **BLOCKED**
- ❌ 沒真跑 runner 就填 `verify=ok`/標 completed → ✅ 先跑出綠燈再標，閘門 hook 會擋
- ❌ placeholder/簡化實作當完成 → ✅ full implementation，沒做完就說沒做完
- ❌ 把細節塞進本 root 檔 → ✅ 放 references、本檔只留指標
- ❌ hardcode model-specific 行為 → ✅ model 當可抽換參數

## Karpathy 四原則（bake-in，動 code 當下的紀律）

1. **Think Before Coding**：不確定就問、列假設、有更簡方案主動 push back、不清楚就停。
2. **Simplicity First**：只寫解決問題的最小 code。禁投機設計／單次用卻硬抽象／沒被要求的彈性。資深工程師會嫌過度設計 → 重寫（200 行能寫成 50 行就重寫）。
3. **Surgical Changes + 極簡清理**：只動非動不可的、沿用既有 style、不順手美化沒壞的東西。清理：本次改動造成的孤兒 import/變數同 commit 刪；**既有死 code / 過時檔 / 未引用資產，先全 repo grep 確認真 0 引用（含動態/字串/測試/config）後主動清乾淨**（大片/有疑慮先回報；`legacy/`/`archive/`/`@deprecated` 只回報不刪）。極簡是使用者 durable 偏好。
4. **Goal-Driven Execution**：任務轉成可驗證目標（「修 bug」→「先寫重現測試再讓它過」）；多步驟先列「步驟→verify」再動手。

## Context 預算（防腐化，效率與收束的根）

- root always-on 保持薄；reference / specs **on-demand 載入**，不預先全塞。
- compaction **先刪最新的尾巴**保住 cache prefix（cache hit 價 = miss 的 1/10）、保留最近 5 個熱檔。
- 吵雜/大 context 的工作丟**獨立 subagent**（context firewall），只收回 1–2k 蒸餾結果。

## 多工基座 = 混合（細節 `references/orchestration-guide.md`）

波次內 fan-out 用 **Workflow 腳本**（背景跑、結構化回傳）；階段之間保留**互動式人工閘門**你拍板。foundation/共用檔**先序列**、features 才 **同 repo 平行生成（conflictZone 互斥）、序列整合**（worker 只寫各自不重疊的檔，build/commit 由主流程一個個做；整合前跑 `flow-state scope` 擋越界）。orchestrator 寫死 effort 分級＋成本路由（Opus 編排/審查、Sonnet 平行苦工、Haiku 窄活）＋**小盒子工具**。平行苦工走較便宜 model（`workerModel` 預設 Sonnet、可覆寫）省 token＝**同預算開更寬的波**，Evaluator/紅軍不降級；效能嚴謹 p50/p95 每 feature 只跑便宜 smoke、嚴謹量測留 ship 量一次（最貴又不可平行的別 ×N 重燒）。多工 ~15x token，**只在真平行＋高價值才 fan-out**。

## 收束（防無限寫入，細節 `references/convergence-guide.md`）

specs 一 concern 一檔、凍結後每迴圈重讀；**計畫是可丟棄／可從 requirements 再生的**，禁無止盡打磨同一檔；**one item per loop**；**完成謂詞** = 所有 `tasks.md` `[x]` ＋ 所有 `REQ-E2E-*` 綠 ＋ 效能 budget 達標 → 發 `<promise>COMPLETE</promise>` 退出。

## 確定性閘門（模型不能假裝過關）

**原則：每加一個新步驟，要嘛綁進閘門、要嘛做成會 exit 2 的 script，不留純散文 claim 點**——散文會被滑過，模型只在「有確定性節點擋著」的地方才乖乖照做。

兩道 PreToolUse hook（自動擋）：① `flow-verify-gate`（TaskUpdate）—`verify` 空/`none` 擋 task 完成；② `flow-commit-gate`（Bash/git commit）—兩道：staged 含驗證垃圾（含 Playwright MCP 的 `.playwright-mcp/` 殘留）exit 2＝**先清再 commit**；commit 點名某 task 但還沒 `flow-state done`（tasks.md `[x]`＋ledger delivered）exit 2＝**先標再 commit**。一道整合前 SHALL 跑的 script 閘門：③ `flow-state scope --wave`—worker 改到宣告 `conflictZone` 之外的檔（共用檔/foundation）就 exit 2，用 **git 真實變動**守同 repo 平行的檔案安全（check 確定性、模型偽造不了 diff）。git commit+push（`git-tools` skill）、`.flow/` 狀態寫入、verify runner 都是確定性節點，不靠模型判斷。完成一個 task SHALL 跑 `flow-state done <id>`，別手改檔繞過任一閘門。

## 語言與環境

對話繁中；產出 markdown 中文敘述＋英文技術詞（API/欄位/狀態碼/檔名保留英文）。**Shell 依 host 自動對應**：Windows→PowerShell（`$env:VAR`、`| Out-Null`、`A; if ($?){B}`、家目錄 `$env:USERPROFILE`）、macOS/Linux→bash/zsh（`$VAR`、`>/dev/null`、`A && B`、家目錄 `~`/`$HOME`）；含中文寫檔一律 UTF-8。**flow-toolkit 腳本路徑**（依 host）：mac/linux `~/.claude/skills/flow-toolkit/`、Windows `$env:USERPROFILE\.claude\skills\flow-toolkit\`。開瀏覽器：mac `open <url>` / Windows `Start-Process <url>` / Linux `xdg-open <url>`。
