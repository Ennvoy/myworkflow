---
description: Flow Phase 4 — 獨立驗證。另開 context 的 Evaluator 用 Playwright headed 真點擊、打真 API、查真 DB（真實資料鏈路、禁 mock 假綠），效能是硬閘門，修到綠才算完成
---

# /flow-verify — Phase 4：獨立驗證迴圈

**核心命題**：**「完成」= 產出物實際跑起來綠燈**——不是 code 看起來對、不是過 lint、不是測試框架有跑。**behavioral 驗證（真去點，它真的會動嗎）是公認最難、最常被假裝過關的一環**，本階段從結構上封死假綠。

兩種呼叫範圍：**窄範圍**（`/flow-build` 每個 feature 結尾跑該 feature happy path）、**全範圍**（`/flow-ship` 跑跨 feature）。

## 鐵則一：Evaluator 必須結構性獨立（反自評樂觀）

模型評自己的工作是「病態樂觀者」，幾乎一律給自己高分。所以驗證**不能由寫 code 的同一個 agent 自證**，SHALL 另開獨立 Evaluator——**人設已釘成 `evaluator` agent 定義檔（dist/agents/evaluator.md），SHALL 用該 subagent 呼叫、禁在主迴圈即席轉述人設**（散文轉述＝每 run 嚴格度浮動）：
- **全新 context + 固定對抗 system prompt**（每輪重啟，看不到 builder 的 chain-of-thought；定義檔內含 few-shot 嚴格評分範例——開箱模型當 QA 太寬鬆）
- **只透過檔案溝通**：Evaluator 讀「coding 前就釘好的契約」（REQ-E2E-* / REQ-PERF-* / design.md 接縫）+ 跑出的 artifact，回一份結構化 PASS/FAIL 報告並**逐條 `flow-state verify-e2e` 落機讀證據**，不跟 builder 對話

可用 `references/recipes/parallel-verify.js`（Workflow 腳本，已綁 `agentType: 'evaluator'`）對多個維度/feature 平行起獨立 Evaluator。

**decorrelation 兩級**：上面是「跨 context」級（全新 context＋對抗人設，已是業界硬規格）。對**沒有 runner 可錨定的 inferential 維度**（security / 耦合度這類純 LLM 語義判斷）可再上一級「**跨 model 家族**」評估，進一步去 self-preference bias（模型偏愛自己風格的產出）。但**有真 runner 的維度（功能 / 真實鏈路 / 效能）以 runner 為唯一真、不換 model**——外接一個讀不懂執行軌跡的 model 反而更差（CMU 反例）。故跨 model 只套在 inferential 軟維度，computational 維度照跑 runner。

## 鐵則二：真實資料鏈路（禁 mock 假綠）

涉資料的驗證 SHALL 走 **UI → 真 API → 真 query → 真 DB**（可拋棄/local test DB）。**禁止**在 API client/網路層/前端用 mock/stub/MSW/寫死 fixture 攔截回假 response 冒充功能完成。
- **測試資料首選透過真實 create API 路徑 seed** 進真 DB（連寫入鏈路一起驗），最低限度經 seed script 進真 DB；不得用記憶體假資料冒充。測試帳號亦同。
- **三重驗證目的**：(a) 真 API 接通 (b) 資料正確性（query / join / filter / **scope** / 序列化 / 型別）(c) 效能（真 DB 延遲 / N+1 / index / 分頁）。mock 把這三者全跳過。
- **真依賴未 ready → 標 BLOCKED**，禁 mock fallback 假裝綠或標 completed。mock 只准在開發中途當鷹架，驗收前全數拆除。
- **例外**——外部副作用 API（金流/簡訊/email/付費 LLM，真打有費用/副作用）：**首選官方 sandbox / test mode 真打**；無 sandbox 才允許 mock，但報告 SHALL 明確標記「此依賴為 mock、未驗真實串接」。禁 mock 只規範「自己掌控的 API + DB」這條鏈路。

## 鐵則三：Web 三鐵則 + 永不信任 exit 0

Web 驗證（完整範本 `references/playwright-real-data-template.md`）：
1. **production build**（禁 dev server 噪音：`build && preview/start`，不是 `dev`）
2. **Playwright `--headed`**（禁 headless；使用者要親眼看 / AI 透過 listener 抓 error）
3. **attach `page.on('console')` + `page.on('pageerror')` listener**，結尾 `expect(errors).toHaveLength(0)` + 關鍵 UI 斷言 + **打真 API 端點驗 status/shape** + **查真 DB 狀態**
4. **從入口走完整 journey（禁直接 `goto` 目標頁）**——這是**導航版的「禁 mock 假綠」**（鐵則二的姊妹）：只有一個 `goto` 指向**這條 journey 的真實使用者起點**，其後全用 `getByRole(...).click()` 等真實互動串到目標頁、再操作功能、斷言結果。直接 deep-link 跳目標＝頁面孤立能動 ≠ 使用者到得了（跳過斷掉的導航連結、路徑上的 auth/session 把關、沿途累積狀態）。
   - **入口不是教條**：多數功能起點＝login → 首頁 → 導航進去；**分享連結 / email 連結 / 付款回調類**起點**就是那個連結本身**（但仍走「收到→點開→看到內容」的真實流程，不是 goto 內部頁）。Evaluator 對「直接 deep-link 跳目標頁」判該 journey 維度 **FAIL**，並記下實際點擊軌跡當證據。

**永不信任 exit 0（rendering gap）**：改了檔但沒真正 materialise 會靜默 no-op，agent 卻以為成功。**斷言實際產物**（DB 撈得到剛 seed 的列、UI 畫得出來、API 回正確 shape），不是看 code 對不對。

## 鐵則四：效能是硬閘門（不准平均）

依 `REQ-PERF-*` 設 budget，**任一維度低於 floor → 整體 FAIL**，高平均不能買回失敗維度（細節 `references/perf-budget.md`）：
- 量 **load（LCP/TTFB）+ render（互動延遲）+ API 延遲**，**p50 與 p95 都量**（尾延遲才是體驗殺手）
- 「讀取或渲染太久」**就是驗證不通過**——不是警告，是 FAIL
- 貴資源（DB/browser/container）lazy 起、別擋首 token 路徑
- **成本分層（窄 vs 全）**：`/flow-build` 窄範圍每 feature 只跑**便宜 smoke**（少量請求抓粗暴退化、fail-fast 早擋）；**嚴謹 p50/p95（代表性資料量、N+1/index/分頁）由 `/flow-ship` 完整效能閘門量一次**（完成謂詞硬擋，不漏接）。避免最貴又不可平行的嚴謹量測在每 feature ×N 重燒。

## 兩層 sensor + 有界重試

- **Computational sensor**（便宜、確定性、ms–秒）：lint / type-check / unit / 既有測試 → **每個迴圈先跑**，當快速回饋（先擋語法錯，別在貴的 headed e2e 上燒一輪）。
- **Inferential sensor**（貴、LLM 語義）：security / 耦合 review → 慢節奏跑。
- **修復迴圈**：失敗 → 自動修 → 重跑。**便宜迴圈放寬上限但非無限**——lint/type/unit/build 命令會被 `flow-stall-monitor` 斷路器記帳，同一失敗連 ≥N 輪注入 STALL、自駕下連 ≥N+3 輪 `flow-auto-gate` 硬擋（防「lint 一直紅但每次不一樣」整夜燒）；**貴迴圈（完整 headed e2e / CI）有界**：1 次 + 1 次自動修 → 升級暫停問使用者。**check-in 間隔**（連 3 輪未過 / 同錯連 2 輪改動無效）→ 暫停問使用者，回覆後繼續，狀態維持「未完成」。**check-in 是暫停不是終止**，絕不到間隔就收工放生半成品。

## Step 0：起服務前置（避免驗到卡 port 的舊 build）

bind/listen port 的產出物驗證前 SHALL 清 port：偵測 PID → 是本專案舊 server 才終止（Windows `Stop-Process -Id <pid> -Force`、mac/linux `kill -9 <pid>`，或 `lsof -ti:<port> | xargs kill`）、外來/不明 process 暫停問使用者 → 確認載入本次 build。

## journey 真實性閘門（web 宣稱綠前 SHALL 跑，確定性節點）

Web 產出物宣稱綠**之前 SHALL 跑** `flow-state journey-check`（mac/linux `node ~/.claude/skills/flow-toolkit/flow-state.mjs journey-check`、Windows PS 對應路徑）——它確定性掃 Playwright 測試檔，**出現網路攔截/假後端（`page.route`/MSW/`nock`/`cy.intercept`/`mockResolvedValue`）或單一 test 內 >1 `goto` 即 exit 2**，並掃 `playwright.config`：**`retries` 非 0（flaky 靠重試洗綠；CI 真 flaky 才留、須 `flow-state decision retry-waiver` 留檔）或 `webServer` command 含 `dev`（禁 dev server 噪音）也 exit 2**。把鐵則二（禁 mock）＋鐵則三（禁 dev server）＋鐵則五（單一入口 goto）從散文釘成機器擋。純文字掃描、模型偽造不了 git 真實檔內容。深層 goto／零互動只提醒不擋（loose 防誤殺，仍須 Evaluator 人工確認非抄捷徑）。

## verify runner wrapper（非白名單 runner／要綁 task 對賬時用）

跑 `make test`／`docker compose run`／自寫 script 等 `RUNNER_RE` 白名單外的 runner，或要讓 done 閘門認得「這個 task 真跑綠了」時，走 **`flow-state run --task <id> -- <runner 命令>`**：它真跑命令、捕**真實 exit code**、綁 taskId 落 journal。**done 閘門據此擋「用 runner 跑過、最後一次是紅、卻硬標 done」**（沒走 run 的 task 不受影響，退回 verify/tdd 閘門，不誤擋 MCP 真點擊路徑）。適用簡單命令；含 shell 元字元的內聯 code 請放腳本檔再跑。

## PreCompletion 退出閘門

退出前對照原始 spec 跑一次驗證 checklist，**不准在 checklist 未全綠時宣稱 done**。綠 →
- node 呼叫 `statelib.transition(root, id, 'building', 'verifying')` + `writeStateJson` 寫 `verify="ok:<證據ref>"`、`tdd="green"`、`verifyTaskId="<這個 task 的 canonical id>"`（落 `.flow/` ledger/journal + 給 hook 讀）。**不要在 verify 階段直接 transition 到 `delivered`**——`delivered` 是 `flow-state done`（markTaskDone）的**唯一正門**，由它在交付時翻 tasks.md `[x]`、寫 ledger，並**一定清掉綠燈 latch**（verify/tdd/verifyTaskId 歸零）。verify 搶先標 `delivered` 會讓 done 的歸零被跳過（`from===delivered`）、綠燈殘留 → 下一個 task 白嫖（連舊專案也防不住）。**`verifyTaskId` 必寫、用本 task canonical id**——done 閘門靠它確認綠燈屬於這個 task（嚴格比對；舊專案沒寫則退回原全域檢查、不誤擋）；
- **每條真跑綠的 `REQ-E2E-*` journey SHALL 記一筆**：`flow-state verify-e2e <REQ-E2E-id> --status pass --evidence "<trace 路徑/測試名/API+DB 讀回摘要>"`。CLI 自動記 **HEAD sha＋現行 requirements.md hash**——ship 出口 `complete-check` 據此驗「這條 journey 驗的是凍結那版 spec」。無法自動化的標 `--status n/a --decision <id>`（**n/a 不再是自由逃生口，SHALL 附實存 decision**：互動＝使用者拍板、自駕＝自決審計）。這是 `complete-check`/`coverage` **逐條對賬 requirements.md 的機讀來源**——沒記＝該 journey 視為未驗，ship 會擋。
- **REQ-E2E 的 pass 記錄 SHALL 來自 CLI runner 跑對應測試檔**（`npx playwright test <骨架>` 或 `flow-state run --task`）；MCP 互動點擊當探索/除錯用，不作為 verify-e2e 落檔依據——把兩條驗證路徑收斂成一條可對賬的。

不綠 → 進修復迴圈。

## 全綠後：驗證垃圾清理（失敗一律保留 artifact 供 debug）

- **檔案型產物（確定性，全綠後 SHALL 跑）**：`node "<flow-toolkit>/clean-verify-artifacts.mjs" --root <repo> --apply --gitignore`（路徑：Windows PS `$env:USERPROFILE\.claude\skills\flow-toolkit\`、mac/linux `~/.claude/skills/flow-toolkit/`）。白名單整刪 **Playwright MCP 的 `.playwright-mcp/`（console-*.log / page-*.yml a11y snapshot / 截圖）**、`test-results/`、coverage、`*.log`、`*.trace.zip`、`__pycache__` 等，並補 `.gitignore`；保 source 測試檔／specs／`.flow` ledger／baseline。**沒清就 commit 會被 `flow-commit-gate` 閘門一 exit 2 擋下**（先清、再 commit，對稱於「先標、再 commit」）。
- 自起 process（PID 辨識，外來禁盲殺）、拋棄式驗證 DB/container 一併收。
- **C-data 測試資料分層**：L0 可拋棄 DB 整個 drop / L1 持久 local 可精準識別 → DELETE 帶**精確 WHERE**（先列預估、差異即停手）/ L2 無法識別 → 列清單問 / L3 remote/共用/prod → 一律問
- **絕不碰**：`.flow/` 狀態檔、無精確 WHERE 的 DB 刪除、tracked 非可重生檔、失敗時 artifact

## 驗證矩陣（依產出物型別選驗法，多型別並存則全跑）

| 型別 | 綠燈條件 |
|---|---|
| Web 前端 | production build + Playwright headed + console/pageerror 零 + 真實資料鏈路 + 效能 budget |
| 桌面 GUI（Tkinter/PyQt/PySide/Electron） | 真啟動 app（Linux/CI 用 xvfb 虛擬顯示）+ 程式化驅動真互動（PyQt/PySide→pytest-qt 點按鈕/斷言 widget·signal；Electron→Playwright 直驅）+ 視窗真出現、無 traceback + 涉資料走真實鏈路（seed 真 DB→GUI 操作→真讀回，禁 mock）；無法程式化驅動→啟動 smoke+screenshot 存證；真環境不可能→人工親眼確認+寫報告 |
| 後端 API | 服務啟動 + health + 打關鍵 endpoint 驗 status/shape（真 DB）+ 啟動 log 無 error |
| DB migration | 套到可拋棄 DB 成功 + schema 物件存在 + round-trip |
| CLI/腳本 | 真執行代表性參數（destructive 先 --dry-run）→ exit 0、無 traceback |
| Library | build + import smoke + 跑測試 / type-check |
| 純 config/docs | 仍 SHALL 跑對應 linter + 既有測試仍綠（不是什麼都不做） |

未列型別比照最接近者；原則：**一定要有「真的跑起來」的客觀綠燈訊號**。

## 完成判準（self-check）
- [ ] Evaluator 是獨立 context、對抗人設、只看檔案
- [ ] 真實資料鏈路：seed 進真 DB、UI→真 API→真 DB 讀回，無 mock 假綠
- [ ] Web 三鐵則齊（production build + headed + listener 零 error）
- [ ] `flow-state journey-check` 綠（無 mock/網路攔截、每 test 單一入口 goto）
- [ ] 效能每維度達 budget（p50+p95），無「太慢但算過」
- [ ] state.json verify/tdd 由真跑結果寫入，非手填
- [ ] 每條真綠的 `REQ-E2E-*` 已 `flow-state verify-e2e` 記錄（供 ship 對賬）
- [ ] 全綠才清垃圾、失敗保留 artifact
