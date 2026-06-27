# 自駕模式（Autonomous Flow）：spec 定版後 AI 自主跑到出貨

> 核心理念（使用者拍板）：**把人抽離**——談完需求後，AI 自主把所有需求做完，只有**必要分歧**才同步停下確認。這是 loop engineering 的本義（Addy Osmani：把自己從「prompt agent 的人」換成「設計會自己 prompt agent 的系統」）。`/flow` 起手一次性彈窗選「自駕到出貨 / 每階段停」，選自駕即寫 `.flow/state.json` `mode:"auto"`。

## 邊界：spec 互動、其後自駕

- **spec 階段照常互動**（蘇格拉底訪談、異常路徑自檢、spec-reviewer、UI 對焦定版）——人在這裡把需求問透，這是「談需求」本身，不是要抽離的關卡。
  - **收斂是確定性閘門、非散文自評**：訪談 SHALL 跑成收斂迴圈到 `### 開放問題` 清零，由 `flow-state spec-ready`（exit 2）守、`spec-ready --freeze` 凍結、`flow-spec-gate` hook 擋裸寫繞過。**這是自駕安全的源頭**：spec 沒問乾淨＝自駕途中 C 類分歧暴增＝AI 猜歪沒人擋。把「問乾淨」做成 exit 2，下面 T1 放手才安全。
- **spec 凍結後**：`plan → build → verify → ship` **自動接續、階段交界不暫停**，只有下面 T1 必停集合會同步彈窗。完成謂詞達標 → 發 `<promise>COMPLETE</promise>` 收束。

## T1 必停集合（自駕下「碰到就立刻同步彈窗」的唯一清單）

只有這些會打斷自駕（其餘一律 AI 自決＋記錄）：

1. **需求骨架變動** → 新實體 / 新角色 / auth / RBAC / payment / 個資 scope：**強制升回 `/flow-spec`**（憲法「小功能輕量路徑」安全閘門）。
2. **裝新 dependency**（新增第三方套件）。
3. **破壞性 DB 操作**：DROP / TRUNCATE / 無 WHERE 的 DELETE·UPDATE / 會毀既有資料的 migration。
4. **安全紅旗**：SQL injection / auth bypass / 密碼明文 / destructive query 缺 WHERE（`/flow-build` Step 4 本就暫停）。
5. **stall 升級**：`flow-stall-monitor` 偵測「同一失敗連 ≥N 輪、改動無效」注入 STALL → 立刻 `AskUserQuestion` 同步升級（白話講卡在哪、試過什麼、要你決定什麼）。
6. **波次執行策略偏離預設平行**：把已算出的並行波降級成序列/部分平行（`/flow-build` Step 1.5，仍 Ask-first，不在散文裡自決）。

> 對齊憲法三層邊界：T1 = 既有「Ask first」清單**減去「跨階段推進」**（自駕把跨階段推進自動化）、**加上 stall 升級**。其餘 Ask-first 與所有 Never 規則不變。

**T1 的執法強度（誠實）**：②裝新相依、③破壞性 DB、⑤stall 升級的硬天花板，由 `flow-auto-gate`（PreToolUse，僅 `mode:auto`）**exit-2 硬擋**，模型滑不過。**①需求骨架變動、④安全紅旗**本質是語義判斷、做不成確定性閘門 → 屬**盡力而為的散文約束、非硬保證**；為補強，自駕下「碰 ①④ 該停卻自決了」由 ship 階段全 diff 審查與 `.flow/decisions/` 對賬事後抓。別把自駕當成對整個 T1 有確定性防護。

## 自決 + 記錄紀律（T1 之外的分歧 AI 自己拍板）

**C 類分歧**＝spec 沒釘死的**需求語意**選擇，例：刪父層時子資源連帶失效或保留、列表排序/分頁預設、空狀態文案、欄位預設值、邊界值處置、錯誤碼選擇。這些**不打斷使用者**：

1. AI 挑一個**合理預設**（沿用 spec 既定調性、業界慣例、最小驚訝原則）。
2. **記審計線**：`flow-state decision <id> --choice "<決定了什麼>" --why "<理由>"`（落 `.flow/journal.ndjson` ev:`decision` + `.flow/decisions/<id>.json` 快照）。使用者可事後翻、要改再說。
3. 做下去，不停。

> 純技術選型（UUID vs 短碼、一頁幾筆這種「怎麼做都對、有明確最佳實踐」的）連 decision 都不必記——直接做。只有「猜了使用者需求意圖」的 C 類才記。

## 護欄前提（自駕依賴）

自駕啟動前 SHALL 跑 `flow-state guardrail-check`（驗 B1 在線）；缺則退回「每階段停」、**不假裝自駕**。

- **B1 stall 斷路器（硬前提）**：兩段式——`flow-stall-monitor`（PostToolUse）偵測同一 runner 失敗連 ≥N 輪、注入**軟**升級提醒；`flow-auto-gate`（PreToolUse，僅 `mode:auto`）在連 ≥N+3 輪時**硬擋 exit 2** 下一次同 runner 重跑。
  - **誠實定位**：偵測是確定性的（優先讀 runner 真實 exit code、無則 best-effort 掃失敗標記；分桶 key 用命令、journal 跨 session 模型偽造不了）。**涵蓋面**＝主 session 的 test/build/typecheck/lint runner 命令；**worker 內 TDD 單跑迴圈**靠 `parallel-build.js`「BLOCKED 單發即返＋收斂端不 re-spawn」硬出口守；**純編輯、完全不跑任何命令的迴圈**不在 B1 涵蓋內（靠模型自律＋修復迴圈 check-in）。
  - **無花費上限的取捨**：B1 把最常見的「反覆跑失敗 runner」整夜燒錢擋住，但非萬無一失。**仍強烈建議自駕搭一個外部 token/時間上限**當最終保險（使用者已選不設花費上限，故此為提醒、非阻擋）。
- **B2 context 自動收束（建議在線、非阻擋）**：`flow-size-check` 讀 transcript 真實視窗用量 >~60% 提醒收束。缺則品質風險、非燒錢級。
- **B3 失敗記憶（建議在線、非阻擋）**：`flow-state lesson` + reconstruct 帶出「已知死路」，防再生撞同一面牆。

## resume 行為

`mode:"auto"` 時 `/flow-resume` **續跑自駕**（不每階段問），先 `flow-state resume` 印現況 + 已知死路，再從斷點自動推進；列出自駕期間的自決 decisions 摘要供使用者掃一眼。仍尊重 T1：碰到必停集合才彈窗。
