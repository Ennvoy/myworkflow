# Flow 全面優化路線圖（2026-07-06 Fable 體檢）

## 落地狀態（同日出貨，v0.27.0）

**已出貨**（使用者拍板第 0-4 波全做＋journal 翻案＋審查 agent 維持 opus 釘 effort:xhigh）：
- 第 0 波全部（W0-1～W0-4）＋新增 **W0-5 dist↔安裝區雙向同步對賬**（取代 plugin 打包的便宜替代，見下）。
- 第 1 波全部（W1-1～W1-6；W1-6 結論：effort 參數已驗證生效、非 no-op，量化差異留待 API 層量測）。
- 第 2 波全部（W2-1 憲法 14678→9004 bytes −39%；W2-4 flow-build.md 17957→10131 bytes −43.6%；W2-7 以「1h cache 適用準則」記進 orchestration-guide、先量測再開）。
- 第 3 波全部（W3-1～W3-5；W3-6 以散文升級＋decision 留檔落地，未加硬閘門——既有高危 regex 為攻擊文字調校、硬搬需求文字會誤殺（Goodhart））。
- 第 4 波精選（W4-1/W4-2/W4-3）＋ W4-4 journal 歸檔（使用者翻案核准）。
- 測試 268 → **290 全綠**；新增 hook：flow-stop-gate、flow-precompact；新增 reference：gates-reference、finding-discipline、build-playbook。

**Fable 重新裁決的三個 L 級大項**（使用者要求重新思考後定案）：
- W5-4 worktree hybrid → **降級為休眠**：無數據證明 T1 觸發條件（TS＋波寬≥3）常被踩到；W5-3 波級 tsc 是便宜的 80% 替代。等 wave-plan 真實記錄累積證據再啟動。
- W6-1 plugin 打包 → **不做，以 W0-5 sync-check 取代**：使用者「臨場熱修安裝區」的工作流是健康的，plugin 會讓它更難；病根是「漂移無感」，偵測已治。Flow 若日後要發佈給其他人再回頭評估。
- W4-6 R10 波界重啟 → **維持北極星、先觀察**：PreCompact checkpoint＋journal 歸檔＋憲法瘦身已讓 auto-compact 接近「安全半換腦」；跑一兩個真實自駕專案後若後段仍鈍化（stall 記錄可見）再動工。

**未做**（未被選入本次範圍）：第 5 波 W5-1 parallel-verify web 分桶、W5-2 hook dispatcher 合併、W5-3 波級 tsc——留待下次以牆鐘速度為主題的 session。

> 方法：21 代理體檢 workflow（9 Sonnet 讀者逐子系統深讀 → 6 Opus 互異 lens 批判 → 6 Sonnet 逐條對抗查證），加指揮官層兩次確定性比對（dist↔部署 hash diff、部署 settings.json 接線核對）。55 條 findings：36 valid／17 valid-with-caveats／2 previously-rejected（已擋下不列）。
> 本檔為實作藍本；「刻意不做」清單（harness-correctness-plan.md §5：S5 canary、T4 DOM 錨點、plan best-of-N、self-consistency 投票）本次全數迴避、無重提。

## 0. 體檢當天已完成

- ✅ **statelib 熱修回同步**：部署區 07-04 熱修（`parsePerfBudget` 千分位逗號 `1,000ms`＋回歸測試）未回寫 dist，已複製回 dist、hash 一致、全套 **268 測試綠**。此為「手動同步必漂移」第 2 個實證（第 1 個見 W0-1）。

## 第 0 波「止血」——線上正確性缺陷（S，當天可逐項出貨）

| 項 | 機制 | 證據 |
|----|------|------|
| W0-1 **flow-auto-gate 未接線**（本次最高嚴重度） | 部署 `~/.claude/settings.json` 的 PreToolUse `Bash\|PowerShell` matcher 只掛 flow-commit-gate，缺 flow-auto-gate（檔案實存但沒登記）→ 自駕三道硬閘門（裝新相依彈窗／破壞性 DB 擋下／doom-loop 硬天花板）**在真實環境完全不觸發**。修：補回接線一行 | dist settings.flow.json:21-24 vs 部署 settings.json:15-21，三個 lens 獨立發現＋查證確認 |
| W0-2 **hook 接線自我對賬** | flow-session-start 既有 VERSION 漂移偵測旁加一段：比對 settings.flow.json 期望 hook 清單 vs 部署 settings.json 實掛，關鍵閘門缺掛即 SessionStart 醒目警告（fail-open、唯讀）。防 W0-1 同類 silent failure 再發生 | flow-session-start.mjs:39-54 已有可比照的漂移偵測基礎 |
| W0-3 **mode=auto 強制 guardrail-check** | `flow-state mode auto` 目前只 console.log 提醒（flow-state.mjs:204），不真的跑 guardrail-check。修：抽共用函式、未過 exit 2 拒寫 mode=auto | autonomous-mode.md:38 SHALL 是純散文；「自駕啟動前提」目前無機器擋 |
| W0-4 **CLAUDE_CODE_SUBAGENT_MODEL 偵測** | 此官方環境變數優先權高於 frontmatter model，被設即靜默蓋掉整套「Opus 審查／Sonnet 苦工」路由。併入 W0-2 對賬：非空即警示＋orchestration-guide 記一筆已知風險 | 官方 model-config 解析順序文件 |

## 第 1 波「模型／effort 路由落地」——頂模只當指揮官

| 項 | 機制 | 證據／備註 |
|----|------|-----------|
| W1-1 **五個 agent 定義檔補顯式 effort** | code-reviewer/evaluator/red-team → `effort: xhigh`；spec-consistency/spec-redteam → `effort: high`。目前五檔只有 `model: opus`、effort 隨 session 漂移 | 官方 subagent frontmatter 支援 effort；orchestration-guide 的分級紀律只覆蓋 recipe agent()、管不到 Task 型 subagent |
| W1-2 **Haiku 第三級落地** | 三級路由表（Opus/Sonnet/Haiku）是文件承諾、程式碼零實作（grep 全 dist 無 'haiku'）。落地：research-sweep.js sources 加 kind 欄（extract/lookup 純擷取→haiku 約 $1/$5，比較/綜合→sonnet $3/$15）；legacy 掃描類窄活同理 | 同預算 fan-out 更寬；保守只對「真純擷取」降級 |
| W1-3 **resume/compact 雜務下放** | flow-resume（讀 reconstruct→轉述）與 flow-compact（機械歸檔）推理含量極低卻由頂模親跑。在兩命令檔明訂：轉述/搬移段 spawn Haiku/Sonnet subagent，只有「待決策彈窗」留主迴圈 | 比照 flow-build.md:47 workerModel 現成範式 |
| W1-4 **路由表升級 Claude 5 家族** | orchestration-guide 路由表更新：指揮/自駕主迴圈=跟隨 session 主模型（Fable/Opus 級）、對抗審查=Opus 不降級＋釘 effort、苦工=Sonnet、窄活=Haiku；一律參數化不 hardcode | 主 orchestrator 已跑在使用者 session 模型上；agent 檔 model 是否試 fable 屬使用者決策（見決策點 D3） |
| W1-5 **指揮官紀律三件（context firewall 補洞）** | ① build 整合迴圈的 lint/tsc/unit sensor 輸出進便宜 subagent／script 蒸餾（只回 pass＋前 N 條錯誤），不再灌主迴圈；② ship Step 2/3（整合 e2e＋完整 perf）綁 evaluator/parallel-verify recipe（=路線圖 R7）；③ plan 的 codebase 盤點走 research-sweep fan-out（=wf2 裁決 v1-A，最高槓桿） | 高噪音輸出稀釋頂模決策視窗（>60% 變笨）；三項皆已有現成 recipe/機制可掛 |
| W1-6 **effort 生效 smoke（一次性）** | orchestration-guide 自承 effort 不支援時「靜默 no-op」，全 repo 無生效自檢。做一次 low vs high 對照，結果記錄，把成本主張變已驗證事實 | 一次性成本、永久收益 |

## 第 2 波「context／token 減稅」——always-on 瘦身與文件去重

| 項 | 機制 | 預期效益 |
|----|------|---------|
| W2-1 **rules/flow.md:63 下沉** | 單行 6.7KB 閘門巨段（佔全檔近半）搬到 references/gates-reference.md；root 只留「9 道閘門清單＋各一句用途＋指標」10-15 行。root 憲法自己寫「刻意保持薄」卻被此行撐爆 | 14.7KB→~9KB，每 session（含非 Flow 專案）常駐 token 直降；全 harness 最大單點稅單 |
| W2-2 **五階段敘述 vs skill description 去重** | rules/flow.md:6-12 與每 session 自動注入的 skill 清單描述幾乎逐字重複（雙重常駐）。flow.md 側改精簡表、完整敘述唯一留在 skill description | 再省 30-40% 該段字數、零資訊損失 |
| W2-3 **文件互抄收斂** | ① clean-verify 說明 build/verify/ship 三檔逐字重複→只留指令＋一行連結；② 驗證三鐵則 evaluator.md/playwright-template/playbook 三處重述→單一事實來源；③ findings 紀律（上限/去重/終局）五檔各寫一遍→抽 references/finding-discipline.md | 規則異動只改一處、消除漂移；對齊 P3 backlog 既有記錄 |
| W2-4 **flow-build.md 瘦身** | 17.9KB 為 8 檔最大，未套 flow-spec.md 已驗證的「骨架留本文、細節丟 references」模式。抽 fan-out prompt 模板/checkpoint 語法段 | 自駕多波次時 build 命令文字常駐 context 的稅 |
| W2-5 **過時文件修正** | architecture.md 狀態機（只畫 5 欄、沒有 req-index/wave-plan/plan-check/redteam/code-review）補「.flow/ 現況地圖」；README hooks 清單 6→實際 11 支實作檔 | 純文件、零常駐代價、消除誤導 |
| W2-6 **statelib 重複函式合併** | extractAllReqIds/extractReqE2E/extractReqPerf 三個同構抽取函式→泛函式；三處「掃到下一 REQ/標題為止」區塊擷取（343/746/847）→共用。約省 40-60 行 | 消除「三處改一漏二」風險；268 測試回歸即可驗證 |
| W2-7 **1-hour cache 評估** | flow-build 背景波次/長訪談迴圈若單輪間隔常超 5 分鐘，評估 `ttl:"1h"`（寫 1.25x 換讀省 90%）；另評估波次 worker 共用前綴（design.md 接縫/公共 REQ）抽穩定 cache 前綴 | 需先實測間隔常態再決定；不動 W3-2 防漂移設計 |

## 第 3 波「閘門補洞」——把剩餘散文 claim 點與 fail-open 收乾

| 項 | 機制 | 備註 |
|----|------|------|
| W3-1 **complete-check ⊕ journey-check** | journey-check 通過落 .flow/trace/journey-check.json（HEAD 綁定），complete-check 對 web 類 projectType 對賬其存在，缺即 exit 2（可附 journey-waiver）。目前 web 專案可從未跑防假綠檢查就出貨 | 與 code-review forcing function 對稱 |
| W3-2 **verify-e2e/perf pass 證據驗真** | pass 目前只驗 evidence 非空字串（全 CLI 最鬆自報）。升級：evidence 可解析為檔案路徑則驗實存非空；純敘述須 --evidence-file 指向實存檔，拉到與紅軍 testFileProblem 同強度 | n/a 路徑 W2-3 已收緊，唯 pass 未比照 |
| W3-3 **三處 fail-open 收斂** | ① gitChangedFiles 失敗吞成 []→scope --wave 在 git 不可用時 exit 2（fail-closed）；② buildWavePlan 加 reqHash==reqIndexHash 自我斷言（一行縱深防禦）；③ 已凍結專案的 req-index/wave-plan 快照缺檔即 exit 2（向後相容只留給從未凍結者） | 查證確認：檔案位置引用需以 flow-state.mjs 為準 |
| W3-4 **journey-waiver 逃生口** | journey-check 的 mock/goto 偵測目前無 waiver（retries 檢查已有），攔第三方 analytics/金流 sandbox 的合法 page.route 會逼使用者關閘門。加 journey-waiver decision（限外部服務 mock、留檔可稽核） | 防「誤殺疲勞→自廢武功」 |
| W3-5 **Stop / PreCompact hook** | ① Stop：mode=auto 且無當前 HEAD 的 complete-check 通過記錄即 exit 2 擋收工（fail-open on 讀取失敗、只在 auto 生效）；② PreCompact：有進行中 task 即強制落 flow-state checkpoint，防壓縮丟「做到第幾步」 | Flow 目前只用 4/20+ 官方事件；此二者把散文承諾升 exit-2 |
| W3-6 **高風險 SHALL 步驟落 decision 對賬** | 只對高風險者強制（flow-spec Step4 安全審查），其餘（plan Step1.5/4.5、build 就緒探針、ship codex 建議）軟提示即可，防儀式性 decision（Goodhart） | 拉齊同檔 Step1 關鍵字強制 vs Step4 僅建議的不一致 |

## 第 4 波「自駕長程」——loop 不腐化、停等體驗

| 項 | 機制 | 狀態 |
|----|------|------|
| W4-1 **R1：size-check 加掛 PostToolUse(Write\|Edit)** | 自駕不打字即整段失明的已知痛點；只對 specs/*.md 寫入 stat、沿用 SIZE_REGROW 節流 | 路線圖 R1，最高槓桿 S 項 |
| W4-2 **R3：dependency 預核准 .flow/policy.json** | allowlist 內套件放行＋自動落 decision 審計；清單外仍 exit 2 彈窗。W0-1 修好後 dep 停等會立刻變日常摩擦 | 路線圖 R3；沿用「pnpm 免問、npm/yarn 彈窗」既定判準 |
| W4-3 **T1 停等主動喚回** | T1 彈窗逾時（60s 關窗鐵則死等）→ PushNotification 推播「自駕碰 T1 需拍板：一句話」＋重新彈窗循環，直到回答。先確認 harness 是否已因 inputNeededNotifEnabled 自動推播、避免重複 | 新機制；把「死等」升級成「主動喚回＋問題常駐」 |
| W4-4 **journal.ndjson 歸檔治理** | append-only 無 CAP（對比 lessons CAP=5），stall/done/reconstruct 每次 O(全史) 重讀。仿 flow-compact「歸檔不刪」：delivered 事件搬 .flow/archive/，主檔留近期＋未 delivered | ⚠️ 先前判「低優延後」；新事實（W0-1 修復後自駕真長跑＋每 session reconstruct 全史）支持翻案，**需使用者裁定** |
| W4-5 **R11：opt-in autoBudget** | 自駕起手可設 token 上限（.flow/policy.json），逼近即暫停彈窗；與 stall 斷路器互補（總量 vs 迴圈） | 路線圖 R11，預設關 |
| W4-6 **R10：Ralph 波界 fresh-context 重啟（北極星）** | 波次完→checkpoint/歸檔→新 context 從 reconstruct 續跑，根治單條 context 硬撐到出貨的稀釋。依賴 W4-4＋接手品質先穩 | L 級，列入路線圖、另約時段 |

## 第 5 波「牆鐘速度」

| 項 | 機制 | 狀態 |
|----|------|------|
| W5-1 **parallel-verify web 桶分批** | kind:'web' 分桶 chunk 2-3 序列批跑（headed 禁多開），api/perf 維持全平行；加 args.webConcurrency | P3 backlog，S 項可先出 |
| W5-2 **hook dispatcher 合併** | 每次 Bash 呼叫冷啟 3-4 支獨立 node hook（Windows 冷啟 50-150ms/支）。合併成單支 flow-dispatch.mjs 一次讀 stdin/state 依序判定；嚴守 fail-open＋各 exit-2 語意＋dispatcher 自測 | 新發現；長程自駕數百次呼叫的牆鐘稅 |
| W5-3 **波級 tsc／build 重用** | TS＋波寬≥3：整包 type-check 從逐 feature N 次改整波 1 次（或共用 incremental tsbuildinfo），保留單元測試層 fail-fast | P3，與 W5-4 牽制、宜同做 |
| W5-4 **worktree hybrid 落地** | 已裁決 adopt-hybrid（T1/T2/T3 觸發、squash-merge harvest、pnpm 免問）；新事實：EnterWorktree/ExitWorktree 工具已可用，落地阻力下降 | L 級，列入路線圖、另約時段 |

## 第 6 波「根治」

| 項 | 機制 | 狀態 |
|----|------|------|
| W6-1 **plugin 打包** | 以 plugin manifest 宣告 hook 接線/commands/agents/skills，根治手動同步漂移。本次兩個實證：statelib 熱修未回寫＋auto-gate 接線缺失 | L 級；改變部署方式需彈窗拍板 |

## 已擋下不做（本次查證確認）

- **無進展工具計數斷路器**（純編輯迴圈偵測）：先前已決議改用 RUNNER_RE 擴含＋誠實標註涵蓋面，不重提。
- **coverage/code-check/review-check 子命令刪除**：查證發現 flow-spec.md:90／flow-verify.md:70 有文件化呼叫點，非零引用，**不刪**。
- harness-correctness-plan.md §5 全清單（S5/T4/V3/self-consistency/mutation 先緩）維持不做。

## 落地順序建議

```
第 0 波（止血）──────► 全部獨立、當天逐項出貨（W0-1 最優先）
第 1 波（路由）：W1-1/W1-2/W1-6 獨立可先；W1-5 三件各自獨立
第 2 波（減稅）：W2-1→W2-2 同檔連動；其餘獨立
第 3 波（補洞）：全部獨立；W3-1/W3-2 價值最高
第 4 波（長程）：W4-1/W4-2 先；W4-4 需拍板；W4-6 依賴 W4-4
第 5 波（速度）：W5-1 先；W5-3/W5-4 同做
第 6 波（根治）：獨立、最後
```

紀律沿用：新 script 邏輯進 statelib 純函式＋補單測；escape 一律過 decision 檔；root 憲法淨增長 ≤0（W2-1 是淨減）。
