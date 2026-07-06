# Flow — Harness-Engineering 開發工作流

> **Agent = Model + Harness**。模型可一行抽換；這套 harness（流程、閘門、驗證、多工、可恢復狀態）才是產品。
> 同一個模型，光換 harness 就能差 10–20 個百分點（≈ 一代模型）；研究指出約 75% 的 agent 失敗是 harness 可修的。
> Flow 把這些研究結論做成一套**可在新電腦一鍵安裝、自包含**的 Claude Code 工作流。

設計依據：[`docs/architecture.md`](docs/architecture.md)、[harness 研究](docs/research/harness-engineering-findings.md)。

---

## 使用者故事

- **作為開發者**，我想要把「一句話的模糊需求」透過一次一題的蘇格拉底訪談 + grill-me 深挖收斂成凍結規格、並用**可互動、像成品的原型**把 UI 定版（照走查台把每條 journey 真點一遍，不是看靜態圖靠想像），**以便**方向錯在最便宜的時點就擋掉，而不是 deliver 到一半才整輪報廢。
- **作為開發者**，我想要每個 task 從 UI 一路做到 DB、紅軍先行、TDD、打**真後端真 DB** 驗到綠才算完成，**以便**「e2e 全綠、進去卻全是假資料」這種假完成從結構上不可能發生。
- **作為開發者**，我想要進度狀態寫進檔案 + git、中斷後純讀檔就能接手，**以便**關機 / 換 session / 換電腦都能無痛接續——agent 可拋棄、狀態殺不死。
- **作為開發者**，我想要用一個指令隨時看現況（哪些 feature 卡在哪、誰在等我決策），**以便**不用一直問「現在做到哪」。
- **作為開發者**，我想要小功能調整能跳過完整訪談但**仍留下 SDD 痕跡**，**以便**貫徹規格驅動的同時不被儀式拖慢。

---

## 安裝

```powershell
# Windows（主力）
git clone https://github.com/Ennvoy/myworkflow.git flow ; cd flow ; ./install.ps1
```
```bash
# mac / linux
git clone https://github.com/Ennvoy/myworkflow.git flow && cd flow && chmod +x install.sh && ./install.sh
```

安裝完**重開 Claude Code**，在你的專案資料夾打 `/flow` 開始（或 `/flow-spec` 從需求訪談起）。

安裝檔（**冪等可重跑、自動備份**）會：
- 把 `dist/` 的 commands / agents / skills / rules / hooks 裝進 `~/.claude`
- 薄規則放進 `~/.claude/rules/flow.md`（rules/ 每 session 自動載入，等同 CLAUDE.md 優先級，不改寫你的 CLAUDE.md）、hook 接線進 `settings.json`
- 裝外部依賴：[mattpocock/skills](https://github.com/mattpocock/skills) 的 productivity 4 個（grill-me / caveman / handoff / write-a-skill，全域 `-g`、只裝進 Claude Code、`--copy` 非互動；Flow 只真正依賴 grill-me）、ui-ux-pro-max plugin、預熱 Playwright Chromium

**旗標**：`-SkipExternal`（跳過外部網路安裝）、`-SkipPlaywright`、`-ClaudeHome <path>`（裝到指定目錄，可測）、`-KarpathyPlugin`（額外裝 karpathy plugin；四原則本已 bake 進規則）。

**移除**：`./uninstall.ps1`（mac/linux：`./uninstall.sh`）。移除 Flow 自有檔（commands / agents / flow-toolkit / rules/flow.md / hooks）並從 `settings.json` 反向拔除 hook 接線；編輯前自動備份、冪等可重跑。預設**保留 git-tools**（commit+push 機制獨立可用），要一起清加 `-RemoveGitTools`（sh：`--remove-git-tools`）。先看會刪什麼用 `-DryRun`（sh：`--dry-run`）。外部 skill 屬第三方不自動移除。

---

## 流程（5 階段，打 `/flow` 一鍵或單階段跑；每階段你拍板才推進）

| 指令 | 階段 | 做什麼 |
|---|---|---|
| `/flow-spec` | 訪談定版 | 蘇格拉底一次一題彈窗 + grill-me 深挖 + **互異機制 lens 審查矩陣**（spec-redteam／spec-consistency，findings 落機讀 ledger 逐條終局），**收斂迴圈問到 `### 開放問題` 清零＋lens 末輪零新發現**（`flow-state spec-ready`／`--freeze` 逐項對賬）→ 凍結 `requirements.md`(EARS) → 產**零依賴互動原型**（全 journey 可點走查、假資料 CRUD、狀態切換；`mockup-check` 閘門守覆蓋）、開瀏覽器、彈窗定 UI＋`ui-signoff` 留檔 |
| `/flow-plan` | 設計 | 架構 + **接縫契約釘一處**（編譯期擋發散）+ 垂直切片 + 依賴分波（`plan-check` 對賬 REQ↔task 覆蓋＋tasks.md↔manifest 一致才凍結） |
| `/flow-build` | 多工交付 | 波次內 Workflow 腳本 fan-out 同 repo 平行生成 worker，紅軍 → TDD → 序列整合（驗證/commit 一個個）→ per-task commit+push（走 git-tools skill） |
| `/flow-verify` | 獨立驗證 | 另開 context 的**對抗性 Evaluator** 用 Playwright headed 真點擊、打真 API、查真 DB；效能硬閘門 |
| `/flow-ship` | 整合出貨 | 跨 feature e2e + 完整效能 + 全 diff `code-reviewer` 審查 + 達成**完成謂詞** → 發 `COMPLETE` |

**輔助**：`/flow`（一鍵總控，偵測起始 phase + 小功能輕量路徑）、`/flow-resume`（中斷接手）、`/flow-compact`（文件收束）。

**小功能輕量路徑**：小調整可跳訪談但**仍寫 SDD**（精簡 REQ + F-task，照走 TDD/真實資料鏈路驗證）；踩到需求級變動（新實體 / 角色 / auth / RBAC / payment / 個資 scope）才升回完整 `/flow-spec`。

---

## 功能特點

- **需求訪談（多角度 review 到機讀收斂才凍結）**：蘇格拉底一次一題彈窗（每題附推薦答案）+ grill-me 連續深挖 + **互異機制 lens 審查矩陣**（spec-redteam 攻擊 spec 文本／spec-consistency 斷開 context 抓全集矛盾；findings 落機讀 ledger、docHash 由 CLI 綁定、逐條走終局不能無痕蒸發），**收斂迴圈把 `### 開放問題` 問到清零＋lens 各 ≥2 輪末輪零新發現**，由 `flow-state spec-ready`／`--freeze` 逐項對賬 + `flow-spec-gate` hook 擋裸寫繞過——**這是自駕不跑歪的源頭**（spec 沒問乾淨＝自駕途中只能猜）；web 類用**零依賴互動原型**把 UI 方向釘死在最早能「親手點過」實體的時點——全 REQ-E2E journey 可點走查、假資料 CRUD 有真實感、可切空/錯誤/權限不足狀態，覆蓋骨架由 `flow-state mockup-check` 閘門機檢（走查台缺卡 / 零入口連結 / 連結 404 / 頁面空殼無 app.js·互動元素 → exit 2）。
- **多工並行（Workflow 模式）**：波次內 fan-out 同 repo 平行生成 worker（只寫各自不重疊的檔）、序列整合、階段間人工閘門；foundation 先序列、features 才並行（靠 `conflictZone` 算準）；成本路由（Opus 編排 / 審查、Sonnet 平行苦工）。
- **真實資料鏈路驗證（禁 mock 假綠）**：對抗性 Evaluator + Playwright headed + 假資料經**真 create API seed 進真 DB 再讀回**；真依賴未 ready 標 BLOCKED，不准 mock fallback 假裝綠。
- **效能硬閘門**：load / render / API 延遲 budget，**p50 + p95**，任一維度不達標 = FAIL，高平均不能買回失敗維度。
- **可恢復狀態（殺不死）**：write-ahead journal + 冷啟動 `reconstruct`，狀態寫進 `.flow/` + git；關機 / 換 session / 換電腦純讀檔接手，**並行多 worker 的中斷點各自獨立、不互蓋**。
- **紅藍軍獨立 reviewer**：red-team（寫 code 前列攻擊面 + failingTestHint）、code-reviewer（出貨前全 diff 審，red flag 落機讀檔＋進完成謂詞、未終局擋 ship）、spec-redteam／spec-consistency（需求雙 lens 審查）、evaluator（對抗性驗證者）——各自獨立 context、看不到主對話。
- **確定性閘門**：git commit+push（走 git-tools skill：智慧分群提交＋安全推送）、`.flow` 狀態寫入、`flow-commit-gate`（先標再 commit）、`flow-verify-gate`（沒驗不准標完成）、`flow-state wave --compute`（波次拓樸＋worker 逐字投餵）、git 原生 pre-commit 兜底（連不經過 Claude 的 commit 也擋 secrets/垃圾）、verify runner 都是 hook / script / skill 確定性節點，模型不能假裝過關。
- **文件收束防腐化**：單檔 > 50KB（`flow-size-check` hook 自動提醒）/ ship `COMPLETE` 兩道自動觸發歸檔，context 吃緊時另建議手動跑 `/flow-compact`；主檔保持「當前迭代 + 接縫契約 + 索引」精簡態。
- **自包含一鍵裝**：commands / agents / skills / rules / hooks 全打包，冪等可重跑、自動備份，新電腦 `git clone` → 跑一支 script 即可。

---

## 套件結構

```
flow/
├── install.ps1 / install.sh   # 安裝檔（Win 主力 / *nix 鏡像），冪等、自動備份
├── uninstall.ps1 / uninstall.sh # 反安裝檔：移除 Flow 自有檔 + 反向拔 settings.json hook（預設保留 git-tools）
├── README.md / VERSION / LICENSE
├── docs/                       # architecture + harness 研究 + 設計檔
└── dist/                       # 安裝 payload（裝進 ~/.claude）
    ├── commands/flow*.md       # 8 個 /flow* 指令
    ├── agents/                 # red-team / code-reviewer / evaluator / spec-redteam / spec-consistency
    ├── rules/flow.md           # 薄 root 憲法（注入 CLAUDE.md）
    ├── skills/flow-toolkit/    # references + recipes（Workflow 腳本）+ statelib / flow-state.mjs
    ├── skills/git-tools/       # 智慧分群 commit + 安全 push + PR description（Flow commit+push 機制）
    ├── hooks/                  # 11 支：flow-verify-gate / flow-commit-gate / flow-spec-gate / flow-auto-gate / flow-session-start / flow-size-check / flow-stall-monitor / flow-design-base-hint / flow-precommit（git 兜底）/ precommit-install / commit-gate-core（Node，跨平台）＋各 7 份 *.test.mjs＋settings.flow.json；完整清單以 dist/hooks/ 為準
    └── install/                # merge-settings.mjs（裝：hook 接線進 settings.json）/ flow-uninstall.mjs（卸：反向拔 hook + 清舊 FLOW 區塊）
```

---

## License

[MIT](LICENSE) © 2026 Ennvoy
