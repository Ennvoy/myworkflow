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
共用檔（全域 router / 共享型別 / DB schema / auth foundation）**先做完 merge 進 trunk**，再 fan-out features。否則大家改同一個檔 = merge 地獄。靠 `conflictZone` 算重疊。

### 2. 釘契約（編譯期擋發散）
跨 worker 的接縫用 design.md 釘好的**單一 type/schema**，各 worker import 同一份。API 回的形狀 ≠ UI 期望 → 編譯就紅，不會等到 runtime。

### 3. 成本路由＝兩根正交軸（model × effort）

**軸一：model 級別（依任務價值選）**
- **Opus**：orchestrator 編排 + 高風險審查（red-team / code-reviewer / Evaluator）
- **Sonnet**：平行苦工 worker（建置 feature）
- **Haiku**：窄/便宜分類（legacy 掃描、分類）
> 升級模型級別 > 在弱模型上加倍 token。Anthropic：Opus lead + Sonnet workers 勝過單 Opus 90.2%。

**軸二：reasoning effort（同 model 內的檔位，與 model 軸正交）**——`effort` 是 Workflow `agent()` 官方 opt（`low/medium/high/xhigh/max`）：

| 階段 | effort | 為什麼 |
|---|---|---|
| plan / verify(Evaluator) / ship / 紅軍 | **high（不降級）** | Reasoning Sandwich：planning + verification 兩端高 reasoning |
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

## Recipes（Workflow 腳本，按需用）

`references/recipes/` 內：
- `parallel-build.js` — 一波 features 同 repo 平行生成 worker，結構化回傳 `{feature,files,selfCheck,blockers,driveBy}`
- `parallel-verify.js` — 多維度/feature 平行起獨立 Evaluator，回傳 PASS/FAIL + 證據
- `research-sweep.js` — 研究 fan-out（多來源平行讀、蒸餾回傳）

用法：把腳本當範本，依當前波次的 feature 清單 + 契約填參數後丟 `Workflow` 工具跑。腳本是可丟棄/可重播的（同 input → 同結果，可 resume）。
