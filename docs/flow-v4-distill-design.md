# Flow 萃取 v4 優點：監控看板 + Journal 恢復（設計檔）

> 狀態：**設計凍結待審**（尚未實作）。v4 = 借鑑來源、Flow = 目標。本檔只規範「補兩個缺口」：①監控看板、②可恢復的 journal 狀態層。並行（Workflow 模式）Flow 已有，本檔只做**確認 + 一處補洞**。
>
> 範圍排除：開發中 v3 專案切換到 Flow 的遷移問題（使用者明示本輪不考慮）。

---

## 0. 為什麼是這兩個缺口（對照 v4）

| v4 能力 | Flow 現況 | 本檔處置 |
|---|---|---|
| 並行交付（worktree worker） | ✅ 已有：`/flow-build` + `parallel-build.js`（Workflow 腳本），且更穩（可重播） | §3 只做**確認** + 修一個並行 write-ahead 硬傷 |
| 監控看板 | ❌ 沒有 | §1 設計 `/flow-monitor` |
| write-ahead journal + reconstruct | 🟡 半套：文件講了 dangling，但無實作 journal、只有單檔 `state.json` | §2 設計 `.flow/` journal 狀態層 |

**白話**：Flow 已經會並行、會訪談、會驗證；缺的是「一面即時看進度的鏡子」和「一本殺不死的流水帳」。這兩樣補上，Flow 才完整。

---

## 1. 缺口① — `/flow-monitor` 監控看板

### 1.1 設計主軸：唯讀投影 Flow 既有產出物，零流程改動

借鑑 v4 看板的**形**（kanban 投影 + 決策卡導回彈窗 + 每 2 秒刷新 + 自動找空 port），但把 v4 的**料**（它另養的 ledger）換成 **Flow 本來就在寫的三樣東西**——不要求開發迴圈多維護任何新檔。

```
specs/tasks.md     →  三層 P-/F-/X- 的 [ ]/[x] + blockedBy + conflictZone（整體進度 / 分波 / 卡依賴）
.flow/state.json   →  「當前那一個 task」的 phase/tdd/verify/commit（開發中/驗收中細節）
git log            →  已交付 commit/SHA（落地證據）
（有 §2 journal 後）  .flow/ledger/*.json → 升級為每 task 精準快照（並行時尤其關鍵）
        │
        ▼  dashboard.mjs（借鑑 v4，為 Flow 重寫解析器，唯讀 http server）
        ▼  poll /status.json 每 2 秒
   board.html（借鑑 v4 kanban 版式，語意改 Flow）
```

> **零干擾論證**：獨立 Node process，只 `Read` 三個檔、不 `Write`、不進 Claude context、不加閘門、不吃 Claude token。Flow 開發迴圈完全無感。

### 1.2 資料解析規格（parser）

| 看板元素 | 來源 | 取法 |
|---|---|---|
| task id / title / 分組 | `specs/tasks.md` | 按 `## Prelude` / `## Features` / `## Cross-cutting` / `## Backlog` 切段；每段抓 `- [ ] <ID> <title>` / `- [x] …`；續行抓 `blockedBy:` / `conflictZone:` |
| ✅ delivered | `[x]` 或 ledger.state=delivered | checkbox / 快照 |
| ⏳ pending | `[ ]`（預設） | checkbox |
| 🚫 blocked | `blockedBy:` 指向的 task 尚未 `[x]` | 依賴未滿足 |
| ⚙️ building / 🔍 verifying | `state.json` 當前 task 的 `phase`+`tdd`+`verify`（或 ledger.state） | 疊在那張卡 |
| ⚠️ needs-decision | ledger.state / `.flow/decisions/`（§2 後才有原生來源） | 決策卡 |
| commit SHA | `state.json.commit` / git | 落地證據 |

**容錯鐵則**：tasks.md 若無標準三層標題 → **退而求其次平鋪**所有 `[ ]`/`[x]`，不得整支壞掉（未來相容自訂結構）。

### 1.3 為 Flow 改良的點（v4 看板沒有 = 這才叫「重新設計」）

1. **5 階段 ribbon**：頂部 `spec → plan → build → verify → ship` 高亮當前 phase（讀 `state.json.phase`）。
2. **完成謂詞面板**（Flow 獨有收束概念，來自 `convergence-guide`）：把終點條件做成檢查格——
   `所有 P-/F- [x]` ∧ `REQ-E2E-* 綠` ∧ `REQ-PERF-* 達 budget` ∧ `X-* 清空` → 亮綠才代表可發 `<promise>COMPLETE</promise>`。一眼看到「離真做完差哪幾項」。
3. **當前 task 的 TDD/verify 細節**上卡：`tdd=red:<ref>/green`、`verify=ok`，對齊確定性閘門。
4. **X-* cross-cutting 必清擋板**：X-* 還有 `[ ]` → 面板亮琥珀色（呼應 `flow-ship` Step 4 未清不放行）。
5. **wave / 依賴視圖**（選配）：用 `blockedBy`+`conflictZone` 標「這波哪些可並行、哪些在等誰」。

### 1.4 畫面（Flow 版 mockup）

```
Flow 看板  ● 即時監控      spec ─ plan ─ [build] ─ verify ─ ship
my-app · HEAD a3f9c2                                  已交付 6 / 11  [█████░░░░] 55%

完成謂詞： P/F ✗(差5)  REQ-E2E ✗  REQ-PERF —  X-* 未清(2)⚠️  → 尚不可 ship

⏳ 待開發(4)      ⚙️ 開發中(1)         ✅ 已交付(6)
┌──────────┐    ┌─────────────────┐   ┌────────┐
│ F-3 搜尋  │    │ F-2 建立 item    │   │ P-1 ✓  │
│ 卡 F-2    │    │ tdd=green       │   │ F-1 ✓  │ …
│ X-1 ⚠️必清│    │ verify=驗證中... │   └────────┘
└──────────┘    └─────────────────┘
```

### 1.5 元件 + 驗證計畫

- 新增 `dist/skills/flow-toolkit/dashboard.mjs`（借鑑 v4，重寫 parser）、`board.html`（借鑑版式）、`dist/commands/flow-monitor.md`（指令：背景啟動 + 讀實際 port + `Start-Process` 開瀏覽器）。
- **驗證（Flow 鐵則三 + 真實資料鏈路）**：seed 一份 `.flow/`（經 §2 的 statelib，非手寫 JSON）→ 起 dashboard → **Playwright headed** 開看板 → attach `console`/`pageerror` listener → `expect(errors).toHaveLength(0)` + 斷言「看板正確投影 seed 的 task 數與狀態」（UI → /status.json → 真檔，無 mock）。

### 1.6 自動開啟時機（回應使用者：進開發會自己打開嗎）

**會——綁在「進入或接續 build phase」，冪等自動開，不用每次手打**：
- **觸發時機 = 進入或接續 build phase**：`/flow-build`、`/flow` 推進到 build、**`/flow-resume` 偵測到專案在 build 中** → 都自動背景起 dashboard + `Start-Process` 開瀏覽器**一次**。**所以換 session / 重開機後，你跑 `/flow-resume` 接續開發時，monitor 也會自動開**（對齊 `flow-spec` Step 5 的 0 摩擦自動開）。
- **不在 bare session-start 自動開**：`flow-session-start` hook 只**提醒**「跑 /flow-resume 接續」，不擅自劫持瀏覽器（開 session 可能只是要做別的事）。真正動工（`/flow-resume` 或 `/flow`）才開。
- **冪等**：啟動時把選到的 port 寫 `.flow/monitor.port`；再次進 build 先檢查該 port server 還活著嗎——活著就**重用**（不再開新 tab/新 server），死了才重起。避免疊一堆背景 server / 瀏覽器分頁。
- `/flow-monitor` 指令保留給「想單獨開 / 在別台機器看」手動用；收掉用 `/flow-monitor stop`（或 Ctrl+C）。

---

## 2. 缺口② — `.flow/` 可恢復 Journal 狀態層

### 2.1 為什麼非補不可：一個並行硬傷

`flow-build` Step 3 說「每 spawn 前 `actionStart` 寫 `state.json`」，但 `state.json` 是**單一 task 整檔覆寫**。一波同時 fan-out F-1、F-2 → F-1 的 actionStart 被 F-2 覆蓋 → crash 後只剩 F-2 的 dangling，**F-1 的中斷點遺失**。

> **白話**：想並行，但「先記再做」的筆記本只有一頁、後面的人擦掉前面的。**單檔 state.json 撐不起多 worker 並行的 write-ahead。** 這不是優化，是補洞。

### 2.2 設計：借鑑 v4 `statelib`，但與 Flow 既有 hook 相容（外科手術）

```
.flow/
├── state.json          # 【保留】當前 task 指標（phase/tdd/verify/commit）— 既有 hook 照吃，不破壞
├── manifest.json       # 【新】藍圖：tasks[] + blockedBy + conflictZone + waves（可由 tasks.md 生成）
├── ledger/<id>.json    # 【新】每 task 快照（state/branch/commit/note/decision）— 解決並行多 dangling
├── journal.ndjson      # 【新】write-ahead 事件流（append-only：actionStart/actionDone/transition/decision）
└── decisions/<id>.json # 【新】拍板紀錄（彈窗回答後寫回，可恢復）
```

**相容性鐵則**：`flow-verify-gate` 與 `flow-session-start` 兩個 hook **仍只讀 `state.json`**，不動它們（surgical）。`state.json` 變成「當前 task 的衍生指標」；`journal.ndjson` 才是重建真相的來源。新增 `statelib.mjs`（`transition` / `actionStart` / `actionDone` / `recordDecision` / `reconstruct`）。

### 2.3 寫入時機（接進現有流程）

| 時機 | 動作 | 檔 |
|---|---|---|
| `flow-build` spawn worker 前 | `actionStart(id, 'building')` | journal（**每 worker 各一筆、不互蓋** ← 修 §2.1 硬傷） |
| worker merge + 綠 | `transition(id, 'building'→'delivered')` + `actionDone` | journal + ledger |
| `flow-verify` 綠燈 | `transition(id,'verifying'→'verified')`、同步寫 `state.json.verify=ok:<ref>` | journal + ledger + state.json（向後相容） |
| 彈窗拍板 | `recordDecision(id, ...)` + `transition('needs-decision'→'pending')` | decisions + journal |
| `flow-ship` 各步 | ship 進度也落 journal（補 ship 無持久化的缺口） | journal |

### 2.4 冷啟動恢復（`reconstruct`）

任何 session / 機器跑 `reconstruct(root)`：讀 manifest + 全部 ledger + journal → 還原「每 task 現況 + 未完成 dangling（actionStart 無對應 actionDone）」。`/flow-resume` 把 `flow-resume.md` 描述的 dangling 補做**從文件承諾變成真機制**。

### 2.5 跨電腦缺口的修法（git-tracking 決策）

v3/Flow 換電腦掉狀態的根因 = 狀態檔 gitignored。**建議**：
- **git-track**：`.flow/manifest.json` + `.flow/ledger/` + `.flow/journal.ndjson`（這樣換電腦 clone 即重建細粒度進度）。
- **gitignore**：`.flow/state.json`（可由 journal 衍生）+ `.flow/*.log` 驗證 artifact（可重生、勿污染 repo）。

> **白話**：把「殺不死的流水帳」放進 git，換電腦就不只剩 task 級；驗證 log 這種一次性垃圾留本機。

---

## 3. 確認：並行開發用 Workflow 模式（+ 一處補洞）

### 3.1 結論：YES，Flow 已是這個模式

`parallel-build.js` 本身就是 Workflow 腳本：`pipeline(wave, 紅軍 stage, worktree worker stage)`、結構化 `ATTACK_SCHEMA`/`BUILD_SCHEMA`、`agent(..., {isolation:'worktree'})`。`orchestration-guide` 明訂混合基座與工具分工：

| 工具 | 用在 | 為什麼 |
|---|---|---|
| **Workflow 腳本** | 波次內 fan-out（紅軍平行、worker 平行、Evaluator 平行、研究 sweep） | 確定性控制流、背景跑、結構化回傳、可 resume / 可重播 |
| **Agent 工具（worktree）** | 需即時介入的單發平行 | 主迴圈內可隨時看/停 |

### 3.2 唯一要注意的前提：worktree 需要 git repo（PoC 實測確認）

`isolation:'worktree'` 從「session 當前專案的 git repo」開 worktree。**v4 已記載**：需 session 啟動時資料夾**已是 git repo**，否則 fan-out 退「**檔案分區並行**」（靠 conflictZone 算準各 worker 改不同檔，不用 worktree）。

**PoC 實測（`flow-parallel-poc` Workflow，2026-05-30，本機真跑）**：

| 驗的事 | 結果 |
|---|---|
| Workflow 並行 fan-out（`pipeline(紅軍 → 平行 worker)`，2 feature，結構化 schema 回傳） | ✅ **PASS**：`POC-A → 7!=5040`、`POC-B → FLOW PARALLEL WORKS`，5 agent / 23.8s / schema 驗證過 |
| `isolation:'worktree'` 在當前（非-git）session | ⚠️ **UNAVAILABLE**，錯誤原文：`not in a git repository and no WorktreeCreate hooks are configured` |

**結論**：「並行用 Workflow 模式」**實跑成立**（不是紙上）。worktree 隔離有**兩條啟用路**：
1. **專案是 git repo**（`flow-build` 本就要求「不是 → 先 `git init`」）——主路。
2. **設 `WorktreeCreate/WorktreeRemove` hook**（settings.json）——連非-git VCS 也能用的旁路。

**退路（兩條都不走時）**：**檔案分區並行**——`conflictZone` 互不重疊即可並行，merge 改成「各寫各檔、無交集」。並行 fan-out 本身（紅軍平行、worker 平行、結構化回傳）**不需要 worktree 也能跑**；worktree 只是「同檔不打架」的隔離手段。

### 3.3 並行的成本紀律（沿用 orchestration-guide，勿濫用）

- 多工 ~15x token，**只在「真互不依賴 + 夠份量」才 fan-out**；簡單/相依的別硬塞平行。
- 成本路由：Opus 編排/審查、Sonnet 平行苦工、Haiku 窄活。
- effort 分級寫死進 orchestrator、小盒子工具、context firewall、確定性節點夾住 agentic 迴圈。

---

## 4. 實作順序（待審核後執行）

1. **`statelib.mjs`（§2）先做**：它是看板「升級版資料源」與並行 write-ahead 修洞的共同地基。`node --test` 綠（含冷啟動 / 並行多 dangling 恢復）。
2. **`/flow-monitor`（§1）**：dashboard.mjs + board.html + 指令，headed Playwright 真實資料鏈路驗證綠。
3. **接線（§2.3）**：把 actionStart/Done/transition 寫進 `flow-build` / `flow-verify` / `flow-resume` 既有步驟（surgical，不動現有 hook）。
4. **git-track 設定（§2.5）** + `/flow-resume` 用 reconstruct。
5. **補打包缺口（§5）**：bundle 3 個 agent 進 `dist/agents/` + `install.ps1` 裝；`flow-spec` 真 invoke grill-me。
6. **SDD 文件收束 + 輕量路徑（§6）**：定義小功能輕量入口 + 三條收束觸發。

每步走 Flow 自己的紀律：TDD 三相、真實資料鏈路、實跑綠燈才算完成。

---

## 5. 打包完整性修正（使用者盤點發現）

### 5.1 subagent：精簡（砍 legacy-scout）+ 重寫成 Flow 版（非照搬）

**現況（已查證）**：`dist/` 無 `agents/`，`install.ps1` 不裝 agents（只裝 commands/skills/rules/hooks）。現在能動**只因本機 `~/.claude/agents/` 被 v3 裝過** → 新電腦乾淨裝會炸（`agentType:'red-team'` 解析不到），違反「自包含」宣稱。

**逐一評估（已讀 4 個 agent 全文）**：

| agent | 去留 | 理由（含實際耦合證據） |
|---|---|---|
| **red-team** | ✅ 留 + 重寫 | 攻擊維度/severity/輸出格式是流程無關精華。耦合：description 寫死 `/sdd-deliver`、引用 sdd.md `§11` |
| **code-reviewer** | ✅ 留 + 重寫 | REQ 對賬/紅軍驗證/smell 是精華。耦合最重：寫死 `/sdd-ship`、`docs/sdd/` 路徑、`§14/§15/§19`、「Change Log」「路徑地圖」等 v3 概念 |
| **spec-reviewer** | ✅ 留 + 重寫 | 「獨立 context 一次性質疑」＝grill-me（互動深挖）給不了的外部視角，**不重複**。耦合輕：寫死 `/sdd-spec`、`docs/sdd/` 路徑。（要極簡到底這個可砍——它與 grill-me+蘇格拉底最接近；但建議留，獨立 context 結構上不同） |
| **legacy-scout** | ❌ **砍** | 只在「大改造既有系統」才有價值（盤點需淘汰/相容/遷移）。Flow 偏綠地新建 + 小功能輕量路徑（小改不需重型三清單）。**極簡優先→砍**。何時再加：接「大型 legacy 重構」案再 bundle 回來 |

**重寫鐵則（不照搬，bundle 前先改）**：
- 觸發點：`/sdd-deliver`→`/flow-build`、`/sdd-ship`→`/flow-ship`、`/sdd-spec`→`/flow-spec`
- 路徑：`docs/sdd/`→`specs/`
- 拔掉 sdd.md `§11/§14/§15/§19` 外部引用 → 改 Flow 自有概念（自包含）或 flow.md 對應規則
- 對齊 Flow 詞彙：真實資料鏈路、完成謂詞、接縫契約、Tier-1/2 sensor、drive-by
- 與 recipe 一致：red-team 由 `parallel-build.js`（`agentType:'red-team'`）composed、code-reviewer 由 `flow-ship`、spec-reviewer 由 `flow-spec`——agent .md 給 persona、recipe 加 task context

**修法**：重寫後的 3 個 agent bundle 進 `dist/agents/`，`install.ps1` 加一步建 `~/.claude/agents/` 並複製。

**不用處理**：Evaluator 是 `parallel-verify.js` 內嵌 `EVALUATOR_PERSONA`（fresh agent + 對抗人設），**本就自包含、本就是 Flow 版**，無檔可 bundle。

### 5.2 grill-me / mattpocock 整套 skills

**現況（已查證）**：`install.ps1` line 96 已 `npx -y skills@latest add mattpocock/skills`——整套已在安裝流程（含 grill-me 等 18 個），裝完跑 `/setup-matt-pocock-skills` 設定。`dist/skills/` 只 bundle `flow-toolkit`，**不撞名**（mattpocock 當唯一來源）。

**要補 1 處**：`flow-spec` Step 2 目前只寫「grill-me 精神」inline、**沒真 invoke**。依使用者「需求訪談 = 蘇格拉底 + grill-me」本意，flow-spec SHALL 在蘇格拉底彈窗收斂後、凍結前**實際呼叫 grill-me skill** 做決策樹逐分支深挖（或彈窗讓使用者選「進 grill-me 深挖 / 直接凍結」）。

---

## 6. SDD 文件收束 + 小功能輕量路徑（回應使用者第 3 點）

### 6.1 結論：需要收束，是剛需非可選

**為什麼**（兩個疊加原因）：
1. **輕量路徑本身會累積**：小功能跳訪談但仍寫 SDD → 每次往 requirements/design/tasks append → 月積年累必膨脹。
2. **大文件直接違反 Flow context 預算憲法**：Flow 規定 working context < 40–50%、碰 60% 收束。**實證使用者自己的 v3 專案**：AI_project_hub `design.md` 213KB、marketing-hub `tasks.md` 255KB（≈64K tokens，光一檔吃掉 1/3 視窗）。plan/build 每 loop 重讀 → 文件越肥模型每步越笨。

> **白話**：SDD 文件是「每迴圈都要重讀的東西」，一肥則整套流程每步變鈍。收束是防腐化剛需，非潔癖。

### 6.2 小功能輕量路徑（跳訪談、仍寫 SDD）

定義一條 `/flow` 輕量分支（貫徹 SDD 但不重）：
- **觸發**：使用者明說「小調整 / 不用訪談」**或** `/flow` 偵測改動範圍小（單一既有 feature 局部、無新實體/角色）。
- **跳過**：蘇格拉底全套訪談、UI mockup 對焦、spec-reviewer。
- **仍 SHALL 寫 SDD**：往 `requirements.md` 的「**當前迭代**」段補一條精簡 `REQ-XXX`（EARS）+ 往 `tasks.md` 補一個 `F-*` task（仍走 TDD + 真實資料鏈路 + per-task commit + verify 綠燈）。
- **安全閘門（升回完整 `/flow-spec`）**：只在**需求級**變動才升——新實體 / 新角色 / auth / RBAC / payment / 個資 scope。

### 6.3 收束觸發（三條，加進 /flow-compact）

| 觸發 | 條件 | 動作 |
|---|---|---|
| **size** | 任一 spec 檔 > ~50KB（≈12K tokens） | 已 `[x]`/已 shipped 段摘要成一行 + 全文移 `specs/archive/<date>/` |
| **cycle** | `/flow-ship` 發 COMPLETE 後 | 該迭代 delivered 細節收束歸檔，主檔留「當前迭代」+ 歷史一行索引 |
| **staleness** | 文件描述與 code 對不上（已 shipped 細節） | 摘要 + 歸檔，主檔留「接縫契約、未完成 REQ、open questions」 |

**鐵則**：歸檔**不刪除**（移 `specs/archive/`，可回溯）；主檔永遠保持「當前迭代 + 接縫契約 + 索引」精簡態。對齊 `convergence-guide`「先刪尾保 cache prefix」。

---

## 7. 極簡與死 code 清理紀律（回應使用者：不論大改小改都清多餘/不再引用的 code）

**會做，大改小改都做**（含 §6.2 輕量路徑，不豁免）。但「保持極簡」SHALL 配「先驗證再刪」的安全護欄——盲刪「看起來沒用」的 code 是經典 bug 源（動態引用 / reflection / 字串查表 / 測試 / 外部 consumer 可能還在用）。

**分三類處置**：

| 類型 | 處置 |
|---|---|
| **本次改動造成的孤兒**（換掉 fn X → X 與其專屬 import/helper 變死） | **同一個 commit 內直接刪**。這本就是 Karpathy「Surgical Changes」核心，也是極簡本義 |
| **順手撞見的既有死 code**（非本次改動造成） | **先驗證真 0 引用**（全 repo grep，含動態/字串/測試/config）→ 確認死透 → 清掉，走 drive-by footer 或獨立 commit（不靜默略過、也不靜默亂刪）。**大片 / 有疑慮 → 先回報你再動** |
| **legacy/archive/@deprecated 區** | **只回報不刪**（刻意保留區） |

**機制接點**：
- `flow.md` 加一條極簡規則（actively 清死 code + 「先驗證 0 引用」護欄）。
- `code-reviewer`（重寫版）的 code smell 維度本就偵測死 code + drive-by → review 階段抓出來。
- `flow-build`（per-task）+ `flow-ship`（全 diff）執行清理；輕量路徑同樣適用。

> **與你全域 `CLAUDE.md §6.2` 的張力（誠實告知）**：§6.2 現在寫「既有 dead code **只回報不刪**」（保守）。你要的是更積極的「驗證後清掉」——**Flow 採更積極版**（驗證 + surface 後清），這是你對 Flow 的明確指示。要不要把你的全域預設也同步成這個，你說一聲我再動全域檔。

---

## 附錄：本檔依據

- v4 來源：`statelib.mjs` / `dashboard.mjs` / `board.html` / `reconcile.mjs` / `resume.mjs` / `README-v4-foundation.md`（`_v4/sddx-tool/`）
- Flow 現況：`dist/rules/flow.md`、`dist/commands/flow-{build,verify,resume}.md`、`dist/skills/flow-toolkit/references/{tasks-template,orchestration-guide,convergence-guide}.md`、`recipes/parallel-build.js`、`dist/hooks/flow-{session-start,verify-gate}.mjs`
