# Flow — 開發工作流憲法（薄目錄，每 session 載入）

> 本檔是 always-on root。**刻意保持薄**（ETH 實證：巨型指令檔讓成功率 −3%、成本 +20%）。細節一律放 `~/.claude/skills/flow-toolkit/references/`，用到才載。
> 核心信念：**Agent = Model + Harness**。模型可一行抽換；這套 harness（流程、閘門、驗證）才是產品。~75% 的失敗是 harness 可修的。

## 操作迴圈（5 階段，打 `/flow` 一鍵或單階段跑；`/flow` 可選**自駕**：spec 定版後自動跑到出貨、只 T1 分歧停）

1. `/flow-spec` — **訪談定版**：蘇格拉底一次一題彈窗＋**互異機制 lens 審查矩陣**（spec-redteam/spec-consistency，findings 落機讀 ledger 逐條終局）、**收斂迴圈問到 `### 開放問題` 清零＋lens 末輪零新發現**（`flow-state spec-ready`／`--freeze` 閘門逐項對賬，細節 `references/spec-review-loop.md`）→ 凍結 `specs/requirements.md`(EARS) → 產**零依賴互動原型**（全 REQ-E2E journey 可點走查、假資料 CRUD、狀態切換；`mockup-check` 閘門守覆蓋）、開瀏覽器、彈窗定 UI → 走 `spec-ready --freeze` 凍結。spec 釘越死＝自駕途中 AI 要猜的越少＝越不跑歪。
2. `/flow-plan` — **設計**：讀凍結 specs → `specs/design.md`（架構＋接縫契約釘一處）＋ `specs/tasks.md`（垂直切片＋依賴分波）。計畫可丟棄再生，不打磨。
3. `/flow-build` — **多工交付**：波次內 fan-out 同 repo 平行生成 worker、序列整合，階段間你拍板。紅軍先行、TDD、per-task commit。
4. `/flow-verify` — **獨立驗證**：另開 context 的 Evaluator 用 Playwright headed 真點擊、打真 API、查真 DB，對照契約。真實資料鏈路＋效能硬閘門。
5. `/flow-ship` — **跨 feature 整合＋收束**：整合 e2e＋完整效能 budget＋全 diff 審查＋達成完成謂詞 → 出貨。

輔助：`/flow-resume`（從檔案狀態接手；**換 session／當機／clear 後 SessionStart hook 已自動攤開完整現況——含 mid-task「做到第幾步」checkpoint、tasks.md↔ledger 對帳——不必記得手動跑**）、`/flow-compact`（文件收束）。

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
- **自駕模式例外**（`/flow` 起手選 `mode:"auto"`）：`跨階段推進` 自動化（移出 Ask first）＝自動推進＋每個自決 C 類需求分歧記 `flow-state decision`；其餘 Ask-first＋所有 Never 不變、照常同步彈窗。停下門檻＝T1，細節 `references/autonomous-mode.md`。

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

specs 一 concern 一檔、凍結後每迴圈重讀；**計畫是可丟棄／可從 requirements 再生的**，禁無止盡打磨同一檔；**one item per loop**；**完成謂詞** = 所有 `tasks.md` `[x]` ＋ 所有 `REQ-E2E-*` 綠（由 `complete-check` 逐條對賬 `.flow/verify` 記錄，非散文自報）＋ 效能 budget 達標 → 發 `<promise>COMPLETE</promise>` 退出。

## 確定性閘門（模型不能假裝過關）

**原則：每加一個新步驟，要嘛綁進閘門、要嘛做成會 exit 2 的 script，不留純散文 claim 點**——散文會被滑過，模型只在「有確定性節點擋著」的地方才乖乖照做。

三道 PreToolUse hook（自動擋）：① `flow-verify-gate`（TaskUpdate）—`verify` 空/`none` 擋 task 完成；② `flow-commit-gate`（Bash/PowerShell 的 git commit）—三道：staged 含 **secrets**（`.env`/私鑰類）exit 2＝**先移出 staging**；staged 含驗證垃圾（含 Playwright MCP 的 `.playwright-mcp/` 殘留）exit 2＝**先清再 commit**（`--amend` 同樣過這兩道）；commit 點名某 task 但還沒 `flow-state done`（tasks.md `[x]`＋ledger delivered）exit 2＝**先標再 commit**；③ `flow-spec-gate`（Write/Edit/Bash/PowerShell）—擋「裸寫 `.flow/state.json` 把 phase 轉成 `spec-done`/`plan-done`」與「裸寫/刪除 `.flow/{spec-review,trace,verify}/` ledger」（docHash/reqHash/manifestHash 只能由 CLI 自算），階段轉移與對賬落檔只能走 `flow-state` 正門（Bash/PS 分讀寫：唯讀/git add 放行）。SHALL 跑的 script 閘門：④ `flow-state spec-ready`（凍結前）—`### 開放問題` **段缺失**/沒清零、缺 `REQ-`/`REQ-E2E-`/`REQ-PERF-`、placeholder（TODO/待定）、REQ-E2E 缺 journey 結構、PERF N/A 無 perf-waiver 豁免檔就 exit 2，把「訪談問乾淨才准凍結」釘成確定性節點＝**自駕不跑歪的源頭閘門**（`--freeze` 通過才寫 `spec-done`，另對賬：`project-type` 落檔（web 類須過走查台＋`ui-signoff` 定版記錄或 mockup-waiver 豁免、非 web 即豁免）＋ **lens 審查收斂**（redteam/consistency 各 ≥2 輪末輪零新發現、docHash==現行文字、findings 全終局——`spec-review`/`review-resolve`/`review-check` 落的機讀 ledger，細節 `references/spec-review-loop.md`））；④b `flow-state mockup-check`（UI 定版前）—互動原型的 `index.html` 走查台缺任一 `REQ-E2E-*` 卡、本地連結 404、或連到的頁面是空殼（無 `app.js`/互動元素）就 exit 2，守「原型全旅程覆蓋、使用者能照走查台點完每條 journey 才定版」（堵片面/空殼原型偷工）；⑤ `flow-state scope --wave`（整合前）—worker 改到宣告 `conflictZone` 之外的檔（共用檔/foundation）就 exit 2，用 **git 真實變動**守同 repo 平行的檔案安全（check 確定性、模型偽造不了 diff）；⑥ `flow-state redteam --wave`（整合前）—紅軍 high 攻擊未全 `covered`、對應 `testFile` 不實存（`.flow/redteam/<id>.json`）、或高危關鍵字攻擊（auth/注入/權限/金流…）無痕 skipped（無 waiver decision 檔）就 exit 2，守「攻擊面真的變成了測試」；⑦ `flow-state journey-check`（web 宣稱綠前）—掃 Playwright 測試檔，出現 **mock/網路攔截**（`page.route`/MSW/`nock`/`cy.intercept`/`mockResolvedValue`）或**單一 test 內 >1 `goto`** 就 exit 2，把「禁 mock 假綠＋從入口真實點擊（不 deep-link 抄捷徑）」釘成機器擋（純文字掃描、偽造不了真實檔內容；深層 goto/零互動只提醒不擋＝loose 防誤殺）；⑧ `flow-state plan-check`（plan 出口）—**REQ↔task 覆蓋**（凍結 index 每條 REQ 都被 task 承接、無幻覺 id）＋**tasks.md↔manifest 逐欄一致**（blockedBy/conflictZone 不一致＝scope/wave 事實來源被調鬆）＋requirements hash 對賬，通過才落 `.flow/trace/plan-check.json`＋`phase=plan-done`，否則 exit 2；⑨ `flow-state complete-check`（ship 出口）—`tasks.md` 全 `[x]` ＋ `requirements.md` 實存且 hash==凍結分母（`.flow/trace/req-index.json`，凍結後偷改在此被抓）＋**逐條對賬 `REQ-E2E-*` vs `.flow/verify/` pass/n-a ＋ `REQ-PERF-*` vs `flow-state verify-perf` 達標記錄**（把「仍須人工確認 REQ-PERF」升級成機讀）＋plan-check.json 的 manifest hash 未漂移，任一缺 exit 2。凍結分母：`spec-ready --freeze` 通過瞬間落 `.flow/trace/req-index.json`（REQ 全集＋requirements hash＋HEAD），下游 plan-check/verify-e2e/complete-check 一律以此為分母；`flow-state run --task -- <cmd>` 真跑 runner 綁 taskId 落 journal＝done 閘門認得「真跑綠」；`flow-state verify-e2e` 自動記 HEAD/reqHash（n/a 須附 decision）。git commit+push（`git-tools` skill）、`.flow/` 狀態寫入、verify runner 都是確定性節點，不靠模型判斷。完成一個 task SHALL 跑 `flow-state done <id>`——**done 自帶閘門**：state.json `verify`/`tdd` 空/`none` 即 exit 2、交付即歸零綠燈（下一個 task 須有自己的新綠燈），別手改檔繞過任一閘門。另有**非阻擋偵測節點**（注入 additionalContext，非 exit 2）：`flow-stall-monitor`（PostToolUse）讀 runner 真實 exit code 記 journal，同失敗連 ≥N 輪注入 STALL 升級＝**自駕無花費上限時的 doom-loop 斷路器**；`flow-size-check` 偵測 `specs/` 檔膨脹（任一 >50KB）提醒 `/flow-compact` 收束；`flow-session-start`（SessionStart）自動跑 reconstruct 把完整現況（計數／mode／mid-task checkpoint／dangling／死路／tasks.md↔ledger 對帳／下一步）注入新 session＝**崩潰／關終端／clear 後不靠記憶接手**（與 `/flow-resume` 同一份 `summarizeView`、reconstruct 失敗退回精簡版不 brick）。**崩潰容錯**：`.flow/` 所有 JSON 寫入原子（temp+rename，當機半寫不壞檔）；`flow-state checkpoint <id> --phase` 記 mid-task 進度（開發中當機只補沒做完的相、不重跑整個 task）；done 交付歸零 `verifyTaskId` 堵「綠燈沒歸零→下個 task 白嫖」的崩潰窗。

## 語言與環境

對話繁中；產出 markdown 中文敘述＋英文技術詞（API/欄位/狀態碼/檔名保留英文）。**Shell 依 host 自動對應**：Windows→PowerShell（`$env:VAR`、`| Out-Null`、`A; if ($?){B}`、家目錄 `$env:USERPROFILE`）、macOS/Linux→bash/zsh（`$VAR`、`>/dev/null`、`A && B`、家目錄 `~`/`$HOME`）；含中文寫檔一律 UTF-8。**flow-toolkit 腳本路徑**（依 host）：mac/linux `~/.claude/skills/flow-toolkit/`、Windows `$env:USERPROFILE\.claude\skills\flow-toolkit\`。開瀏覽器：mac `open <url>` / Windows `Start-Process <url>` / Linux `xdg-open <url>`。
