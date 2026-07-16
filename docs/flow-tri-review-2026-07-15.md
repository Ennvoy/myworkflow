# Flow 三模型家族體檢報告（2026-07-15）

> 使用者指令：「用 fable+codex+agy 檢查 flow 流程，找出可優化方向：工作效率、精準度、過度規範限制等」。
> 本檔為裁決藍本；機讀 clusters 全文見 `docs/research/tri-review-2026-07-15-clusters.json`。

## 方法與統計

| 軍團 | 配置 | 產出 |
|------|------|------|
| **Fable 家族** | Workflow 69 agents：7 Sonnet 讀者逐子系統深讀 → 5 個互異 lens（效率/精準紅軍/解規制/長程自駕/簡化）Fable xhigh 批判 → 合併 → 每條雙 Opus 對抗查證（refute＋value） | 28 條（19 confirmed／9 partial／0 refuted） |
| **Codex（GPT-5.4）** | 獨立 runtime 深審 29 分鐘，全量讀 dist 核心 | 15 條（CX-1~15，9 high） |
| **Gemini 3.5 Flash (High)** | agy CLI，10 個 ≤26KB 切片、兩波平行 | 75 → 去重 71 條 |
| **合流驗真** | Workflow 45 agents：Fable 聚類 → Codex/Gemini 獨有 44 條逐條 Opus 對抗驗真 | **73 聚類：50 存活（28 Fable-verified＋7 confirmed＋15 partial）、22 refuted、1 known-baseline** |

**指揮官層確定性檢查**：全套 292 測試綠、dist↔安裝區 hash 無漂移（僅 3 個本就不部署的檔案不在安裝區）、hook 早退牆鐘實測 1.3–5.1s/支（詳 C-3）。

**三家共識總評**（Codex 原話，Fable/Gemini 同向）：
> Flow 的優勢是把規格、拓樸、scope、紅軍與完成條件大量落成可稽核檔案；弱點是常把「**記錄存在**」當成「**行為發生**」——新鮮度、授權與 state/manifest 雙軌仍有高風險洞，且小任務儀式偏重。

**跨家族命中榜**（≥2 家族獨立發現＝最高可信）：
- 三家全中（FCG）：C-1 stop-gate 放行面、C-2 mode split-brain、C-10 done 閘門自我聲明、C-11 pass 證據不驗內容、C-12 findings 最低數量 Goodhart
- 兩家命中：C-3 hook 稅（FG）、C-13 doom-loop 偵測洞（FG）、C-14 spec 彈窗疲勞（FG）、C-5 auto-gate 間接繞過（CG）、C-16 design-base-hint 重複注入（CG）、C-42 T1 喚回無退避（FG）、C-46 憲法殘餘重複（FC）、C-47 size-check 高水位（FG）等

---

## Wave 0 止血——「護欄假在線」（全部 worth=yes，多為數行級修正）

| # | 問題 | 修法（經驗真裁決收斂） |
|---|------|------|
| **C-2** (FCG, high) | **mode 雙倉 split-brain**：mode 雙寫 manifest.json(git)＋state.json(gitignored)；fresh clone 後 resume 顯示「🤖 自駕」照跑，但 auto-gate/stop-gate 只讀不存在的 state.json 即 fail-open——dependency／破壞性 DB／doom-loop／收工攔截四道護欄**靜默全滅**（statelib.mjs:1303-1305、flow-auto-gate.mjs:71-75、flow-stop-gate.mjs:23-26）。這正是雙寫設計自己要解的換機場景 | 兩支 hook 判 mode 加 manifest fallback（各約 1 行，與 reconstruct 同優先序）；flow-resume 自駕續跑分支加 SHALL 重跑 guardrail-check；長期收斂單一事實來源＝manifest（牽動測試，列後續） |
| **C-1** (FCG, high) | **自駕靜默斷氣零偵測**：stop-gate 對 mid-run 收工一律放行（flow-stop-gate.mjs:27-32 註解明載），模型疲乏/context 結束半路收工＝整夜自駕無聲死掉；另 cc.head 或當前 head 為空即放行終局檢查 | mode=auto 且尚有可推進項時首次 Stop exit 2 擋下並指路（繼續/T1 重彈/mode manual）；先確保 needs-decision 可靠標記防誤擋合法停等；修 cc.head 判定為「兩者皆非空且相等」 |
| **C-8** (C, med) | **模型可自造 user waiver**：不經 AskUserQuestion 即執行 `flow-state decision *-waiver`，CLI 記成使用者拍板、關閉 perf/code-review/journey 出口閘門（flow-state.mjs:432-440） | 驗真裁決：auto-gate 攔 waiver 建立（僅 mode:auto、一行 regex）逼進 T1 同步彈窗；「不可偽造 receipt」屬過度設計不採 |
| **C-9** (C, med) | **complete-check 不要求 plan-check.json**：pc 缺失直接跳過，計畫出口對賬可整段略過（flow-state.mjs:651-654 vs flow-ship.md:38 宣稱） | clone 既有 waiver 樣式：pc 缺失 exit 2＋一次性 migration waiver；約 5 條既有測試需補 decision |
| **C-17** (F, med) | **tasks 全 [x] 只數純文字**：一次 Edit 全翻 [x] 即過完成謂詞第一條；現成 reconcile()（statelib.mjs:1316-1336）就差一個呼叫沒接上 | 謂詞①追加 reconcile 對賬：checkedButNotDelivered 非空 → exit 2 列清單指路 `flow-state done <id>`（一行整合＋ledger 非空 guard） |
| **C-21** (F, med) | **對抗代理 effort 靜默降級**：recipe 預設 `high` 顯式覆蓋 frontmatter 的 xhigh（parallel-build.js:30、EVAL_EFFORT 同款）——憲法「對抗審查不降級」被推翻，三個對抗代理兩個實跑 high | 呼叫端不傳 effort 讓 frontmatter 生效；recipe 註明「effort 由 agent 定義檔釘死勿覆寫」 |
| **C-22** (F, med) | **spec Step 4 高風險安全審查是純散文 SHALL**：spec-ready --freeze 不對賬 security-review decision，漏做與沒觸發不可區分（flow-spec.md:47） | 命中判定做進 freeze：沿用 isHighRiskAttackText 詞庫（擴中文同義詞），命中且查無 decision → exit 2；未命中也印稽核線 |
| **C-26** (C, med) | **出貨後 SessionStart 永久提示未出貨**：briefStatus 只讀 manifest.phase，allDelivered 但 phase≠shipped 即判 hasWork（statelib.mjs:1383-1394） | shipped 寫入移進 complete-check CLI（原子寫 manifest.phase）而非留散文步驟；補 3 處讀取點 phase 判斷。與 C-2 單一事實來源同方向宜一起設計 |

## Wave 1 精準度硬化——把「記錄存在 ≠ 行為發生」收乾

| # | 問題 | 修法 |
|---|------|------|
| **C-10** (FCG, med) | done 閘門實為自我聲明：Write 假造 `verify="ok:anything"`、`tdd="n/a"`、省略 verifyTaskId 即零成本過關；spec-gate 不保護這三欄 | 採 Fable 方案②：spec-gate 擋 state.json 的 verify/tdd 裸寫＋正門改 `flow-state verify-ok` 子命令。勿裸套「ref 驗實存」（合法 ref 可為測試名會誤殺）。CX 的 verify receipt（runner exit/HEAD/hash）列長期 |
| **C-11** (FCG, med) | verify-e2e/perf 的 pass 證據只驗「檔案實存 ≥10 bytes」（flow-state.mjs:36-47），效能閘門可填假數字＋指任意檔；evaluator 可自標 n/a 跳過真驗 | 複用 testFileProblem 的內容關鍵字掃描：evidence 內容須抓到 --value 容差內數字或 REQ id 特徵；n/a 須預定義 waiver 或 complete-check 拋警告要求複核。排除 DOM 錨點做法（已裁決不做） |
| **C-7** (C, med) | 品質證據無新鮮度對賬：E2E/PERF/code-review 舊記錄可沿用到改壞後的新 HEAD（僅 journey-check 有 @HEAD） | 拆兩票：code-review 的 HEAD-diff 對賬優先做；E2E/PERF 的相關-diff 對賬較複雜緩後 |
| **C-19** (F, med) | journey-waiver 是全庫單一永久開關：一張 decision 降級所有測試檔違規＋跳過 journey-check@HEAD | 分階段：先加時間戳＋複核提醒；再改 waiver 記檔案 glob 逐檔比對；有 waiver 仍要求 journey-check@HEAD 跑過 |
| **C-13** (FG, med) | doom-loop 三洞：字面 token 分桶讓換寫法/加 flag/加 cd 每步歸零連敗；flow-state 閘門 CLI 連紅不偵測；zeroFail 覆蓋 Traceback 強失敗標記 | ① runnerBucket 正規化（去 cd 前綴、npm run test≡npm test）②sig 用正規化 bucket ③閘門子命令納入偵測 ④strong 命中時 zeroFail 不得覆蓋 |
| **C-18** (F, med) | hook 接線知識四處手工副本、兩處已漂移：uninstall 三入口（.mjs/.ps1/.sh）硬編 8 支 vs 實際 10 支——卸載後全域殘留指向已刪檔；README 11 vs 實際 13 | settings.flow.json 定唯一事實來源：uninstall 動態解析；README 改指標句；先加對賬測試防再漂 |
| **C-48** (F, low) | tasks.md id 正則對 T1-2/W0-5 型 id 解析 null：翻勾/對帳/閘門全鏈靜默失明（statelib.mjs:1020） | ID_RE 改 `[A-Za-z][A-Za-z0-9]*`＋單測釘 W0-5/T1-2；訊息升級為診斷式提示 |
| **C-54** (G, low) | worktree 下 pre-commit 兜底裝錯位置：`--git-dir` 指向 worktrees/<name>，hook 不執行 | 一行改用 `--git-common-dir`，零回歸風險，順手做 |
| **C-4/C-5/C-6** (CG, partial) | spec-gate／auto-gate／commit-gate 靜態字串比對繞過面（兩步腳本、緊湊寫法 `-m"msg"`、註解冒充、unicode 轉義、間接執行） | **僅採低成本子集**：spec-gate 正則排除註解＋正規化 \u 跳脫；commit-gate 修 `-m"msg"` 正則（連帶修假阻擋）；auto-gate 加 package.json 編輯 PreToolUse 攔阻＋文件誠實用詞（防懶不防蓄意）。cd/間接腳本繞過**不修**——威脅模型是防誤操作 |

## Wave 2 減稅——效率（token＋牆鐘）

| # | 問題 | 修法 |
|---|------|------|
| **C-3** (FG, high) | **Hook 稅實測**：每支早退 1.3–5.1s、Bash/PowerShell 呼叫疊 3 Pre＋1 Post ≈ 5–6s/call，單日 build session 純 hook 牆鐘 20–40 分鐘。病根疑似單機防毒掃 node（裸冷啟 0.97–1.4s）；另 SessionStart 每次全量 syncDrift | ① dispatcher 合併（已排程項）**升最高優先**；② node.exe＋hooks 目錄 Defender 排除實驗（需拍板）；③ 冷啟量測進 session-start 自檢（無條件值得）；syncDrift 改 srcVer≠instVer 才全量比對 |
| **C-23** (F, med) | complete-check 七大類逐類 fail-fast：自駕下每類失敗多耗一整輪「修→重跑」 | 改收集全部失敗統一列印最後 exit 2；保留三處前置 fail-fast |
| **C-41** (F/G, low) | lens 收斂寫死「各 ≥2 輪」：首輪零發現仍對同一 docHash 重跑，白燒 Opus | 輪數與 spec 規模掛鉤（REQ<10 放寬 1 輪）；增量評估僅核心變更重跑受影響 lens；同步改 statelib.test.mjs:1016 |
| **C-44** (FG, low) | subagent 委派無規模門檻：resume/compact/plan 盤點一律 SHALL 下放，小狀態時 spawn 反而貴 | SHALL 改門檻式（輸出 >2-3k token 或 task>10 才委派）；compact 機械搬移改 deterministic 腳本 |
| **C-24** (F, med, 需拍板) | build 每 feature 各 spawn Opus/xhigh Evaluator＋各自 production build 驗 happy-path smoke | 波級批次窄驗證選項（一次 evaluator 驗全波）；與已排程波級 tsc 合併評估、Ask-first 拍板 |
| **C-52** (F, low, 需拍板) | 每波無條件 deps install＋per-task 逐個 push | lockfile hash 未變跳過 ci；push 改每波一次（與「跨電腦即時接得上」衝突，需拍板＋resume 補「領先 remote」提醒） |
| **C-46** (FC, low) | 憲法級內容三四處詳略不一重複；architecture.md 拿過期「~67 行」自證薄 | 先做乾淨的：過期數字改相對描述、SKILL.md 摘要段改指標句；root 再瘦＋byte-budget 進 sync-check 需拍板 |

## Wave 3 解規制——過度規範（使用者特別點名的方向）

| # | 問題 | 修法 |
|---|------|------|
| **C-12** (FCG, med) | **findings 最低數量 Goodhart**：紅軍 minItems:3、code-reviewer 強制 5–10 項，與 finding-discipline「湊數比漏報毒」自相衝突；一行文案改動也要湊 3 個攻擊情境 | 整任務級 redteam-waiver＋insufficientReason（正式波次維持 minItems）；或改風險分級 coverage attestation：允許 0 finding 但須列已檢查維度＋排除證據；輕量路徑紅軍改條件觸發（API/DB/auth/輸入處理才跑） |
| **C-14** (FG, med) | **spec 彈窗疲勞**：異常路徑逐功能×6 類全量彈窗（隨功能數線性膨脹）、grill-me 獨立一彈、起手 phase 確認＋模式選擇兩連彈 | ① 異常改差集確認＋單一矩陣彈窗一次收（觸及核心 forcing function，需拍板）；② grill-me 併入最後一題、③ 起手合併單彈（可逕做） |
| **C-39＋C-47** (G/FG, low) | size-check 兩病：非 Flow 專案 marker 寫不進每次重複提示；/flow-compact 後高水位不重置、壓縮後再膨脹被悶掉 | 同檔一起修：hasFlow=false 直接 return（1-2 行）；over 為空且 maxBytes 明顯低於 marker 時重置 marker（約 3 行） |
| **C-49** (F, low) | 高危關鍵字 floor：low 攻擊提到 auth/token 就鎖進「湊測試或逐攻擊 waiver」二選一 | 僅取透明化：輸出分列「severity 觸發」vs「關鍵字觸發」兩種擋因；floor 硬度不動（反造假設計） |
| **C-16** (CG, low) | design-base-hint 註解宣稱「一專案一次」、實作是每個新前端檔一次 | 驗真裁決：per-file 是刻意設計，**只修註解措辭**，行為不動 |
| **C-32** (G, low) | 關鍵字命中即強制注入動態 RBAC：內部工具過度設計＋避詞 Goodhart | 用詞「強制注入」→「建議注入」軟化，不新增停點 |
| **C-43** (FG, low) | 互動原型無輕量檔位 | 裁決 worth=no 不動制度；僅純 API 專案 project-type 判定自動跳過 mockup-check（免手動 waiver） |

## Wave 4 文件級小補（半句～數行）

- **C-29**：Step 0.5 補半句澄清輕量路徑下 design.md 的簡化規範（增補一節或明示豁免）
- **C-33**：接縫契約鐵則尾端加跨語言 codegen 子句（OpenAPI/Zod→雙端型別），不升級閘門
- **C-58**：自駕護欄前置檢查補 Windows 可執行命令（對齊 flow-resume 風格＋UTF-8 前綴）
- **C-59**：prototype-guide 補一句「.ps1 須 BOM、web 資產用 Write/Node 無 BOM」
- **C-60**：Step 5.1 補一句「缺 ui-ux-pro-max 時繼續走內建 design-systems base tokens」
- **C-15**：plan-check 文件誠實標註「只驗 id 覆蓋、不驗實質」邊界（追蹤圖屬過度設計不採）
- **C-37**：自駕 T1 ①④ 的「事後抓」用詞誠實化，或把 decisions 交叉引用加進藍軍 review prompt
- **C-45**：auto-gate 相依偵測收單一表驅動＋extract 前截斷 shell 運算子＋parity 測試
- **C-51**：加測試斷言 help 集合==switch case 集合；補 journal-archive 進 help
- **C-20**：journey-check 對非字面 goto 加 warning 級提示（維持非阻擋）

## 不採納／已推翻（22 條，防未來重提）

驗真階段擋下的主要類型：
- **誤讀設計意圖**（Gemini 為主）：compaction「刪最新尾巴」指 context cache 非 spec 檔（C-56）；headed 走查本就非 CI 場景（C-70）；retries=0 反 flake 掩蓋是刻意（C-65）；對抗審查釘 Opus+xhigh 是憲法刻意取捨（C-67）；perf-waiver 儀式是防散文自決（C-62）；Prelude ≤3 是防膨脹 forcing（C-61）；1h cache TTL 並非虛構參數（C-66）
- **事實錯誤**：子目錄 .flow 判定失效（hook cwd 為 session 根，C-28）；redteam 檔名互覆（實為 task-scoped，C-40）；build manifest hash 炸 ship（C-35）；tdd 寫死 green 覆蓋 refactored（C-64）；spec 起始偵測漏 Phase 4 分支（C-30）
- **worth=no**：藍軍 findings 簽章層（防懶不防蓄意，C-25）；三套終局框架抽引擎（生命週期分歧，C-50）；isDestructiveDB 誤殺細修（ROI 低，C-55）；content-hash finding id（改動核心太大，C-71）；歷史 findings 擋 ship（誤報體質，C-53）

## 與已知分母的關係

- **hook dispatcher 合併**（前次排程未做）：本輪 C-3 附全新實測事證，建議升最高優先。
- **波級 tsc/build 重用**（前次排程未做）：C-24 與其合併評估。
- C-73（純編輯迴圈斷路器）維持前次「不做」裁決。
- worktree hybrid／波界重啟／plugin 打包等維持原裁決，本輪無翻案事證。

## 建議落地順序

```
Wave 0 止血（8 項，全 worth=yes，多為數行級）────► 最優先，可當天逐項出貨
Wave 1 精準硬化（9 項）────► C-10/C-11/C-7 價值最高；C-4/5/6 只做低成本子集
Wave 2 減稅（7 項）────► C-3③ 自檢先做；①② 與 C-24/C-52 需拍板
Wave 3 解規制（7 項）────► C-12/C-14 需拍板 trade-off；其餘小改
Wave 4 文件小補（10 項）────► 可併一個 commit 掃尾
```

紀律沿用：新 script 邏輯進 statelib 純函式＋補單測；escape 一律過 decision；root 憲法淨增長 ≤0；修 dist/ 後同步安裝區（sync-check 對賬）。
