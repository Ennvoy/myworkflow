# Flow Harness 正確性強化規劃（correctness-hardening）

> 2026-07-02 產出。目標：**(1) 每次 AI 開發產出穩定完全符合需求、不賭隨機性；(2) 需求訪談階段用互異角度反覆 review 到完全沒有問題才定版。**
> 產出方式：17 代理 workflow（6 子系統弱點掃描＋2 外部研究＋3 視角設計＋6 對抗評審），所有引用行號經評審實地核對。本檔為實作藍本，逐波拍板後照此落地。
>
> **進度**：第 0 波（止血，v0.22.0）＋agent 層 evaluator/red-team（v0.22.1）＋第 1 波（訪談多角度 lens 迴圈，v0.23.0）＋**第 2 波（全鏈路機器對賬，v0.24.0）已出貨**——每波皆經多代理對抗驗證修完真 finding 才 commit。第 3 波（執行期）待拍板。

---

## 0. 診斷：隨機性從哪裡漏進來

核心發現：**Flow 的閘門很多，但多數機器驗的是「模型自己寫的帳本」，不是「世界的狀態」。**

### 已核實的確定性漏洞（全部有 code 佐證）

| # | 漏洞 | 位置 | 後果 |
|---|------|------|------|
| H1 | requirements.md 整份不寫 `### 開放問題` 段 → `inSection` 永不觸發 → spec-ready **恆綠** | statelib.mjs:241 | 「問到清零才凍結」的根基是自報帳本 |
| H2 | `REQ-PERF-001：N/A` 一句話洗掉效能驗收 | statelib.mjs:253 | 效能硬閘門變散文 |
| H3 | web 專案不建 `specs/ui-mockups/` → --freeze 靜默跳過原型驗證；註解宣稱「已 decision 記錄」但 code 從不驗 | flow-state.mjs:408-411 | 整個 UI 定版閘門可被靜默繞過 |
| H4 | done 閘門的 verify 欄位只驗「非空非 none」，任意垃圾字串可過 | statelib.mjs:313 | 假綠最大殘留面 |
| H5 | complete-check 對 requirements.md 缺檔**只警告**（break） | flow-state.mjs:308 | 歸檔/改名 spec ＝ 整段 REQ-E2E 完成謂詞靜默關閉 |
| H6 | `scope --wave` 的 id 清單模型自選；zone overlap 只 console.log 警告不擋 | flow-state.mjs:186-219, 207-210 | 波次組成靠模型心算，錯一次＝誤燒 15x token |
| H7 | 紅軍 ATTACK_SCHEMA 無 minItems，回 1 個攻擊也合法；severity 自報調控閘門鬆緊 | recipes/parallel-build.js:34-46 | 對抗深度隨 run 浮動 |
| H8 | spec-reviewer「可選、單視角、一次性」，質疑帶回後是否落地**無對賬**；「需求完整度：低」不綁閘門 | flow-spec.md:33 | 「多角度反覆 review」實際是單次抽樣，且可被靜默丟棄 |
| H9 | 凍結後編輯 requirements.md 無任何 hook 擋（「凍結後不再回頭改」是散文） | interview-guide.md:52 | 下游對賬基準可被無聲抖換 |
| H10 | worker 投餵只給 req id 引用、worker 自己讀檔摘錄 | parallel-build.js:99 | worker 對驗收條件認知漂移＝產出不穩定的直接源頭 |

### 隨機性的結構圖景

- **最上游隨機源＝訪談**：問幾輪、問哪些題、何時宣告收斂、哪些含糊點被記進開放問題段——全是模型裁量。凍結版 REQ 集合不同＝下游 plan/build/verify 全部錨定不同 → 最終產品功能覆蓋隨 run 浮動。
- **收斂終點是散文**：「某一輪問不出新問題」（flow-spec.md:51）純模型自評。
- **下游無對賬鏈**：非 E2E 的 REQ 從 plan 起無任何機器守（可無聲蒸發到出貨）；Evaluator 對 EARS→測試的翻譯是自由發揮；verify 證據只驗非空。

### 外部研究的三個關鍵結論

1. **Nine Judges（arXiv:2605.29800）**：同模型換 persona 的評審錯誤高度相關（φ≈0.39），9 個評審只等於 2.18 張獨立票；換模型家族幾乎不增獨立性；前 5 個評審吃掉 90% 可得獨立性。→ **多角度審查必須來自「機制不同」的檢查**（script lint／對抗紅軍／斷開 context／跨家族 CLI／人眼走查），不是多開散文評審。
2. **OpenSpec `validate --strict`**：四家主流 SDD 工具中唯一真 exit-code 閘門，證明「驗形」路線（SHALL/結構/scenario 存在性的純 parser lint）完全可行。Spec Kit 的 9 類含糊分類法（功能範圍/資料模型/UX 流/非功能/外部整合/邊界失敗/限制取捨/術語一致/AC 可測性）可直接當訪談覆蓋分母。
3. **變異壓制槓桿排序**：checklist→script 化與 acceptance-test-first 是根基；traceability set-difference 對賬近零成本；self-consistency 投票對 frontier 模型已邊際遞減（20 樣本換 +0.4%，**不採用**）；LLM judge 永遠是 advisory 不是閘門。共通敵人是 Goodhart：agent 看得到的 proxy 與看不到的真目標（held-out Evaluator）必須分離。

### 威脅模型分層（整份規劃的誠實邊界）

- 機器守得住的：**形**（句型/欄位/結構）、**覆蓋**（set-difference）、**痕跡**（檔案實存/hash/exit code）、**不可無聲蒸發**（終局化對賬）。
- 機器守不住的：**語意對不對**——靠三個非 LLM 訊號兜底：互動原型人眼走查、held-out 獨立 Evaluator、使用者彈窗拍板。
- 整套設計**防懶惰淺審、不防蓄意欺騙**：蓄意偽造（裸寫 journal、偷看答案、--no-verify）與手改 state.json 同級，交給後門 hook＋git 審計線，不為它堆機制。

---

## 1. 第 0 波「止血」（S 級，約 1 天，全在 statelib/flow-state 本體）

全部是純文字 parser／檔案實存檢查，零 token 增量、零使用者摩擦。

| 項 | 內容 | 堵的洞 |
|----|------|--------|
| W0-1 | specReadiness 加「`### 開放問題` 段必須**存在**」，缺段 exit 2 | H1（一行修恆過洞） |
| W0-2 | placeholder 掃描（TODO/TBD/待定/???）exit 2；vague 詞表（好用/快速/大量…）**只掃 REQ-\* 行、僅警告不擋**（防 Goodhart 誤殺，跑幾個真專案再決定升級） | 需求含糊直通凍結 |
| W0-3 | `REQ-PERF-*: N/A` 僅在 `.flow/decisions/` 豁免檔實存時放行 | H2 |
| W0-4 | REQ-E2E 強制三段欄位「入口：／步驟：(編號清單 ≥2)／斷言：(≥1)」——parser **寬鬆匹配**（全半形冒號/空白/粗體容忍）；非 web journey 允許「命令列調用/API 呼叫」型入口。EARS 句型檢查**只做五句型 pattern 警告**（ubiquitous 型合法無觸發詞，硬擋必誤殺）。範本補進 ears-cheatsheet.md | flow-spec.md:40 散文句型 → parser 規則；同時從上游壓縮 Evaluator 翻譯自由度 |
| W0-5 | projectType 正門化：型別判定併入**首輪訪談既有彈窗**（不加新停點）拍板 → `flow-state project-type <enum>` 落 state.json（enum 沿用 flow-spec.md Step 1 既有詞彙，非法值 exit 1）。--freeze 改讀記錄：欄位缺 → exit 2；web 類無 `specs/ui-mockups/` → exit 2；**web 類**跳過 mockup 須 `.flow/decisions/mockup-waiver` 實存（非 web 的 enum 記錄本身即豁免，不再造豁免的豁免） | H3＋projectType 分類漂移（切換垂直/水平＋做不做原型兩條路徑） |
| W0-6 | 紅軍 ATTACK_SCHEMA 加 `minItems:3`（schema 引擎強制）；高危關鍵字（auth/bypass/injection/IDOR/權限/個資/payment…，word-boundary 比對）命中的攻擊**禁 silent skipped**——skipped SHALL 附 decision 豁免記錄（不強制 covered，誤命中代價＝留一筆可稽核豁免而非湊數測試） | H7 |
| W0-7 | complete-check：requirements.md 缺檔從警告升 exit 2 | H5 |
| W0-8 | mockup-check 加 10 行空殼頁 heuristic：每個 pages/*.html 須引用 app.js 且含 ≥1 互動元素（form/button/a），缺 → exit 2 | 「index.html 有走查卡但頁面空殼」 |

---

## 2. 第 1 波「訪談多角度審查迴圈」（目標 2 核心；M+L）

設計原則：**lens 綁互異機制而非互異 persona**（Nine Judges）；「哪些 lens 跑過、跑了幾輪」由檔案實存釘死；「發現不能無聲蒸發」由終局化對賬釘死；「審到乾淨才凍結」由 docHash 釘死。

### W1-1 互異機制 lens 矩陣（改造 spec-reviewer，廢除「可選、單視角、一次性」）

| Lens | 機制 | 說明 |
|------|------|------|
| L1 | script（非 LLM） | 第 0 波的形式 lint（spec-ready 本體） |
| L2 | 對抗紅軍 subagent | 目標函數＝「找可濫用缺口/權限洞/異常路徑漏洞」，複用 red-team 六維度改打 spec 文本 |
| L3 | 全集一致性 subagent | **只餵 requirements.md、看不到訪談對話**（context firewall）＝真外部視角；抓跨 REQ 矛盾、術語漂移、實體生命週期孤兒態（Kiro Analyze 思路） |
| L4 | 跨模型家族 | Codex CLI 跑 Spec Kit 9 類含糊 checklist；**有 ledger 就採計、沒裝就跳過**（不設 required/豁免二選一，閘門不隨環境浮動） |
| L5 | 人眼＋真點擊 | 既有互動原型走查＋mockup-check＋使用者定版（非 LLM 訊號） |

- lens 固定 5 個是刻意上限（前 5 吃掉 90% 獨立性）；日後加審查力道只准加「機制不同」的檢查，禁再堆同模型散文評審。
- spec-reviewer.md 改造成 L2/L3 的 prompt 模板。
- **輕量路徑（小功能跳訪談）明文只跑 L1**，否則使用者會繞開正門。

### W1-2 findings ledger CLI（機讀審查痕跡）

- 新 `flow-state spec-review <lens> --file <json>` 落 `.flow/spec-review/<lens>-r<n>.json`，schema 強制（exit 1 拒壞形狀）：`{lens, round, findings:[{id:"SR-L2-003", category, severity, claim, suggest}]}`。
- **docHash 由 CLI 自算**：收檔時 CLI 自己讀 requirements.md 算 SHA-256 寫入（模型不可自填、CLI 覆寫）——「這輪審的是哪個版本的文字」變機器事實。這一個欄位縫住三個旁路（審後改文、假末輪、canary 餵錯檔）。
- L4 落檔走 wrapper：CLI 直接執行 codex 命令、stdout/exit code 原文存 ledger raw 欄位（沒跑就編的偽造成本 ↑）。
- 9 類 coverage 從「逐類必填擋 exit」降為 lens 級一行 attestation（自報欄位反偽造價值趨零，是 Goodhart 首發災區）。

### W1-3 `flow-state review-check`：findings 終局化對賬（樞紐，兩位評審一致 keep）

每條 finding 必須走到四種終局之一，且附機器可驗指標，任一懸空 → exit 2：

1. `resolved:REQ-xxx` — script 驗該 REQ id 真出現在 requirements.md
2. `open` — script 驗 `### 開放問題` 段有帶 `[SR-xxx]` 標籤的 bullet（之後由既有 spec-ready 閘門逼清零＝**逼到彈窗問使用者**，模型不能腦補答案）
3. `deferred:<id>` — decision 檔實存
4. `rejected:<id>` — decision 檔實存（**這是審查迴圈的洩壓閥**：吹毛求疵的 finding 有合法關閉出口、留審計線，迴圈才有界；允許一個 decision 批次覆蓋多條低嚴重度 finding）

含糊點一旦被任何 lens 記下，就再也無法無痕消失——模型吞掉質疑的唯一合法出口是留下機讀痕跡。

### W1-4 --freeze 升級：收斂判準機讀化

新增 exit-2 檢查（全部檔案實存＋JSON 欄位）：

1. L2/L3 各至少一份 schema 合法 ledger（L4 opportunistic、L5 走 W0-5 的 projectType 邏輯）
2. 每個 LLM lens ≥2 輪、末輪 findings 為空、前輪 findings 全終局——把「某一輪問不出新問題」從模型自評換成檔案狀態
3. **末輪 ledger docHash == 凍結當下 requirements.md SHA-256**——「審完→大改文→凍結」即失效、逼重跑末輪（沒有這條，整個收斂判準 attest 的是舊文）
4. **輪次上限 3**：達上限且全 findings 終局＝視同收斂放行（防「lens 第 2 輪重新找出已 rejected 的毛病→永不收斂」的死循環）
5. review-check 全綠
6. `ui-signoff` decision 檔實存才准凍結（老實標注：decision 檔可由模型自寫、機器證明不了使用者真點過——「使用者真的拍板」永遠是機器盲區，靠彈窗雙寫紀律＋git 審計線兜底）

### W1-5 編排散文改寫（prompt-only，但每個宣稱點都被 W1-1~4 的閘門接住）

- flow-spec.md/interview-guide.md：刪「（可選但建議）」；固定輪結構＝**首輪全 lens 必跑 → 中間輪只重跑「上一輪有 findings 或 requirements.md 有 diff（docHash 變了）」的 lens → 末輪全 lens 必跑**（token 上界砍一截、閘門終態不縮水）。
- lens 模板鐵則：**輸入含前輪 findings＋終局狀態、按錨點去重、禁重提已 rejected**（防死循環的關鍵一句）。
- self-check 從自報勾選改成引用 `spec-ready --freeze` 閘門清單。
- **root 憲法檔（flow.md）採替換不追加**：spec 階段既有閘門描述與新閘門收攏成一行總指標指向 `references/spec-review-loop.md`，淨增長 ≤0（ETH 巨檔 −3% 是這套 harness 自己立的鐵則）。
- 各閘門何時跑、fail 回哪一步，畫成固定狀態表放 references。

**成本**：spec 階段 token 約 +20~30%（裁形後）。spec 是最上游隨機源，上游 1 token 的收斂省下游 ~15x fan-out 的重工，是全 harness 最划算的花費點。

---

## 3. 第 2 波「全鏈路機器對賬」（目標 1 骨幹；REQ→design→task→test→verify）

### W2-1 凍結分母 `.flow/trace/req-index.json`（T1 80/20 版）

- --freeze 通過瞬間落檔：**全型號 REQ id 集合＋requirements.md 整檔 SHA-256＋HEAD sha**（砍 per-REQ 區塊 hash——區塊邊界解析脆弱、唯一消費者已被裁掉）；hash 順手寫進既有 `spec.frozen` journal 事件一份。
- **hash 復驗下沉到每個消費閘門**（plan-check／verify 入口／complete-check 都先比對現行檔 hash vs 凍結 index）：凍結後偷改在「下一個閘門」就被抓，不是拖到 ship（H9 的機檢地基）。
- escape 同梯釘死：重跑 `spec-ready --freeze` 即更新 index（重凍結＝走過收斂閘門的正門），錯誤訊息明示這條路，不留「hash 不合但無路可走」的死局。
- `.flow/trace/` 防裸寫（擴 flow-spec-gate regex）與本項**同 commit** 交付。

### W2-2 `flow-state plan-check`（backlog P2「coverage REQ↔task」的落地強化版）

1. REQ↔task **笨掃描** set-difference：凍結 index 每條 REQ id 必須出現在 tasks.md 文字中＋tasks.md 引用的 REQ id 必須實存於 index（防幻覺 id），缺任一 exit 2（同值 90%、複雜度 10%，不做結構化欄位 parser）
2. tasks.md↔.flow/manifest.json 的 task 集合/blockedBy/conflictZone 逐欄 diff，不一致 exit 2（堵「manifest 寫得比 tasks.md 寬＝scope 閘門被靜默調鬆」）
3. plan-done 納入 flow-spec-gate 守備（裸寫 exit 2，與 spec-done 同構）；通過記錄落 `.flow/trace/plan-check.json` **內含當下 manifest.json 的 sha256**（complete-check 重算比對——純 hash、無 mtime、git 操作免疫）
4. REQ↔design 對照矩陣**只印表給使用者在 plan 凍結彈窗掃一眼**、不 exit 2（design 語意矛盾機器驗不了，不假裝是機檢）
5. 架構級一念之差（中央檔拆不拆等）強制 `flow-state decision` 落檔（schema 加「考慮過的替代方案」欄位）。**不做 best-of-N fan-out**（計畫是可丟棄的、變異由下游閘門吸收；3x token 買稽核感不划算——若日後想要，做成互動模式選配）
6. 小功能輕量路徑明訂降級規則

### W2-3 verify 證據硬化（T5＋V6 合併；目標 1 價值密度最高）

1. `verify-e2e --status pass`：script 親驗 evidence 指向的檔**實存且內容含該 REQ id**（複用 testFileProblem 既有標準），自動記 HEAD sha＋測試檔 hash 進 `.flow/verify/<id>.json`
2. `n/a` 收緊：須附 `--decision <id>` 指向實存 decision 檔；complete-check 把 n/a 逐條醒目列出
3. 新 `flow-state run --task <id> -- <runner 命令>` wrapper：spawn 執行、捕真實 exit code、落 journal（attempt 同時記 bucket 與 **taskId** 兩欄）——接住白名單外 runner（make/docker/自寫 script）、繞開文字啟發式誤判
4. `flow-state done` 增一道：**二擇一證據**——journal 有「taskId 嚴格匹配＋sig='ok'＋時間戳晚於該 task 最近 transition」的 attempt，**或** `.flow/verify/` 有本 task 對應 REQ-E2E 的新鮮 pass 記錄（Evaluator MCP 真點擊路徑的既有機讀證據）——兩者皆無才 exit 2（單靠 journal 會誤擋非 runner 路徑的真綠、逼出湊 journal 的 Goodhart；單靠「近期任意綠」會被無關綠燈洗過＝journal 層重開白嫖洞）
5. verify 欄位上格式 schema（`ok:<ref>` 樣式），實質判斷以 journal/verify 記錄為準（三層不各自為政）
6. journey-check 增掃 playwright.config：`retries` 非 0 → exit 2 但 retry-waiver decision 實存放行（CI 真 flaky 是官方合法場景）；webServer command 含 `\bdev\b` → exit 2（「禁 dev server」散文變機檢）
7. flow-spec-gate 擴守 `.flow/verify/`、`.flow/trace/` 裸寫（Write/Edit 直指 → exit 2，只准走 CLI 正門）
8. flow-verify.md 釘成條文：REQ-E2E 的 pass 記錄 SHALL 來自 CLI runner 跑對應測試檔；MCP 互動點擊當探索/除錯、不得作為 verify-e2e 落檔依據（兩條驗證路徑收斂成一條可對賬的）

### W2-4 complete-check 全鏈收束＋verify-perf

1. requirements.md hash == 凍結 index hash（W2-1）
2. 逐條 REQ-E2E 驗 W2-3 證據欄位齊全
3. 新 `flow-state verify-perf <REQ-PERF-id> --value <n> --evidence <ref>`：spec-ready lint 要求 REQ-PERF 寫成可解析格式（`p95 <= 400ms @ POST /api/items` 或 N/A＋decision）；**evidence 須指向量測工具原始輸出檔**（k6/autocannon/lighthouse JSON），script 從檔內解析 p95 與 --value 容差內吻合才落 pass；complete-check 逐條對賬，缺記錄或超標 exit 2——把 flow-state.mjs:315「仍須人工確認 REQ-PERF」的死散文（自駕下無人可確認）換成機讀謂詞。budget 建議留 20% 餘裕（量測噪音是環境性變異）
4. 驗 plan-check.json 存在且其記錄的 manifest hash == 現行 manifest hash

---

## 4. 第 3 波「執行期變異＋兜底」

### W3-1 `flow-state wave --compute`（roadmap wf2 v1-B 已裁決方向的落地）

- 讀 manifest（blockedBy/conflictZone）＋ledger delivered → 純拓樸排序輸出波次；**同層節點按 id 字典序 tie-break**（真「同輸入同輸出」）；blockedBy 未 delivered 一律不進波；同波 zone 前綴重疊**優先自動拆波**、拆不動（完全同路徑）才 exit 2。
- 原子寫 `.flow/wave-plan.json`（含 manifest hash）；`scope --wave` 與 `checkpoint --phase dispatched` 增驗「wave 成員＝wave-plan 該波成員且 manifest hash 一致」，不一致 exit 2（堵 H6）。manifest 合法變更 → 錯誤訊息指路「重跑 wave --compute」。

### W3-2 worker 投餵機械化

- dispatch 前 script 從凍結 requirements.md **逐字抽取** f.req 宣告的 REQ 區塊直接內嵌 worker prompt（取代 id 引用＋worker 自讀），任一 id 找不到 → throw 中止該波（確定性失敗）。同 task＋同凍結 spec → worker 收到的規格文字逐 byte 相同（堵 H10）。不依賴 W0-4（REQ 區塊靠 id 標題即可切界），可先出。

### W3-3 git 原生 pre-commit 鏡像閘門（後排；處理好共存再上）

- flow-commit-gate 三道檢查抽成獨立 node script，由 flow-session-start 冪等安裝 repo 級 pre-commit——由 git 執行、不看命令字串，一次封掉整批繞法（bash 續行/變數展開/worker child process/npm script/MCP run_code）。
- **安裝紀律**：先讀 `git config core.hooksPath`——被 husky/lefthook 改向時 chain 進該路徑或醒目警告「兜底裝不進」，禁靜默裝進不會執行的 .git/hooks（比沒裝更糟的假安全感）；既有 pre-commit 用 marker 區塊（# flow-gate begin/end）append、絕不 clobber；**首次安裝在主文一句醒目告知**（使用者 durable 偏好：狀態變更要醒目）。
- PreToolUse 端補 `--no-verify` 與 `-c core.hooksPath` 兩條 regex（對模型）；對人保留 --no-verify 當 documented 逃生門（reflog 可稽核）。

---

## 5. 刻意不做（Backlog，防過度工程）

| 項 | 為什麼不做 | 替代 |
|----|-----------|------|
| S5 canary mutation 抽查（對審查者做變異注入測靈敏度） | 為尚未觀測到的失效模式蓋 mutation 引擎；散文變異品質天花板低（一眼假）；殺傷率 n=2~3 統計噪音大 | 先觀察 journal「第 2 輪即空」發生率；真出現假收斂 → 上減配版（references/ 放 2-3 段靜態已知爛需求、lens 必須標出，零 mutation 引擎） |
| T4 data-req 錨點三點一線（原型↔骨架↔實作 DOM） | Goodhart 教科書案例（屬性隨手貼容器即轉綠）＋spec renumber 五處連鎖失效＝不收斂機械成因＋與「原型禁搬進 src/」自相矛盾 | W0-8 空殼頁 heuristic＋W2-3 證據驗真＋journey-check 既有機件 |
| T3(b) 測試骨架 codegen＋hash 凍結結構 | 凍結時 app 不存在、能釘死的只有步驟標題；setup 現實（seed/login helper）會逼放寬到保證溶解；一整面 brick 風險 | W0-4 三段欄位 lint（上游壓縮）＋W2-3「evidence 檔 test.step 數 ≥ spec 步驟數＋單一 goto」笨掃描 |
| V3 plan best-of-N fan-out＋judge | 計畫是可丟棄的（Flow 憲法）；自駕下 judge 是一次抽樣、變異降幅存疑、3x token 確定要付；互動下踩「別用大量文字壓人」紅線 | W2-2 單候選 lint 硬閘門＋架構分岔 decision 落檔 |
| code 生成 self-consistency 投票 | frontier 模型邊際 +0.4~1.6%（arXiv:2511.00751）；開放式產出數不了票 | verify 閘門是更便宜的等效物 |
| 靶向 mutation testing／property-based 接縫契約 | 有真價值（唯一能量測「測試品質」的機制／接縫不變量的自然宿主），但先讓全鏈對賬落地 | 全鏈跑順後評估：mutation 靶向 diff 掛 verify/ship 抽查；PBT 掛接縫契約 invariant 條目 |
| 無害變異不管 | 品牌基底推薦/原型頁數（人眼走查吸收）、WebSearch 技術選型時漂（良性）、紅軍攻擊「內容」每 run 不同（對抗價值來源）、波內執行順序（scope+done 守住） | — |

---

## 6. 落地順序與依賴

```
第 0 波（止血，S）────────► 全部獨立、可當天逐項出貨
第 1 波（訪談迴圈）：W1-2 ledger(docHash) → W1-3 review-check → W1-4 freeze 升級 → W1-5 編排
                    （W1-1 lens 模板與 W1-2 並行）
第 2 波（全鏈對賬）：W2-1 req-index(+防裸寫) → W2-2 plan-check → W2-3 verify 硬化 → W2-4 complete-check
第 3 波（執行期）  ：W3-2 worker 投餵（可隨時先出）；W3-1 wave --compute；W3-3 pre-commit（最後）
```

- 第 1、2 波互相獨立（可依偏好先後）；第 2 波內 W2-3 依賴最少、價值最高，可提前。
- 每項新 script 邏輯一律進 statelib 純函式＋比照 statelib.test.mjs 補單測（六個新檢查面的 brick 風險靠測試守）。
- 所有 escape 一律過 decision 檔留審計，不留任何模型臨場自判的靜默逃生口。
- root 憲法檔全程淨增長 ≤0（替換不追加）。

## 7. 主要依據

- 內部：docs/research/harness-engineering-findings.md（GAN harness／兩層 sensor／確定性節點）；memory：flow-audit-backlog（P2 項在本規劃中落地：coverage→W2-2、mockup 一致性→W0-8+W2-3、開放問題黑洞→W0-1+W1-3）、flow-longhorizon-roadmap（v1-B→W3-1；R6 decision summary 與 W1-3/W2-2 共用 decision 設施）。
- 外部：OpenSpec validate --strict（驗形 exit-code 先例）；Spec Kit clarify/analyze/checklist（9 類含糊分類法、Coverage 對賬、checkbox 物化）；Kiro Analyze（全集矛盾推理）；Tessl [@test] 連結（REQ↔test 檔案級對賬）；arXiv:2605.29800（Nine Judges）；arXiv:2605.21384（SpecBench reward hacking）；arXiv:2511.00751（self-consistency 遞減）；Meta ACH（mutation-guided，FSE 2025）；arXiv:2506.18315（PBT 破自我欺騙循環）。
