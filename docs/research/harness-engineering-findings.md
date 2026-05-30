# Harness Engineering — 研究結論（clean-room 工作流的設計依據）

> 來源：harness-engineering-report Netlify 報告 + 16 篇主要來源（yage.ai 語料、Geoff Huntley/Ralph、Anthropic engineering、Stripe Minions、OpenAI Codex、LangChain Deep Agents、Böckeler/Thoughtworks、ETH Zurich、GAN harness）。本檔為 on-demand 參考（非 always-on），故可詳盡。

---

## 0. 一句話核心

**Agent = Model + Harness**。模型正在商品化（換 model 只是改一個 model ID），真正的護城河與 10–20 個百分點的實戰差距來自 **harness**（環境、工具、context 管理、驗證迴圈、編排）。**~75% 的 agent 失敗是 harness 可修的**（prompt / tool def / error handling），只有 ~25% 是模型能力天花板。→ **結論：harness 本身就是產品，值得工程化投入；model 要可抽換。**

數據錨點：同一個 Claude Opus 在 Claude Code 77% vs Cursor 93%（SWE-bench，16pp = 整整一代模型差距）；Cline 純調 harness：opus-4.5 47%→57%（+10pp，零換模型）；LangChain TerminalBench 52.8%→66.5%，排名 30→5。

---

## 1. Context Engineering / 脈絡腐化（→ 需求 2「收束」+ 需求 6「效率」）

- **n² attention 瓶頸**：token 越多，注意力越稀釋，retrieval 精度下降。degradation 是「漸層」不是「懸崖」。Chroma 實測 18 個模型：1M 視窗在 ~50K token 就開始 rot。
- **可用上限 ~170k**（廣告 200k − 系統 prompt + harness 開銷 ~24k ≈ 176k 可用 → Ralph 規劃抓 ~170k）。品質「clip」退化點 ~147–152k。
- **40–60% 利用率「smart zone」**（實務啟發式，非 Anthropic 官方數字；Dex Horthy/HumanLayer 提的「dumb zone」）。**規則：working context 壓在視窗 ~40–50% 以下，碰 ~60% 就觸發收束。**
- **Context anxiety**：agent 感覺快到上限會「抄捷徑、提早草草收尾」。Devin 解法：開 1M 視窗但硬 cap 在 200K，讓模型「以為」還很寬裕。→ **設一個遠低於真實視窗的有效上限，在模型「感到壓力前」就收束。**
- **Compaction 順序受 prompt cache 約束**：壓縮要**先刪最新的尾巴**（保住 prefix 穩定 → cache 命中率，cache hit 價格是 miss 的 1/10），不是先刪最舊的頭。Claude Code compaction 會保留最近存取的 5 個檔案逐字不動。
- **外部化記憶**：把進度寫進檔案再讀回（Anthropic Pokemon agent 靠 NOTES.md 撐過 1,234 步）。→ 狀態進 `specs/` + `.flow/state.json` + git，不靠 in-context 記憶。

## 2. Thin Harness, Fat Skills（→ 需求 2 收束 + 需求 6 效率 + 需求 7 安裝）

- **AGENTS.md 黃金律：目錄不是百科**。root 檔每個 session 都載入 → 必須極薄、當路由表。只放 (a) operating loop (b) 指向 `docs/` 的指標，細節 on-demand 載入。OpenAI「一個大 AGENTS.md」明確失敗（「context 是稀缺資源，巨型指令檔擠掉任務、code、相關 docs」）。
  - 行數：HumanLayer <60 行；Augment 實測甜蜜點 100–150 行（再多就反轉）；共識天花板 <300 行；Codex 硬上限 32 KiB。
  - **ETH Zurich 實證**：LLM 自動生成的 context 檔讓任務成功率 **−3%**、推理成本 **+>20%**。padding 是可量測的稅，不是免費保險。
- **每條禁令配一條正解**：「Don't do X」單獨寫會讓 agent 亂逛找正確做法。要寫「Don't X → Use Y instead」。GitHub 2500-repo 研究：三層邊界 **Always do / Ask first / Never do**。
- **Garry Tan 的 thin harness = 只做 4 件事**：跑模型迴圈、讀寫檔、管 context、強制安全。反對 40+ tool def 吃掉半個視窗。
- **Resolvers（context 路由）**：依任務型別自動載入對應 doc（改 prompt 檔 → 自動載 eval doc）。
- **Latent vs Deterministic**：模型做判斷（憑社交動態安排 8 人座位），確定性 code 做執行（可靠安排 800 人座位）。**絕不讓模型做大量確定性工作。**
- **CLI > 重 MCP**：把能力包成 CLI + `--json` + `--help`，任何 agent 都能用。Playwright CLI ~100ms/op vs Chrome MCP ~15s/op = **75x**。

## 3. 多工編排（→ 需求 3 多工 + 需求 6 效率）

- **Orchestrator-worker**：lead（Opus）規劃 → 存計畫到記憶 → fan-out 平行 workers（Sonnet）各自獨立視窗 → lead 收斂。Anthropic：Opus lead + Sonnet workers **勝過單 Opus 90.2%**。
- **Sub-agent = context firewall**：吵雜/大 context 的工作（掃 codebase、red-team、研究）丟給隔離 subagent，只回傳 **1–2k token 蒸餾結果**，orchestrator 視窗保持乾淨。
- **成本路由**：Opus 編排 + 高風險審查、Sonnet 平行苦工、Haiku 窄/便宜分類。（升級模型級別比在弱模型上加倍 token 更划算：Sonnet 3.7→4 的增益 > 在 3.7 上加倍 token。）
- **Effort-scaling 寫死進 orchestrator prompt**：簡單查找 1 agent / 3–10 tool calls；比較 2–4 agents / 10–15 calls；複雜研究 10+ agents。別讓模型自由發揮 breadth。
- **多工很貴**：agent ~4x token、multi-agent ~15x token vs chat；token 用量解釋 ~80% 的成效變異。**只在「真平行 + 高價值」才 fan-out**，線性/便宜任務用單 agent 或確定性 workflow。
- **Workflow vs Agent**：路徑已知 → 用確定性 workflow（chain/route/parallelize/orchestrator-workers/evaluator-optimizer 五型）；只有真正開放式的步驟才給完整 agency。**預設最簡，需要才加複雜度。**
- **Stripe 預熱 sandbox**：warm pool 讓 devbox <10 秒就緒（cattle not pets），fan-out 前就把 deps/cache/port 預熱好，worker 別冷啟動。一個工程師同時跑 ~6 個。

## 4. 驗證迴圈（→ 需求 4 驗證 + 需求 5 效能 + 補充「真實資料鏈路」）

- **Böckeler 點名：behavioral 驗證是「尚未解決」的缺口**。「我在這份 write-up 裡缺的，是功能與行為的驗證。」綠 build / 過 lint / 過 type-check **都不等於功能會動**。
- **GAN harness：Planner → Generator → Evaluator，Evaluator 必須結構性獨立**：
  - 模型評自己的工作是「病態樂觀者」「幾乎一律給自己高分」（self-assessment blindness）→ 評估**必須**是獨立 agent。
  - 獨立性機制（不是禮貌，是結構）：每輪用**全新 system prompt** 重啟 Evaluator；agent 間**只透過檔案溝通**（QA report），看不到 Generator 的 chain-of-thought；**對抗性人設**（你的工作是「找失敗」不是「核准」）；few-shot 嚴格評分範例（開箱 Claude 當 QA 太寬鬆）。
  - Evaluator 拿 **Playwright 驅動「活的」running app**：navigate、click、查 DOM、**打 API 端點、查 DB 狀態**，對照「coding 前就釘好的 sprint contract」。
- **效能/品質是硬閘門（不准平均）**：4 個獨立門檻維度（功能 / 視覺 UX / code 品質 / 原創打磨），**任一維度 < 7 分 → 整體 FAIL**，高平均不能買回失敗維度。loop 到 PASS 或 MAX_ROUNDS 才停。
- **兩層 sensor（Böckeler）**：
  - **Computational**（確定性、ms–秒、可靠）：tests、ESLint、type checker、SAST、mutation testing → **每個迴圈都跑**，當快速回饋訊號。
  - **Inferential**（LLM 語義判斷、慢、非確定）：security review、耦合度 review → **慢節奏跑**抓 drift。
  - 兩者都**不能取代** behavioral e2e（Böckeler 的缺口）。
- **真實資料鏈路（補充需求的可驗定義）**：UI → 真 API → 真 query → 真 DB。**禁止**在 API client/網路層用 mock/stub/MSW/寫死 fixture 冒充。測試資料**透過真實 create API 路徑 seed 進真 DB**，再串回來——同時驗到 (a) API 真接通 (b) 資料正確性（query/join/filter/scope/序列化/型別）(c) 效能（真 DB 延遲/N+1/index/分頁）。mock 把這三者全跳過。真依賴未 ready → 標 **BLOCKED**，禁 mock fallback 假裝綠。外部副作用 API（金流/簡訊/付費 LLM）首選官方 sandbox 真打，無 sandbox 才 mock 並明確標記。
- **「永不信任 exit 0」（rendering gap）**：改了專案檔但沒「materialise」它會靜默 no-op，agent 卻以為成功了。驗證**斷言實際產物**（檔案內容/結構/渲染結果），不是看 code 對不對。
- **Web 驗證三鐵則**：production build（禁 dev server 噪音）+ Playwright `--headed` + attach `console`/`pageerror` listener 結尾 assert 零 error + 關鍵 UI 斷言。
- **OpenAI Codex 同款**：用 computer-use 走「使用者真實路徑」+ 讀 telemetry 證明功能會動，不是看 code。配 persona 審查 agent（frontendarchitect.md / reliabilityengineer.md / appsecengineer.md）。

## 5. 收束 / 防無限寫入（→ 需求 2）

- **Ralph loop**：每個迭代開**全新 context**，從磁碟讀同一份 prompt + state 檔，做**一個單位**的工作，寫回磁碟、commit、退出、乾淨重啟。**耐久性全在檔案，不在模型 context。**
- **One item per loop**（硬規則，Huntley 重複強調）：~170k 預算下只做最重要那一件，寫下來，退出，乾淨重啟。穩定後可放寬到「最重要的 10 件」，一出軌就收回 1 件。
- **Conversation-first spec**：別叫 agent 直接做。先「跟 LLM 長談需求」→ 理解後「把規格寫出來，一個 concern 一個檔，放 specs/ 資料夾」當 source of truth → 之後每個迴圈確定性地重載同一份 specs（「stack 每次都用同樣方式配置」）。plan mode 只做 gap 分析 + 寫計畫，**不寫實作**；build mode 才實作。
- **完成謂詞 + 迭代上限**（不是真無限）：(a) 完成訊號——所有 PRD story `passes:true` → emit `<promise>COMPLETE</promise>` 退出；(b) 硬 `MAX_ITERATIONS`；(c) 人工判斷。**計畫是可丟棄/可再生的**（從 requirements 重生成本 = 一個 planning loop），別讓 agent 無止盡打磨同一個檔。
- **Tests as backpressure**：build/test 併發**刻意限 1**（backpressure，系統不能跑在「實際能編譯通過」之前）。沒過測試不准 commit、不准標 done。明確反 stub：「不准 placeholder / 簡化實作」。
- **Append-only 進度檔**：學習以**短條目累加**，不是越寫越長的敘事（敘事會下個 loop 又污染 context）。「保持簡短」。

## 6. 生產級 pattern（→ 需求 6 效率 + 需求 4 驗證）

- **Stripe Minions**：1,300 PRs/週、~500 MCP 工具但 agent 只拿**小而精選的子集**（「小盒子」）、selective CI、**2 輪 CI 上限**（1 次 + 1 次修 → 升級給人）、local lint <5s **先**跑（便宜的先擋，別在貴的路徑上燒）、**子目錄範圍規則**（全域規則「非常節制」否則「agent 還沒開工視窗就被規則塞滿」）、repo 即唯一真相、**政策即失敗測試**（用直引號而非彎引號就 build fail）。
- **確定性節點夾住 agentic 迴圈**：git/PR 機制、state 寫入、port 清理、verify runner 呼叫都是**確定性節點（hook/script）**，不靠模型判斷——這是「AI 沒真跑就填 verify=ok」的解藥（閘門是確定性節點，模型沒法假裝）。
- **LangChain Deep Agents middleware**（lifecycle hooks：before_agent / before_model / wrap_model_call / after_model / wrap_tool_call / after_agent）：
  - `PreCompletionChecklistMiddleware`：退出前強制對照原始 spec 跑驗證（拒絕提早完成）。
  - `LoopDetectionMiddleware`：追蹤同檔編輯次數，超過 N 次注入「重新考慮你的做法」打破 doom loop（10+ 次重複）。
  - `LocalContextMiddleware`：啟動時掃 cwd、跑 bash 探針偵測環境，先縮小錯誤面。
  - **Reasoning Sandwich**：planning 與 verification 給高 reasoning，中間 generation 給低。**均勻全開反而更差**（xhigh-only 53.9% vs balanced high 63.6%）。

---

## 7. 三個外部 skill — 已核實安裝指令（→ 需求 7 安裝 + 補充）

### (1) ui-ux-pro-max（UI 設計，補充指定）
plugin id：`ui-ux-pro-max@ui-ux-pro-max-skill`
```
/plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill
/plugin install ui-ux-pro-max@ui-ux-pro-max-skill
```
替代（npm CLI，支援 ~20 種 agent target）：
```
npm install -g uipro-cli
uipro init --ai claude            # 或 --ai all；加 --global 做 user 級
```

### (2) mattpocock/skills（工程 skill 集，補充指定）
```
npx skills@latest add mattpocock/skills
/setup-matt-pocock-skills          # 安裝後在 agent 內互動設定
```
含 18 個 skill（diagnose / grill-me / grill-with-docs / tdd / handoff / caveman / write-a-skill / to-prd / to-issues / zoom-out / prototype / triage / git-guardrails / setup-pre-commit 等）。

### (3) andrej-karpathy-skills（4 行為原則，補充指定）
**⚠ 命名空間落差**：使用者指定 `multica-ai/andrej-karpathy-skills`，但該 repo 的 README 內**逐字**指令指向上游 `forrestchang`（multica-ai 幾乎確定是未標註的 mirror/fork，README 沒改命名空間）。marketplace 名 `karpathy-skills` 與 owner 無關。
- README 逐字（forrestchang）：
  ```
  /plugin marketplace add forrestchang/andrej-karpathy-skills
  /plugin install andrej-karpathy-skills@karpathy-skills
  ```
- 若照使用者指定的 multica-ai（需手動替換，未實測解析）：
  ```
  /plugin marketplace add multica-ai/andrej-karpathy-skills
  /plugin install andrej-karpathy-skills@karpathy-skills
  ```
- 4 原則：Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven Execution。**因為只是 4 條原則，最穩做法是直接 bake 進本工作流的薄規則層**（零外部依賴、最可攜），外加可選的 plugin 安裝。

---

## 8. 主要來源 URL（供回溯）

- yage.ai 語料：harness-engineering-survey / demand-side-analysis / scalability / canonical-form / agent-runtime-battlefield / thin-harness-fat-skills / ai-scaffolding-commodity-runtime / cursor-agent-harness-evaluation-first（皆 `https://yage.ai/share/*.html`）
- Geoff Huntley：ghuntley.com/ralph、/loop、/agent；github.com/ghuntley/how-to-ralph-wiggum；humanlayer.dev/blog/brief-history-of-ralph；github.com/snarktank/ralph
- Anthropic：engineering/effective-context-engineering-for-ai-agents、building-effective-agents、multi-agent-research-system、managed-agents、writing-tools-for-agents
- Chroma context rot：trychroma.com/research/context-rot；github.com/chroma-core/context-rot
- Stripe：stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2；blog.bytebytego.com/p/how-stripes-minions-ship-1300-prs
- OpenAI Codex：openai.com/index/harness-engineering（403，經 news.aakashg.com podcast 還原）；developers.openai.com/codex/guides/agents-md
- AGENTS.md 指引：github.blog（2500-repo 研究）、augmentcode.com/blog/how-to-write-good-agents-dot-md-files、philschmid.de/writing-good-agents
- LangChain：langchain.com/blog/improving-deep-agents-with-harness-engineering；github.com/langchain-ai/deepagents（`uv add deepagents` / `pip install deepagents`）
- Böckeler/Thoughtworks：martinfowler.com/articles/sensors-for-coding-agents、harness-engineering-memo、pushing-ai-autonomy
- ETH Zurich：arxiv.org/html/2602.11988v1（AGENTbench：138 instances，padding −3% 成功率 +>20% 成本）
- GAN harness：epsilla.com/blogs/anthropic-harness-engineering-multi-agent-gan-architecture；mindstudio.ai/blog/planner-generator-evaluator-pattern-gan-inspired-ai-coding
