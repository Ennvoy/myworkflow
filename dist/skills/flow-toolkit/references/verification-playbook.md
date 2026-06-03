# 驗證 playbook：TDD + 矩陣 + 兩層 sensor + 修復迴圈（/flow-verify 用）

**核心命題**：「完成」= 產出物**實際跑起來綠燈**。§ 上游要求「先有客觀紅燈」（TDD），§ 下游要求「客觀綠燈」才算完成。behavioral 驗證是公認最難、最常被假裝過關的——本檔從結構上封死假綠。

## 一、TDD 三相（Red-Green-Refactor，build 階段每層套）

針對「測試清單」每項（REQ + 紅軍攻擊面 + 各層介面契約）跑三相，固定順序：

1. **Red**：寫測試、**實跑 runner**、擷取真實 assertion failure，記 `tdd="red:<ref>"`。
   - **偽紅無效**：collection / import / module-not-found / 語法錯 / runner 起不來 / fixture 爆 ≠ Red。Red SHALL 是「對**尚未實作的行為**斷言失敗」。
2. **Green**：寫**最小實作**（內部資料層 → 業務 → 介面 → 防禦碼順序），實跑轉綠且未弄壞既有測試，記 `tdd="green"`。
3. **Refactor**：全綠前提下整理 code，記 `tdd="refactored"`。

**禁止**沒真跑 runner 就宣稱 red/green（系統性違規）。每相回報跑了什麼命令、紅/綠變化。紅軍每個攻擊情境 SHALL 先寫成失敗安全測試、再用防禦碼轉綠。

**例外**（記 `tdd="n/a"` 或 `tdd="skipped:<原因>"`）：純 typo/docs/一兩行 config（仍跑 linter）、純 refactor（不要求新紅但既有測試全程綠）、spike、使用者明說跳過（寫 Backlog）。

## 二、兩層 sensor

| 層 | 例子 | 特性 | 跑的頻率 |
|---|---|---|---|
| **Computational**（確定性） | tests、ESLint、type-check、SAST、mutation | ms–秒、可靠、確定 | **每個迴圈先跑**（先擋語法錯，別在貴的 e2e 上燒一輪） |
| **Inferential**（LLM 語義） | security review、耦合度 review、code-reviewer | 慢、貴、非確定 | 慢節奏（feature 結尾 / ship） |

兩者都**不取代** behavioral e2e（真去點，它真的會動嗎）——那是 Böckeler 點名的未解缺口，由 Playwright 真實資料鏈路補（見 `playwright-real-data-template.md`）。

## 三、驗證矩陣（依產出物型別選驗法，多型別並存則全跑）

| 型別 | 偵測訊號 | 綠燈條件 |
|---|---|---|
| Web 前端 | SPA/SSR/index.html | production build（禁 dev server）+ Playwright headed + console/pageerror 零 + 真實資料鏈路 + 效能 budget + 關鍵 UI 斷言 |
| 桌面 GUI | Tkinter/PyQt/PySide/Electron、`mainloop()`/`QApplication`/electron main | 真啟動 app（Linux/CI 用 xvfb）+ 程式化驅動真互動（PyQt/PySide→pytest-qt；Electron＝Chromium→Playwright 直驅）+ 視窗真出現、無 traceback/stderr error + 涉資料走真實鏈路（禁 mock）；無法驅動→啟動 smoke+screenshot；真不可能→人工確認+報告（比照 §五保底階梯） |
| 後端 API | server framework | 服務啟動 + health + 打關鍵 endpoint 驗 status/shape（真 DB）+ 啟動 log 無 error |
| DB migration | migration 檔 | 套到可拋棄 DB 成功 + schema 物件存在 +（有 down）round-trip |
| CLI/腳本 | entrypoint/`__main__`/bin | 真執行代表性參數（destructive 先 `--help`/`--dry-run`）→ exit 0、無 traceback/stderr error |
| Library | 純被 import | build + import smoke + 跑測試；無測試則寫最小 smoke + type-check/lint 過 |
| 背景 job/worker | cron/consumer | sample payload 觸發 → 處理完成 + 副作用發生 + 無 dead-letter |
| Infra/IaC | TF/Dockerfile/K8s | validate/plan/build + 容器實際 boot + healthcheck |
| AI/LLM agent | prompt/agent flow | 代表輸入實跑 + 無 API error + 通過 golden case 斷言 |
| 純 config/docs/pure refactor | 無 runtime 產出 | **仍 SHALL** 跑對應 linter/validator + 既有測試仍綠（不是什麼都不做） |

未列型別比照最接近者；原則不變：**一定要有「真的跑起來」的客觀綠燈訊號**。

## 四、修復迴圈（修到綠才算完成）

- **Step 0（起服務型前置）**：bind port 的產出物驗證前清 port（偵測 PID → 本專案舊 server 才終止：Windows `Stop-Process -Id <pid> -Force`、mac/linux `kill -9 <pid>` 或 `lsof -ti:<port>|xargs kill`；外來/不明暫停問）→ 確認載入本次 build（否則驗到卡 port 舊 build = 假綠/假紅）。
- **便宜迴圈無放棄上限**（lint/type/unit）：失敗 → 自動修 → 重跑，每輪回報改了什麼。
- **貴迴圈有界**（完整 headed e2e / CI）：1 次 + 1 次自動修 → 升級暫停問使用者（避免燒 token）。
- **人工 check-in 間隔**：連 3 輪未過 / 同錯連 2 輪改動無效 → 暫停問使用者，回覆後繼續，**狀態維持「未完成」**。check-in 是暫停不是終止，絕不到間隔就收工放生半成品。
- **LoopDetection**：同一檔反覆編輯超過 N 次（doom loop）→ 強制換策略或 check-in。

## 五、保底階梯（理想 runner 不可用時，依序）

(1) 用最接近的自動 runner (2) 依 dependency 預檢**裝**所需 runner（Web 無 Playwright = 裝 + 寫最小 smoke spec）(3) 真環境不可能（無 display/網路/模擬器）→ **硬停**，列風險 + 使用者親口確認 + 寫進報告 + Backlog。**禁止**靜默跳過、**禁止**未綠就標完成、**禁止**偷換 headless 當通過。

## 六、反作弊（系統性違規，SHALL 暫停升報）

- 先寫實作再補必然通過的測試假裝走過 Red
- 沒真跑 runner 就填 `tdd`/`verify`
- 刪改 `state.json` 繞過 hook
- 把偽紅當 Red 證據
- mock 假綠標 completed（見 `playwright-real-data-template.md`）

## 七、commit 前清掃（驗證垃圾，雙軌，build/ship 每次 commit 前 SHALL 做）

驗證/測試會生出一堆**不該進 repo 的東西**；混進 commit 會污染交付 diff、脹大 repo、害 review 失焦。commit 前依**雙軌**清掉——兩軌互補，缺一不可：

- **軌一：檔案型產物（確定性 script ＋ commit-gate 硬擋，不靠模型判斷）** — 跑 `clean-verify-artifacts.mjs --apply --gitignore`（路徑：mac/linux `~/.claude/skills/flow-toolkit/`、Windows `$env:USERPROFILE\.claude\skills\flow-toolkit\`）。白名單整刪：**Playwright MCP `.playwright-mcp/`／`playwright-mcp-output/`（console-*.log／page-*.yml a11y snapshot／截圖）**、Playwright `test-results/`/`playwright-report/`/`.playwright/`/`.last-run.json`/`*.trace.zip`、覆蓋率 `coverage/`/`.nyc_output/`/`htmlcov/`、`.pytest_cache/`/`__pycache__/`/`*.pyc`、各種 `*.log`（含 `.flow/*.log`）、一次性 `debug-*`/`tmp-*`/`*.tmp`（**Tier A：無條件清**）；散落截圖 `screenshot-*`/`snap-*`/`page-*.png`、錄影 `*.webm`（**Tier B：僅 git untracked 才清**，不誤殺 tracked 資產／設計稿），並把 pattern 補進專案 `.gitignore`（冪等 managed block）。省 `--apply` = dry-run 預覽（有東西沒清 exit 3）。**沒清就 commit → `flow-commit-gate` 閘門一 exit 2 擋下**（staged 含 Tier A／產物目錄即擋，判斷與本 script 共用同一白名單）。
- **軌二：語意型殘留（靠 review，script 碰不到）** — 看本次 `git diff`，刪掉混在 **source** 裡的一次性 debug 殘留：`console.log`/`print`/`dump`、暫時註解掉的程式塊、為跑驗證臨時寫的 scratch 腳本。

**絕不清（交付物 / 耐久狀態，script 已硬擋，review 也別誤刪）**：source 測試檔（`*.test.*`/`*.spec.*`/`*_test.*`/`conftest.py`）、`specs/`、`.flow/` 的 `ledger`/`journal.ndjson`/`manifest.json`、`legacy/`/`archive/`/`vendor/`/`node_modules/`。

**範圍邊界**：本節只清「驗證產物 + 一次性 debug 殘留」。**mock/stub/寫死 fixture 假綠**屬 §六 反作弊，是「改回真實鏈路」不是「清垃圾」，另案處理、不在 clean script 職責內。
