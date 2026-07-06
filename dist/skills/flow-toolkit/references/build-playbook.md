# Build playbook：波次拓樸細節 + worker prompt 模板 + checkpoint 語法（/flow-build 用）

本檔收 `/flow-build` 展開後太長、不必每次都读的細節。骨架（步驟順序、閘門呼叫時機、exit-2 意義）留在 `flow-build.md` 本文，這裡是「要用到才查」的展開版。

## 一、`wave --compute` 拓樸細節

可並行 = `state` 可推進 ∧ `blockedBy` 已 delivered ∧ `conflictZone` **互不重疊**。**別在 thinking 裡心算波次**——`flow-state wave --compute` 讀 manifest 的 `blockedBy`/`conflictZone` ＋ ledger delivered 做**純拓樸排序**（同層 id 字典序 tie-break、blockedBy 未交付不進波、conflictZone 前綴重疊自動拆波、成環/懸空依賴 exit 2），並**從凍結 requirements.md 逐字抽每個 task 承接的 REQ 區塊**，一起落 `.flow/trace/wave-plan.json`（含 manifest hash + reqHash）＝本波 dispatch 的**唯一事實來源**，取代模型臨場判斷。manifest 事後合法改動 → 重跑本指令。

- **foundation/共用檔先序列**：全域 router / 共享型別 / DB schema / auth（`P-*`）**SHALL 先做完並 merge 進 trunk**，features 才 fan-out——否則大家改同一個檔 = merge 地獄。
- **釘契約**：跨 worker 的接縫用 design.md 釘好的單一 type/schema，各 worker import 同一份。
- **波次寬度合理控制**：多工 ~15x token，只把「真互不依賴＋夠份量」的放進同一波。簡單/相依的別硬塞平行。
- **fan-out 前就緒探針（fail-fast，研究 LocalContextMiddleware）**：先確認環境就緒——依專案 package manager 跑一次 deps install/ci（如 `npm ci`）。lockfile drift / 裝不起來 / 缺工具 → **停下回報**，別讓整波 worker 在壞環境上空轉一輪才一起失敗（這一輪重跑成本 = 整波 ~15x token）。

## 二、worker fan-out prompt 模板（`parallel-build.js` Stage 2 內容）

用 `references/recipes/parallel-build.js` spawn worker，**每 feature 一個**，在同一個工作目錄平行生成。prompt SHALL 帶齊：

- task 描述 + **逐字 REQ 文字**（用 `wave-plan.json` 該 task 的 `reqText`，**別叫 worker 自讀 requirements.md**——同 task＋同凍結 spec → worker 收到逐 byte 相同的規格，堵版本漂移）+ design.md 釘的契約 + 該 feature 的 conflictZone（worker 只准碰這些檔）
- **紅軍攻擊面 → 先寫失敗安全測試、再用防禦碼轉綠**
- **TDD 三相**（見 `verification-playbook.md` §TDD）：Red 寫自己的測試檔、單跑出真 assertion failure → Green 最小實作 → Refactor。**每過一相落 checkpoint**（語法見§三）——輕量一行、append-only，開發中當機/被關終端，重啟靠它接續沒做完的相、不重跑整個 task、不覆蓋已寫的檔
- **真實資料鏈路鐵則**：涉 API/資料 SHALL 打真後端真 DB、**禁 mock 假綠**、測試資料 seed 進真 DB；真依賴未 ready（上游 5xx/未實作）→ 標 **BLOCKED**，不准 mock fallback
- **涉 UI 的 feature**：orchestrator 先呼叫 `ui-ux-pro-max` 取 component 級建議（structure / ARIA·keyboard·focus / hover·active·disabled / responsive / animation + shadcn 範例），沿用 spec 階段定的 palette/font/style 當 query context，附進 worker prompt；寫 Green 相時 accessibility 清單逐項實作
- 要求**結構化回傳** `{feature, files, selfCheck{unitGreen,realData}, attackCoverage, blockers, driveBy}`

## 三、worker 禁令清單（同 repo 平行的檔案安全靠這個）

- **檔案邊界（鐵則）**：worker 只新增/改自己 conflictZone 內的檔；不碰共用檔（全域 router／共享型別／`package.json`／lockfile／DB migration／中央 config，那些走序列 foundation）
- **只單跑自己的單元測試檔**，**不跑**整包 build／tsc／dev server／`git commit`（那些會跟其他 worker 搶 `.next`/`tsbuildinfo`/port 與 `.git/index.lock`；整包 build、驗證、commit 一律由主流程序列做，見 flow-build.md Step 4–5）
- **硬出口**：撞 hard block（上游 5xx / 未實作 / rate-limited / 型別契約缺）→ 立即在 `blockers` 回報並停止本 worker，禁反覆重試或自行降級 mock（悶燒會吃掉整波 ~15x token）；orchestrator 收到 blockers 非空 **不得 re-spawn 同一 worker**，直接帶進人工閘門
- **小盒子工具**：每 worker 只給它任務需要的工具，不給全集
- **安全 red flag**（SQLi/auth bypass/密碼明文/缺 WHERE 的 destructive query）→ 在 `driveBy` 標出，不准悶著

## 四、orchestrator 確定性 checkpoint 節點與 `--wave` 語法

**orchestrator 可控的確定性 checkpoint 節點（不靠 worker 自律）**：

1. fan-out 前落 `flow-state checkpoint <代表 id> --phase dispatched --wave <本波 ids>`（順帶對賬本波成員＝wave-plan 某波、manifest 未漂移，比整合前的 scope 更早擋自行併/拆波）
2. worker 回傳後落 `flow-state checkpoint <id> --phase worker-returned`
3. 該 feature 整合完成落 `flow-state checkpoint <id> --phase integrated`

worker 內的 red/green/refactor（`flow-state checkpoint <id> --phase <red|green|refactor> --note "<一句進度>"`）是更細的自報（有更好），但**即使 worker 沒自報，這三個 orchestrator 一定經過的節點也保證有粗粒度接續點**——中斷重啟不會退回「整個 task 從零重做」。

**中斷重啟時**：先跑 `flow-state status` 讀每個開發中 task 的最新 checkpoint，把「上次做到 `<phase>`」塞進該 worker 的 prompt，要它**從該相接續、別重做已完成的相、別覆蓋已寫的檔**——只重 fan-out 沒做完的，不重跑整波（省 ~15x token）。

## 五、序列整合閘門展開（`scope --wave` / `redteam --wave`）

- **檔案安全閘門**：`flow-state scope --wave <本波 ids>` 用**git 真實變動**比對各 feature 宣告的 `conflictZone`——任一檔落在**所有** conflictZone 之外（worker 越界改了共用檔/foundation）→ **exit 2 暫停**，查清是哪個 worker 越界、該檔該不該走序列 foundation，**別硬整合**（這是同 repo 平行的檔案安全底線，模型偽造不了 git diff）。`overlap` 警告＝規劃時 conflictZone 沒切乾淨（同波兩 feature 改同檔有覆寫風險）→ 回 plan 修。
- **紅軍對賬閘門**：`flow-state redteam --wave <本波 ids>` 讀 `.flow/redteam/<id>.json`——缺檔、攻擊清單 <3 個、任一 **high**（或 severity 缺失/非法值，比照 high）攻擊無 `covered` 對應項、其 `testFile` 實際不存在（檔案存在性 script 親驗，worker 自報偽造不了）、或**高危關鍵字攻擊（auth/注入/權限/金流…）無 covered 且無 `.flow/decisions/redteam-waiver-<id>-<attackId>.json` 豁免檔**（severity 自報調不鬆這道）→ **exit 2 暫停**該波整合，補失敗安全測試轉綠／補落檔後重跑。

## 六、`done` 收尾三件套語法

`flow-state done <id>` 一個指令做完原本三件會被漏的事：翻 `tasks.md` 的 `[x]` + 寫 ledger `delivered` + 帶 commit。`<id>` 用 canonical task id（tasks.md/manifest 那個，例 `F-1186-W0-5`，別用 `v1.x/W0-5` 這種對不上 manifest 的裝飾 id）。**done 自帶確定性閘門**：`.flow/state.json` 的 `verify`/`tdd` 空/`none` → exit 2 拒標；**交付成功即把全域 verify/tdd 歸零**——下一個 task 必須有自己的新綠燈，借不到上一個的。commit 成功後補 `flow-state done <id> --commit <sha>`（冪等記 commit sha 進 ledger），讓 `/flow-resume` 對帳能分辨「已交付且已 commit」vs「done 後 commit 前當機」；省這步 → resume 會把該 task 列為「已交付但沒記 commit」提醒你確認。
