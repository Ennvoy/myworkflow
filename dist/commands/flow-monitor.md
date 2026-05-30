---
description: Flow 監控看板 — 起一個唯讀即時看板，投影當前專案 specs/tasks.md + .flow/ 進度（自動找空 port、冪等、多專案並行不撞）。決策一律回 Claude 彈窗，看板只顯示。
---

# /flow-monitor

起當前專案的**唯讀監控看板**（決策/討論回 Claude 彈窗，不在看板做）。

## 啟動

1. **背景啟動**（自動找空 port——占用就 +1，多專案並行各拿一個；先設 console UTF-8）：
   ```powershell
   [Console]::OutputEncoding=[Text.Encoding]::UTF8
   node "$env:USERPROFILE\.claude\skills\flow-toolkit\dashboard.mjs"
   ```
   （等同 `node ...\dashboard.mjs <專案根> [偏好port]`，省略則讀 cwd、port 4317 起跳。）
2. **讀啟動輸出印出的實際網址**（如 `http://127.0.0.1:4317`，被占用時可能 4318…），記到 `.flow/monitor.port`，用 `Start-Process "<該網址>"` 開瀏覽器送到使用者眼前（0 摩擦）。
3. 看板每 2 秒投影：5 階段 ribbon、完成謂詞面板、kanban（待開發/開發中/驗收中/已交付）。卡片標 ⚠️ 等你決策 = 回 Claude `/flow-resume` 拍板。

## 冪等自動開（被 build/resume 呼叫時）

`/flow-build`、`/flow` 推進到 build、`/flow-resume` 偵測到專案在 build 中 → **自動呼叫本指令一次**：
- 先讀 `.flow/monitor.port`，若該 port 的 server 還活著（GET `/status.json` 200）→ **重用、不再開新 server / 新分頁**。
- 死了或無紀錄 → 起新的、寫回 `.flow/monitor.port`、開瀏覽器。

> 換 session / 重開機後跑 `/flow-resume` 接續開發時，monitor 一併自動開（讀檔重建現況即投影）。bare session-start 不自動開（hook 只提醒），避免劫持瀏覽器。

## 停止

`/flow-monitor stop`：讀 `.flow/monitor.port` 對應的 process 收掉（PID 辨識，只殺本看板、不盲殺外來 process）；或使用者自行 Ctrl+C。

## 紀律

- **唯讀**：只讀 `specs/tasks.md` + `.flow/` + git，不寫任何狀態、不進 Claude context、不吃 token。
- **決策回 Claude 彈窗**：看板只「顯示」等你決策，拍板走 `/flow-resume`。
- **多專案並行**：各專案各起一個、自動拿不同 port、互不撞。
