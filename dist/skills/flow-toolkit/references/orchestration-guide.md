# 多工編排指南：混合基座（/flow-build 用）

**已定基座 = 混合**：波次內 fan-out 用 **Workflow 腳本**（背景跑、結構化回傳、可重播）；階段/波次之間保留**互動式人工閘門**你拍板。

## 為什麼是混合（研究依據）

- **多工很貴**：multi-agent ~15x token vs 單 agent，token 用量解釋 ~80% 的成效變異。**只在「真平行 + 高價值」才 fan-out**。
- **人在關鍵路口**：研究一致建議人工閘門設在 spec / 每輪 / deploy 三點。純自動會把「方向對不對」也自動掉，方向歪會一路歪到最後。
- **波次內可確定性化**：同一波互不依賴的工作寫成腳本撒出去，可重播、換電腦結果一致。

## 兩種工具，各司其職

| 工具 | 用在 | 為什麼 |
|---|---|---|
| **Workflow 腳本**（`Workflow` 工具） | 波次內 fan-out：紅軍平行、worker 平行建置、Evaluator 平行驗證、研究 sweep | 確定性控制流、背景跑、結構化 schema 回傳、可 resume |
| **Agent 工具** | 需要即時介入的單發平行工作 | 主迴圈內可隨時看、隨時停 |

平行 worker 在同 repo 寫各自不重疊的檔（conflictZone 互斥保檔案安全）；build/驗證/commit 由 orchestrator 序列做，避開並發 commit/build 互撞。

## 編排紀律

### 1. foundation 先序列、features 才並行
判準與展開見 `build-playbook.md` §一（單一事實來源）；本檔只管把它排進編排順序——foundation merge 進 trunk 之前不 fan-out。

### 2. 釘契約（編譯期擋發散）
跨 worker 的接縫用 design.md 釘好的**單一 type/schema**，各 worker import 同一份。API 回的形狀 ≠ UI 期望 → 編譯就紅，不會等到 runtime。

### 3. 成本路由＝兩根正交軸（model × effort）

**軸一：model 級別（依任務價值選，Claude 5 家族）**

| 角色 | model | 怎麼定 | 為什麼 |
|---|---|---|---|
| 指揮/編排（`/flow` 主迴圈、自駕 conductor） | **跟隨 session 主模型**（Fable/Opus 級） | 不傳 `model` 參數、繼承呼叫者，**不寫死** | 編排本身是高價值判斷，該用使用者當下選的頂模，模型家族升代自動跟漲 |
| 對抗審查（red-team / evaluator / code-reviewer） | **Opus** | agent 定義檔 frontmatter 釘 `model: opus` + `effort: xhigh`，**不降級**（已落地：`dist/agents/red-team.md`、`code-reviewer.md`） | 找失敗是解藥，不能因「看起來簡單」被模型自己拉低 |
| 平行苦工 worker（建置 feature） | **Sonnet** | `workerModel` 參數預設 `sonnet`，args 可覆寫（`parallel-build.js`） | 苦力活走便宜 model，省 token 換同預算更寬的平行波 |
| 窄活/純擷取（legacy 掃描、單純抓事實/查資料） | **Haiku** | recipe 依來源 `kind` 判斷（已落地：`research-sweep.js`，`kind:'extract'/'lookup'`→haiku，`'compare'/'synthesize'`/未標→維持 `sourceModel` 預設） | 明確任務用最省 model，避免弱模型加倍 token 換效果 |

> 一律參數化、不 hardcode model-specific 行為。升級模型級別 > 在弱模型上加倍 token。Anthropic：Opus lead + Sonnet workers 勝過單 Opus 90.2%。

> ⚠️ **已知風險**：官方環境變數 `CLAUDE_CODE_SUBAGENT_MODEL` 優先權高於 frontmatter/per-invocation `model`——一旦在環境被設，會**靜默蓋掉整套上述路由**（Opus 審查被悄悄降級、Sonnet 苦工被悄悄升級都偵測不到）。`flow-session-start` 的 hook 接線對賬會警示此變數是否非空，但那只是提醒、不是自動修復；設了它即代表使用者主動選擇覆蓋全域路由，需自行確認是否為本意。

**軸二：reasoning effort（同 model 內的檔位，與 model 軸正交）**——`effort` 是 Workflow `agent()` 官方 opt（`low/medium/high/xhigh/max`）：

| 階段 | effort | 為什麼 |
|---|---|---|
| 對抗審查 agent（red-team / evaluator / code-reviewer） | **xhigh（frontmatter 釘死，不降級）** | 同軸一：找失敗的解藥，最高檔位常駐 |
| plan / ship（主迴圈判斷） | **high（不降級）** | Reasoning Sandwich：planning + verification 兩端高 reasoning |
| build worker 的 generate | **medium** | 機械性實作（`parallel-build.js` 的 `WORKER_EFFORT`） |
| 純格式化 / 遷移 / 分類窄活 | **low / none** | 明確任務，高 effort 是純浪費 |

> inverse-scaling：對明確任務強拉 effort 反降準（倒 U）、均一高 effort 比 balanced 差。effort 預設是 per-recipe 寫死常數（`WORKER_EFFORT`/`EVAL_EFFORT`/`RED_EFFORT`，args 可覆寫），**別讓模型在 thinking 裡自調**（同 §4「寫死分級」紀律）。
> 註：`effort` 是 `agent()` 文件化選項；若當前 Workflow runtime 不支援未知 opt 則**靜默 no-op**——只損失 token 節省、**不影響正確性/安全**（傳 effort 本身永遠安全）。

### 4. effort 分級寫死進 orchestrator（別讓模型自由發揮 breadth）
- 簡單查找：1 agent、3–10 tool calls
- 直接比較：2–4 agents、各 10–15 calls
- 複雜建置：一波 N 個 feature worker，各自獨立 context
> 寫死分級避免「為了 trivial 查找 spawn 10 個 agent」或「複雜任務只派 1 個」。

### 5. 小盒子工具（curated subset）
每個 worker 只給它任務需要的工具，不給全集。工具太多會吃掉半個視窗、讓模型亂選。

### 6. context firewall
吵雜/大 context 的工作（掃 codebase、red-team、研究）丟獨立 subagent，只收回 1–2k 蒸餾結果，orchestrator 視窗保持乾淨。

### 7. 確定性節點夾住 agentic 迴圈
git/PR 機制、`.flow/state.json` 寫入、port 清理、verify runner 呼叫都是**確定性節點**（hook/script），不靠模型判斷——這是「沒真跑就填 verify=ok」的解藥。

### 8. 1-hour prompt cache（背景波次/收斂迴圈，先量測再開）
Claude 5 支援 `cache_control: { ttl: "1h" }`（寫入貴 1.25x、換命中省 90% 讀）。**適用準則**：`/flow-build` 背景波次或訪談收斂迴圈的**單輪間隔常態 > 5 分鐘**才考慮開——間隔短的預設 5 分鐘 cache 已夠命中，多付 1.25x 寫入不划算。**先量測實際輪次間隔分布，再決定要不要開**，別無條件全開；不動 W3-2「逐字投餵防漂移」的既有設計。

## Recipes（Workflow 腳本，按需用）

`references/recipes/` 內：
- `parallel-build.js` — 一波 features 同 repo 平行生成 worker，結構化回傳 `{feature,files,selfCheck,blockers,driveBy}`
- `parallel-verify.js` — 多維度/feature 平行起獨立 Evaluator，回傳 PASS/FAIL + 證據
- `research-sweep.js` — 研究 fan-out（多來源平行讀、蒸餾回傳）

用法：把腳本當範本，依當前波次的 feature 清單 + 契約填參數後丟 `Workflow` 工具跑。腳本是可丟棄/可重播的（同 input → 同結果，可 resume）。

## effort 生效驗證（W1-6，2026-07-06 一次性 smoke）

同 prompt 分別以 `effort:'low'` 與 `effort:'high'` 跑 Sonnet agent：兩者皆被 runtime 接受（無報錯、非 no-op 徵兆），high 的分析明顯更深（多抓出邊界 case 並展開）。per-agent token 差異無法從 workflow journal 量化（只回報總量）——結論：effort 分級可放心用，量化差異留待 API 層量測；別再假設「可能靜默 no-op」。
