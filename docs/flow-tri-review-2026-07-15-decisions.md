# Flow 體檢落地決定書（2026-07-16 使用者逐項拍板）

> 來源：`flow-tri-review-2026-07-15.md`（技術版）＋`-plain.md`（白話版）。
> 本檔記錄使用者逐題彈窗拍板的最終決定，開工前經使用者確認。

## ✅ 落地完成（2026-07-16，v0.29.0）

**34 項全數出貨**，分 5 個 commit（皆在 main）：
- `a52b05f` Wave 0 止血 8 道門（C-1/2/8/9/17/21/22/26）
- `c794664` Wave 1 精準硬化 9 漏洞（C-4/5/6/7/10/11/13/18/19/48/54）
- `f59eb20` Wave 2-3 機制修正 9 項（C-3③/16/20/23/24/44/45/49/51）
- `70a1a9a` C-3① 安檢門四合一（dispatcher，實測冷啟 2002ms→985ms/call）
- `a09d972` Wave 4 文件補句 7 項（C-15/29/33/37/43/58/59）

測試 292→319 全綠；dist↔安裝區零漂移；dispatcher 經 spawnSync 真實路徑驗證三道門皆正常 exit 2。
C-8 依使用者初衷改為「待決單」設計、C-42 喚回強化不加（待決單已大幅減少停等）、C-37 加進藍軍必查。

## ✅ 確定要做（34 項）

### 第 1 批：8 道門（Wave 0 止血，全部數行級）

| 白話 | 編號 | 修法 |
|---|---|---|
| 換電腦後自駕剎車失靈 | C-2 | auto-gate／stop-gate 判 mode 加 manifest fallback（與 reconstruct 同優先序）；flow-resume 自駕續跑前 SHALL 重跑 guardrail-check |
| AI 半夜斷氣沒警報＋空 head 放行 | C-1 | mode=auto 且尚有可推進項時首次 Stop exit 2 擋下並指路；cc.head 判定改「兩者非空且相等」 |
| 該問你的同意書 AI 自己蓋章 | C-8 | **待決單設計（使用者 2026-07-16 拍板，取代原「攔下逼彈窗」）**：① 冒名蓋章照修——auto 模式下 AI 不得建立 `*-waiver` decision（auto-gate 攔）；② 新增待決單機制：關卡重試 2–3 次仍過不了 → 記 pending（試了什麼/為何過不了）→ 繼續其他工作不中斷；③ 其他全部完成後待決單一批彈窗請使用者收尾；④ complete-check 對 pending 非空 exit 2（有待決單不得自稱出貨） |
| 有一份審查底稿可以不交 | C-9 | complete-check 對 plan-check.json 缺檔 exit 2＋一次性 migration waiver |
| 作業直接改成績單 | C-17 | 完成謂詞①接上現成 reconcile()：勾了但沒 done → exit 2 列清單（＋ledger 非空 guard） |
| 資深稽查員被偷換 | C-21 | recipe 呼叫端不再覆蓋 effort，讓 frontmatter xhigh 生效；註明「勿覆寫」 |
| 高風險安全審查做沒做沒人查 | C-22 | spec-ready --freeze 加對賬：高風險關鍵字命中且查無 security-review decision → exit 2 |
| 做完還喊沒做完 | C-26 | shipped 由 complete-check CLI 原子寫入 manifest.phase；補 3 處讀取點判斷 |

### 第 2 批：造假驗證 9 漏洞（Wave 1 精準硬化）

| 白話 | 編號 | 修法 |
|---|---|---|
| 手填假綠過關 | C-10 | spec-gate 擋 state.json 的 verify/tdd 裸寫＋正門改 `flow-state verify-ok` 子命令 |
| 拿任意檔案充當測試證據 | C-11 | evidence 內容驗真（--value 容差內數字／REQ id 特徵字串）；n/a 須 waiver 或警告複核 |
| 舊證據沿用到改壞的新版出貨 | C-7 | code-review 的 HEAD-diff 對賬先做；E2E/PERF 相關-diff 對賬緩後另評 |
| 一張豁免全庫永久有效 | C-19 | 豁免加時間戳＋複核提醒→記檔案 glob 逐檔比對；有豁免仍須跑 journey-check@HEAD |
| 鬼打牆偵測三個洞 | C-13 | 指令正規化分桶（保留 cd 目標）；閘門 CLI 連紅納入偵測；strong 失敗不被 zeroFail 覆蓋 |
| 卸載殘留＋接線手冊漂移 | C-18 | settings.flow.json 定唯一事實來源；uninstall 三入口改動態解析；加對賬測試 |
| 任務編號解析靜默失明 | C-48 | ID_RE 放寬 `[A-Za-z][A-Za-z0-9]*`＋診斷訊息＋單測釘 W0-5/T1-2 |
| worktree 下防護裝錯位置 | C-54 | installPrecommit 改 `--git-common-dir`（一行） |
| 閘門繞過面精選子集 | C-4/5/6 | 僅低成本修：spec-gate 正則排除註解＋unicode 正規化；commit-gate 修 `-m"msg"` 緊湊寫法（連帶修假阻擋）；auto-gate 加 package.json 編輯攔阻；文件誠實標「防誤操作」。cd／間接腳本繞過不修 |

### 第 3 批：拍板加做的機制修正（10 項）

| 白話 | 編號 | 修法 |
|---|---|---|
| 安檢門四合一 | C-3① | 同 matcher 的 PreToolUse hook 合併單支 dispatcher；嚴守各 exit-2 語意＋fail-open＋自測 |
| 碼表＋開機盤點省力 | C-3③ | hook 冷啟量測記錄（為四合一提供前後對照）；syncDrift 改版本號變更才全量比對 |
| 驗收改整批 | C-24 | 波級批次窄驗證選項：整波整合完 spawn 一次 evaluator 驗全部 happy path |
| 考卷一次報全部不及格科目 | C-23 | complete-check 改收集全部失敗統一列印；保留前置 fail-fast |
| 小差事不外包 | C-44 | 委派加規模門檻（>2-3k token 或 task>10）；機械搬移改確定性腳本 |
| 被擋原因分列 | C-49 | redteam floor 訊息分列「severity 觸發／關鍵字觸發」；門檻不動 |
| 裝套件偵測修錯 | C-45 | isNewDependency/extractDepNames 收單一表；extract 前截斷 shell 運算子；parity 測試 |
| 指令手冊對賬 | C-51 | help 補列 journal-archive；測試斷言 help 集合==switch case 集合 |
| 繞道偵測補警告 | C-20 | journey-check 對非字面 goto 印 warning（非阻擋） |
| 誠實註解 | C-16 | design-base-hint 註解改與實際行為（每檔一次）一致；行為不動 |

### 第 4 批：文件補句（7 項，一個 commit 掃尾）

| 白話 | 編號 | 修法 |
|---|---|---|
| 純 API 免畫面原型 | C-43 | projectType 純 API 自動跳過 mockup-check；有 UI 照舊 |
| 輕量路徑規則補半句 | C-29 | Step 0.5 補「小改動沿用既有 design.md、增補一節即可」 |
| 跨語言說明補句 | C-33 | 接縫契約鐵則尾端補 codegen 子句（單一來源生兩端型別） |
| Windows 指令補全 | C-58 | 自駕護欄檢查補完整可執行命令（UTF-8 前綴＋flow-resume 同風格） |
| 編碼分流補句 | C-59 | prototype-guide 補「.ps1 須 BOM；web 資產用 Write/Node 無 BOM」 |
| 檢查能力誠實標註 | C-15 | plan-check 文件標「只驗編號、實質由審查層把關」 |
| 自駕承諾誠實化 | C-37 | 「T1 違規事後對帳」加進 ship 藍軍審查必查清單（.flow/decisions/ 對帳維度） |

## ❌ 確定不做（10 項，使用者拍板維持現狀）

| 項目 | 編號 | 使用者裁決 |
|---|---|---|
| 防毒排除實驗 | C-3② | 不動系統設定 |
| 推送改每波一次 | C-52 | 維持 per-task push（跨電腦即時備份優先） |
| 小改動免湊攻擊情境 | C-12 | 維持嚴格：任何改動都要 3 個情境 |
| 異常問卷合併 | C-14① | 維持逐功能逐題確認 |
| 起手彈窗合併 | C-14②③ | 維持逐一彈窗 |
| 乾淨規格審查一輪收斂 | C-41 | 維持一律兩輪 |
| 憲法再瘦身 | C-46 | 不瘦 |
| 對不相關專案的提醒閉嘴 | C-39+C-47 | 不修 |
| 權限需求用詞軟化 | C-32 | 維持強制注入 |
| 缺套件後路補句 | C-60 | 不補 |
| T1 停等喚回強化（推播＋落檔＋退避） | C-42 | 不加（待決單設計已大幅減少停等場景） |

## 執行方式

- 順序：第 1 批 → 第 2 批 → 第 3 批（C-3① 四合一與 C-24 波級驗收最後做，屬架構級）→ 第 4 批文件掃尾。
- 紀律：每項先寫失敗測試再修（TDD）；每批完成跑全套測試（基線 292 全綠、只增不減）；修 dist/ 後同步安裝區並過 sync-check；每批一個 commit（留在 main，不開分支）。
- 新 script 邏輯進 statelib 純函式＋補單測；root 憲法淨增長 ≤0。
