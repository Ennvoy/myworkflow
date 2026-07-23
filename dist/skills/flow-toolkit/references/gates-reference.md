# Flow 確定性閘門 Reference（唯一詳述處）

> root 憲法（rules/flow.md）只留閘門清單＋一句用途；每道閘門的完整運作機制（檔名/欄位/exit 條件）只在本檔維護。
> 原則不變：**每加一個新步驟，要嘛綁進閘門、要嘛做成會 exit 2 的 script，不留純散文 claim 點**——散文會被滑過，模型只在「有確定性節點擋著」的地方才乖乖照做。
> 載入時機：/flow-spec 凍結前、/flow-plan 出口、/flow-build 起手、/flow-verify、/flow-ship 收尾，或任何閘門 exit 2 需要查語義時。

## Hook 閘門（事件自動擋，exit 2）

- ① **flow-commit-gate**（PreToolUse: Bash/PowerShell 的 git commit）三道：staged 含 **secrets**（`.env`/私鑰類）exit 2＝先移出 staging；staged 含驗證垃圾（含 Playwright MCP 的 `.playwright-mcp/` 殘留）exit 2＝先清再 commit（`--amend` 同樣過這兩道）；commit 點名某 task 但還沒 `flow-state done`（tasks.md `[x]`＋ledger delivered）exit 2＝先標再 commit。另擋 `--no-verify`/`-n`/`-c core.hooksPath`（繞過 git pre-commit 兜底）。
- ② **flow-spec-gate**（PreToolUse: Write/Edit/Bash/PowerShell）——擋「裸寫 `.flow/state.json` 把 phase 轉 `spec-done`/`plan-done`」與「裸寫/刪除 `.flow/{spec-review,trace,verify,code-review}/` ledger」（docHash/reqHash/manifestHash/終局只能由 CLI 自算）；階段轉移與對賬落檔只能走 `flow-state` 正門。Bash/PS 分讀寫：唯讀/git add 放行。
- ③ **flow-auto-gate**（PreToolUse: Bash/PowerShell，僅 mode=auto）——三道硬擋：裝新相依（須彈窗）、破壞性 DB（DROP/TRUNCATE/無 WHERE 的 DELETE/UPDATE）、doom-loop 硬天花板（同 runner 連敗 ≥ 軟閾值+3 擋重跑）。**dependency 預核准**：`.flow/policy.json` `{"deps":{"allow":["<pkg>","@scope/*"]}}`（進 git、使用者拍板維護）內的套件放行＋自動落 `dep-auto-*` decision 審計；清單外照樣硬擋。
- ④ **flow-stop-gate**（Stop，僅 mode=auto）——tasks.md 全 `[x]` 卻沒有「當前 HEAD 的 complete-check 通過記錄」（`.flow/trace/complete-check.json`）→ 擋收工；還有 `[ ]`（mid-run/T1 停等）不干擾。逃生口：跑 complete-check 或 `mode manual`。
- ⑤ **flow-precompact**（PreCompact）——context 壓縮前自動對每個 building 中的 task 落 `pre-compact` checkpoint，防 auto-compact 丟「做到第幾步」。
- ⑥ **flow-git-guardrail**（PreToolUse: Bash/PowerShell，進 dispatch 最前）——攔開/切分支與破壞性 git（force push／reset --hard／clean -f／branch -D／checkout .…）：先 `AskUserQuestion` 彈窗拍板，同意後帶 `FLOW_GIT_OK=1` 重跑才放行；非 Flow 專案（無 `.flow/`）也生效。

> 「task 標完成」的驗證把關由 **`flow-state done` 自帶閘門**單點負責（`verify`/`tdd` 空/`none` exit 2、綠燈歸零防白嫖）——內建 TaskCreate/TaskUpdate 清單已自流程拔除（session-scoped 不落檔、與「狀態進檔案」原則相悖，且其前哨 hook 與 done 閘門同語意重複）。

## Script 閘門（SHALL 跑，exit 2）

- **`flow-state spec-ready`**（凍結前）——`### 開放問題` 段缺失/沒清零、缺 `REQ-`/`REQ-E2E-`/`REQ-PERF-`、placeholder（TODO/待定）、REQ-E2E 缺 journey 結構、PERF N/A 無 perf-waiver 豁免檔就 exit 2。**`--freeze`** 通過才寫 `spec-done`，另對賬：`project-type` 落檔（web 類須過走查台＋`ui-signoff` 定版記錄或 mockup-waiver；非 web 即豁免）＋ **lens 審查收斂**（redteam/consistency 各 ≥2 輪末輪零新發現、docHash==現行文字、findings 全終局——`spec-review`/`review-resolve` 的機讀 ledger（診斷：`diagnose review`），細節 `references/spec-review-loop.md`）。凍結瞬間落 `.flow/trace/req-index.json`（REQ 全集＋requirements hash＋HEAD）＝下游唯一分母；原型存在時另落 `.flow/trace/mockup-index.json`（`specs/ui-mockups/` 文字資產逐檔 hash）＝**mockup 定版分母**——凍結後偷改原型在下一道消費閘門（plan-check/wave/ui-fidelity）被 hash 對賬抓。**重凍結另驗 ui-signoff 新鮮度**：定版記錄時戳未嚴格晚於上次凍結（沿用舊拍板）exit 2——mockup 修正 SHALL 原地改 `specs/ui-mockups/`（禁另開副本），且每次重定版都要使用者重新走查拍板。
- **`flow-state mockup-check`**（UI 定版前）——互動原型走查台缺任一 `REQ-E2E-*` 卡、本地連結 404、或頁面空殼（無 `app.js`/互動元素）exit 2。
- **`flow-state plan-check`**（plan 出口）——REQ↔task 覆蓋（每條 REQ 被承接、無幻覺 id）＋tasks.md↔manifest 逐欄一致（含 `mockupPages`）＋requirements hash 對賬＋**mockup 鏈路（原型存在時）**：mockup-index hash 對賬＋design.md「UI 對焦結論」節存在且逐頁提及＋每個原型頁被某 task 的 `mockupPages` 承接（幽靈頁/漏承接點名），過了才落 `plan-check.json`＋`phase=plan-done`。
- **`flow-state wave --compute`**（build 起手）——算波次拓樸（blockedBy 依賴序＋conflictZone 互斥拆波，成環/懸空 exit 2）＋逐字抽每 task 承接的 REQ 區塊落 `wave-plan.json`（含 manifest/reqHash）＝dispatch 唯一事實來源（worker 收逐字 spec、不自讀防漂移）；buildWavePlan 內建 reqHash↔req-index 自我斷言。原型存在時先對賬 mockup-index（漂移 fail-closed），並附 **UI 投餵**：`wave-plan.ui`（`tokensPath` 路徑契約＋`designBase`，不存 tokens.css 全文）＋per-task `mockupPages`——dispatch 時讀 `tokensPath` 全文自組 `args.ui.tokensCss` 傳 recipe，worker prompt 硬性「先讀承接原型頁、沿用版面/tokens、改版面＝BLOCKED」。**首件檢驗**：已交付 task 承接的原型頁缺視覺比對記錄／有 fail／判的是舊原型 exit 2（別讓平行波把系統性走樣複製進下一波），豁免走 **ui-compare-waiver** decision（整包降級人工對照，附警告）。
- **`flow-state scope --wave`**（整合前）——worker 改到宣告 `conflictZone` 之外 exit 2（用 git 真實變動，模型偽造不了）；**git 不可用/失敗＝fail-closed exit 2**（查不到≠零變動）；另對賬「本波成員＝wave-plan 某波、manifest 未漂移」。
- **`flow-state redteam --wave`**（整合前）——紅軍 high 攻擊未全 `covered`、`testFile` 不實存/空殼、高危關鍵字攻擊無痕 skipped（無 redteam-waiver decision）exit 2。
- **`flow-state journey-check`**（web 宣稱綠前）——掃 Playwright 測試檔：mock/網路攔截（page.route/MSW/nock/cy.intercept/mockResolvedValue）或單 test >1 `goto` exit 2；playwright.config 的 retries 非 0（無 retry-waiver）/dev server 也擋。合法 mock（第三方 sandbox）可經 **journey-waiver** decision 降級為警告。**0 個 journey 測試檔時落 `noTests:true` 記錄**（供 `complete-check` 的 `e2e-waiver` 判定）。**通過即落 `.flow/trace/journey-check.json`（綁 HEAD）**。
- **`flow-state verify-e2e` / `verify-perf`**——pass 證據 SHALL 指向**實存非空檔**（trace/測試檔/量測報告；純敘述先存檔再 `--evidence-file` 指過來）；n/a 須綁實存 decision 且不得跨 REQ 重用；自動記 HEAD/reqHash。
- **`flow-state ui-fidelity`**（web 類 verify/ship 宣稱綠前）——mockup 定版快照漂移（不可豁免，還原或重定版）、或定版 `tokens.css` 變數在實作**零引用**（UI 基準被整組丟棄；實作端合法不用 CSS 變數經 **ui-fidelity-waiver** 降級為警告）exit 2。**通過即落 `.flow/trace/ui-fidelity.json`（綁 HEAD）**。誠實邊界：只守確定性底線，「版面像不像」由 Evaluator（鐵則 6）/藍軍（維度 10）對照原型頁人工判。
- **`flow-state ui-compare`**（web 類 verify/ship 宣稱綠前，逐頁）——Evaluator 寫 `.flow/trace/ui-compare/map.json` 後跑 `ui-compare-capture.mjs`（截圖腳本自帶「mockup 未凍結/快照漂移」exit 2 閘門），雙 viewport（1440x900＋390x844）fullPage 截圖存 `.flow/trace/ui-compare/`＋落 `capture.json`；Evaluator 逐頁多模態對照後 `flow-state ui-compare <page> --status <pass|fail|n/a>` 落 `.flow/trace/ui-compare.json`——pass 前提＝capture manifest 實存＋該頁雙邊截圖逐檔實存＋截的是現行凍結版原型；fail SHALL 附 `--note`；n/a SHALL 綁實存 decision 且不得跨頁重用。**`complete-check` 逐頁對賬**：mockup-index 每個 `pages/*.html` 都要有記錄、無 fail、判現行凍結版原型；豁免走 **ui-compare-waiver** decision（整包降級人工對照，附警告）。
- **`flow-state complete-check`**（ship 出口）——tasks.md 全 `[x]`＋requirements.md 實存且 hash==凍結分母（**req-index 必須實存**，缺=exit 2）＋逐條 `REQ-E2E-*` pass/n-a＋`REQ-PERF-*` 達標記錄＋plan-check manifest 未漂移＋藍軍 code-review red flag 全終局（或 code-review-waiver）＋**web 類須有當前 HEAD 的 journey-check 記錄**（或 journey-waiver）＋**web 類有互動原型須有當前 HEAD 的 ui-fidelity 記錄**。**0 條 `REQ-E2E-*`、或 journey-check 掃到 0 個 journey 測試檔（落 `noTests:true`）時須有 `e2e-waiver` decision（附理由）才放行；有 ≥1 條 `REQ-E2E-*` 時該 waiver 無效**。`REQ-E2E-*`/`REQ-PERF-*` 的 pass 證據若記錄 HEAD 之後原始碼又改過 → 擋、要求重驗（與 code-review 新鮮度同款）。全過即落 `.flow/trace/complete-check.json`（Stop hook 認這筆）。
- **`flow-state done <id>`**——自帶閘門：state.json `verify`/`tdd` 空/`none` exit 2；交付即歸零綠燈（下個 task 須有新綠燈）；順手把已終局 task 的 journal 事件歸檔到 `.flow/archive/`（歸檔不刪）。
- **`flow-state mode auto`**——自帶 guardrail：settings.json 須同時掛 flow-stall-monitor＋flow-auto-gate，缺任一 exit 2 拒寫（啟動前提是機器擋、不是提醒）。
- **`flow-state run --task -- <cmd>`**——真跑 runner 綁 taskId 落 journal＝done 閘門認得「真跑綠」（換命令洗綠不算）；完整輸出落 `.flow/reports/run-<task>-<ts>.log`，主 context 綠時只回摘要行、紅時回尾段＋路徑。

## 非阻擋偵測節點（注入 additionalContext，不 exit 2）

- **flow-stall-monitor**（PostToolUse: Bash/PowerShell）——讀 runner 真實 exit code 記 journal，同失敗連 ≥N 輪注入 STALL 升級＝自駕 doom-loop 斷路器（硬天花板在 auto-gate）。
- **flow-size-check**（SessionStart＋**PostToolUse: Write|Edit**）——specs/*.md >50KB 提醒 `/flow-compact`；PostToolUse 掛載讓自駕連續多輪不打字也不失明（只在寫 specs .md 時才量，其餘秒回；A6 移除 UserPromptSubmit 掛點——膨脹必經寫檔，每句話一次冷啟的邊際價值近零）。
- **flow-session-start**（SessionStart）——reconstruct 注入完整現況（計數/mode/checkpoint/對帳/下一步）＋**安裝自檢三件**：hook 接線對賬（hooks 目錄實存的 flow-*.mjs 沒被 settings.json 註冊＝醒目警告）、dist↔安裝區**雙向內容對賬**（hash 不一致附方向提示：安裝區較新→回寫 dist / dist 較新→重裝）、`CLAUDE_CODE_SUBAGENT_MODEL` 環境變數偵測（它優先權最高、會靜默蓋掉整套模型路由）＋git 原生 pre-commit 兜底冪等安裝。

## 崩潰容錯

`.flow/` 所有 JSON 原子寫（temp+rename）；`flow-state checkpoint <id> --phase` 記 mid-task 進度（PreCompact hook 會自動補）；done 交付歸零 `verifyTaskId` 堵「綠燈沒歸零→下個 task 白嫖」；journal「歸檔不刪」（`.flow/archive/journal.ndjson`，`journal-archive` 可手動觸發）讓 stall/done/reconstruct 讀取維持 O(近期)。

## git 原生 pre-commit 兜底

flow-session-start 於每個 Flow 專案冪等安裝 repo 級 pre-commit（marker 不覆蓋既有 hook、`core.hooksPath` 改向醒目警告不硬裝、卸載守衛防 brick commit、首裝主文告知），把 secrets/驗證垃圾兩道也擋在「不經過 Claude 的 commit」（手動/worker 子行程/npm script/MCP）＝封 PreToolUse 攔不到的整批繞法。
