# Flow 架構與設計理由

> 把 [`research/harness-engineering-findings.md`](research/harness-engineering-findings.md) 的研究結論，落成可執行的工作流。本檔說明「為什麼這樣設計」。

## 1. 一句話架構

Flow = **5 階段 spec-driven 流程** + **3 條跨階段主軸**（context 預算 / 檔案耐久狀態 / 確定性閘門）。模型是可抽換的 CPU，Flow 是管它的 OS。

```
/flow-spec ──▶ /flow-plan ──▶ /flow-build ──▶ /flow-verify ──▶ /flow-ship
  訪談定版      架構分波        多工交付          獨立驗證          整合出貨
   │             │              │ (波次內並行)      │ (獨立 context)    │
   ▼             ▼              ▼                  ▼                  ▼
 specs/        specs/         同 repo            Playwright         完成謂詞
 requirements  design+tasks   平行生成 workers    真實資料鏈路        → COMPLETE
   └──────────── 人工閘門（你拍板）每階段之間 ────────────────────────┘
```

## 2. `.flow/` 目錄現況地圖

Flow 的狀態**全在磁碟**，不在對話 context（harness 鐵則：狀態外部化 → agent 可拋棄、可恢復、純讀檔接手）。`specs/requirements.md`（凍結）→ `specs/design.md` + `specs/tasks.md` → 各 feature 同 repo 平行生成 → 序列整合進 trunk；`.flow/` 底下是這條主軸沿途落下的機讀證據，`statelib.mjs` 是唯一讀寫入口（write-ahead：先寫意圖再做）。現況：

```
.flow/
├── manifest.json          # wave --compute 算出的波次拓樸（blockedBy/conflictZone）；scope --wave、resume 判 blockedBy 是否已滿足的權威來源
├── state.json             # 當前 task 的衍生指標（phase/tdd/verify/commit），瞬時、可從 journal 重建，不入版控
├── journal.ndjson         # append-only 事件log（含 checkpoint 事件）；reconstruct 的唯一真相，N 個並行 worker 各自進度都留得住
├── lessons.ndjson         # 已知死路（failedApproach/why），再生計畫時 resume 提示別重走
├── ledger/                # 逐 task 交付狀態（delivered/…），tasks.md `[x]` 與此對帳，分歧時以 ledger 為唯一真相
├── decisions/             # 自駕模式 C 類分歧決策 + perf-waiver.json 等豁免記錄
├── trace/
│   ├── req-index.json     # spec-ready --freeze 瞬間落的 REQ 全集＋requirements hash＋HEAD；下游 plan-check/verify-e2e/complete-check 的凍結分母
│   ├── wave-plan.json     # wave --compute 輸出：波次拓樸 + 逐 task 承接的 REQ 區塊（含 manifest/reqHash）；dispatch 給 worker 的唯一事實來源
│   └── plan-check.json    # plan-check 通過後落檔：REQ↔task 覆蓋 + manifest 一致性對賬記錄，complete-check 讀它核對 manifest hash 未漂移
├── redteam/<id>.json      # 每個 feature 的紅軍攻擊清單＋coverage；redteam --wave 整合前擋 high 攻擊未 covered/testFile 不實存
├── code-review/
│   └── findings.json      # 藍軍 code-review 落檔；complete-check 要求 red flag 全終局（fixed/waiver）才准出貨
├── spec-review/           # spec-redteam/spec-consistency/codex 三個 lens 逐輪 ledger（<lens>-r<round>.json）+ resolutions.json；spec-ready --freeze 對賬收斂
└── verify/
    ├── <id>.json          # 逐 REQ-E2E 驗證記錄，complete-check 逐條核對 pass/n-a
    └── perf-<id>.json     # 逐 REQ-PERF 驗證記錄，verify-perf 對賬達標
```

- 讀寫閘門對應：`flow-state done` 讀 `state.json`+`ledger/`；`flow-state spec-ready --freeze` 讀 `spec-review/`＋落 `trace/req-index.json`；`flow-state wave --compute` 落 `manifest.json`+`trace/wave-plan.json`；`flow-state scope --wave`／`redteam --wave` 整合前分別核對 `manifest.json` 與 `redteam/`；`flow-state plan-check` 落 `trace/plan-check.json`；`flow-state complete-check` 一次核對 `trace/req-index.json`＋`verify/`＋`trace/plan-check.json`＋`code-review/findings.json`。
- 瞬時檔（`state.json`／`*.mode`／`monitor.port`／`*.log`）由 `.flow/.gitignore` 排除；其餘（`manifest.json`／`ledger/`／`redteam/`／`verify/`／`decisions/`／`spec-review/`／`trace/`／`code-review/`／`journal.ndjson`／`lessons.ndjson`）是耐久證據，照常 track、換機 clone 即可 `reconstruct`。
- `phase` 偵測讓 `/flow`、`/flow-resume` 從對的地方接續，不重做已 delivered 的。

## 3. 五階段設計理由

### Phase 1 `/flow-spec` — 為什麼「對話優先 + 凍結」
研究：別一次性叫 agent 直接做（context anxiety → 抄捷徑）。先長談需求 → 寫成 specs 檔 → 凍結 → 之後每迴圈確定性重讀同一份（「stack 每次同樣方式配置」）。UI-first：方向錯在幾頁靜態 HTML 擋掉，比 build 到一半才發現便宜 10 倍。彈窗一次一題對齊「模型評估 breadth 易失準」與使用者真正的決策需求。**訪談做成收斂迴圈到 `### 開放問題` 清零，由 `flow-state spec-ready`（exit 2）守、`spec-ready --freeze` 凍結、`flow-spec-gate` hook 擋裸寫繞過**——把「問乾淨才凍結」釘成確定性閘門，是自駕不跑歪的源頭（spec 沒問乾淨＝自駕途中 C 類分歧暴增、AI 猜歪沒人擋）。

### Phase 2 `/flow-plan` — 為什麼「接縫契約釘一處 + 計畫可丟棄」
研究：Böckeler「約束解空間」——跨層介面用單一 type/schema 釘死，**編譯期**就擋「API 形狀 ≠ UI 期望」。計畫是可從 requirements 再生的，別當聖物無止盡打磨（打磨同一個檔 = context 腐化來源）。

### Phase 3 `/flow-build` — 為什麼「混合多工 + 同 repo 平行生成」
研究：Anthropic orchestrator-worker（Opus lead + Sonnet workers 勝單 Opus 90.2%）；多工 ~15x token 故只在真平行+高價值才 fan-out。混合基座 = 波次內 Workflow 腳本確定性 fan-out（可重播、背景跑）+ 階段間人工閘門（研究一致建議人在 spec/每輪/deploy 三點）。foundation 先序列、features 才同 repo 平行生成（conflictZone 算重疊，worker 只寫各自不重疊的檔；build/驗證/commit 序列整合，避開並發 commit/build 互撞）。每 worker 小盒子工具（curated subset，避免 40+ tool def 吃半個視窗）。

### Phase 4 `/flow-verify` — 為什麼「獨立 Evaluator + 真實資料鏈路」
研究最強的一塊：
- **模型評自己 = 病態樂觀者**（幾乎一律給自己高分）→ Evaluator 必須**結構性獨立**（全新 context、只看檔案、對抗人設、few-shot 嚴格）。
- **Böckeler：behavioral 驗證是公認未解的硬問題**——綠 build/過 lint 都不等於功能會動 → Playwright headed 真點擊。
- **真實資料鏈路**（補充需求的可驗定義）：假資料經真 create API seed 進真 DB → UI→真 API→真 DB 讀回。同時驗 (a) API 接通 (b) 資料正確性 scope (c) 真 DB 效能。mock 把這三者全跳過 = 系統性假綠。
- **永不信任 exit 0**（rendering gap）：斷言實際產物，不是看 code。

### Phase 5 `/flow-ship` — 為什麼「完成謂詞」
研究：Ralph 完成訊號——「無限迴圈」其實有終點（所有 story pass → COMPLETE + MAX_ROUNDS）。Flow 完成謂詞 = 所有 task `[x]` ∧ 所有 REQ-E2E 綠 ∧ 所有 REQ-PERF 達 budget ∧ X-* 清空 → 發 COMPLETE 停止迭代。**這是防無限寫入的終點**：滿足就收，不再打磨。

## 4. 三條跨階段主軸

### A. Context 預算（防腐化 = 效率 + 收束的根）
n² attention：可用上限 ~170k、~147k 退化、>60% 變笨。ETH 實證巨型 always-on 檔 −3% 成功率 +20% 成本。對策：薄 root（`rules/flow.md` ~67 行目錄）+ on-demand reference + subagent context firewall（只回 1–2k 蒸餾）+ compaction 先刪尾保 cache prefix（hit 價 = miss 1/10）。

### B. 檔案耐久狀態（多工 + 恢復的根）
Anthropic Managed Agents「brain/hands/session 解耦」+ append-only event log + wake/resume。Flow：狀態進 specs/+.flow/+git，worker 是同 repo 的 cattle（只寫各自不重疊的檔），殺不死、純讀檔 resume。

### C. 確定性閘門（防假裝過關）
Stripe「確定性節點夾住 agentic 迴圈」：git/commit/state 寫入/verify runner 是確定性 hook/script，不靠模型判斷。`flow-state done` 自帶閘門在 verify 空/none 時 exit 2 拒標 delivered——模型沒真跑就過不了關。同理 `flow-state spec-ready`（凍結前驗 `### 開放問題` 清零）+ `flow-spec-gate` hook（擋裸寫 `phase=spec-done` 繞過）把「需求收斂才准凍結」釘成 exit 2——凍結只能走正門、自駕下模型竄改不了狀態檔。

## 5. 為什麼 hook 用 Node 不用 PowerShell

要跨平台一份檔通吃 Windows/mac/linux，且**避開 PS 5.1 + 中文的 cp950/BOM 地雷**（讀寫含中文必亂碼）。Claude Code 必有 Node → Node `.mjs` 是最可攜、最穩的選擇。安裝期的 JSON/CLAUDE.md merge 也用 Node helper（PS5.1 的 JSON 處理不可靠）。

## 6. 安裝模型（可攜性）

`install.ps1`/`install.sh` 把 `dist/` 視為唯一真相，複製進 `~/.claude`、Node helper 做 settings/CLAUDE.md 的冪等 merge、跑外部官方安裝指令。`-ClaudeHome` 參數讓安裝可指向拋棄式 temp 目錄做驗證（驗證安裝檔本身也走「真跑綠燈」紀律）。slash-command 類的 plugin（ui-ux-pro-max）無法被 shell 直接跑 → 試 `claude` CLI、否則寫進 `FLOW-POST-INSTALL.md` 誠實列為手動步驟（不假裝成功）。

## 7. 與既有 harness 框架的關係

Flow 是「**薄 harness + fat skills**」哲學的實作：把可商品化的 file I/O / shell / diff / lint / retry 交給 Claude Code runtime，自己只建**領域判斷層**（訪談紀律、垂直切片、真實資料鏈路驗證、效能硬閘門、確定性閘門）——這層才是 sticky 的護城河。model 當可一行抽換的參數，不 hardcode model-specific 行為。
