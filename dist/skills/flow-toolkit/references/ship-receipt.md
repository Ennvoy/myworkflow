# 出貨收據（ship receipt）— complete-check 的人讀 render 層

> **定位：選配、on-demand、純 render。** 完成謂詞的真相永遠是 `flow-state complete-check`（exit 2 機讀對賬）；本收據只是把那份機讀結果畫成一頁給人留存/分享的網頁。**收據存在與否、發布成功與否，皆不影響出貨判定。**

## 觸發時機（護欄一：絕不進熱路徑）

- 只在 `/flow-ship` Step 5 `complete-check` **通過後**、**使用者明說要**時產出。
- 主代理可在 complete-check 通過後用一句話提及「可產出貨收據」，但不彈窗、不追問、不預設產出。
- 禁止綁進任何每輪/每 session 必跑路徑——styled 單頁的 output token 遠高於純文字，這是一次性交付品，不是例行輸出。

## 資料來源（護欄二：只讀機讀記錄，不重算）

| 收據區塊 | 唯一來源 |
|---|---|
| REQ-E2E 對賬矩陣 | `.flow/verify/` verify-e2e 記錄（pass/n-a、evidence、HEAD sha、reqHash；n/a 附 decision id） |
| 效能 budget | verify-perf 達標記錄（實測 value vs budget；超標本就拒記，頁面不該出現紅） |
| Code review | `.flow/code-review/findings.json`（red/yellow、fixed/waiver 終局狀態） |
| 完成謂詞 | `flow-state complete-check` 通過輸出（逐條 ✓） |
| 變動範圍 | `git diff --stat main..HEAD`、HEAD sha、專案版本、日期 |

收據**不得**出現任何非機讀來源的判定——「看起來沒問題」類散文一律不進頁面；缺記錄的條目照實標「無記錄」，不得補綠。

## 產出與發布

1. 組 HTML 寫入 `.flow/reports/ship-receipt.html`——**單一自足頁**：CSS/JS 全內聯、零外部資源、零 CDN（Artifact CSP 擋一切外部請求）；圖表用 inline SVG，不引圖表庫；含中文一律 UTF-8。
2. 發布前 SHALL 先載 `artifact-design` skill 校準版面投資，再用 Artifact 工具發布：favicon 固定 `🧾`、title 固定「<專案名> 出貨收據」；**重發同一檔案路徑＝原地更新同一 URL**（版本歷史自動保留），別換路徑另開新頁。
3. 頁面結構建議（由上而下）：頁首（專案/版本/HEAD sha/日期/complete-check ✓ 徽章）→ REQ-E2E 矩陣（pass 綠、n-a 灰＋decision id）→ REQ-PERF 表（實測 vs budget）→ code review（品質分級、red flag 終局清單、yellow 計數）→ diff 統計。

## 降級（護欄三：Artifact 不可用不影響任何事）

- Artifact 需 claude.ai 登入（API key／Bedrock／Vertex／Foundry 環境沒有）、CMEK/HIPAA/ZDR 組織沒有；**Pro/Max 方案發布後僅本人可見**，分享給他人需 Team/Enterprise（限組織成員）。
- 工具不存在或發布失敗 → 本地 `.flow/reports/ship-receipt.html` 照留（雙擊即開），一句話回報即可，**不重試迴圈、不擋出貨**。

## 版控

`.flow/reports/`（收據 HTML＋Evaluator/code-review 敘述報告）屬耐久證據——`.flow/.gitignore` 是瞬時檔黑名單制，`reports/` 天生照常 track，隨 repo 進版控可回溯。
