---
name: git-tools
description: 當使用者要求「commit」、「提交」、「智慧提交」、「拆分 commit」、「smart commit」、「push」、「推送」、「commit+push」、「提交並推送」、「寫 PR」、「PR 描述」、「PR description」、「建立 PR」、「Pull Request」，或需要 Git 提交、推送與 PR 操作時，應啟用此技能。提供智慧拆分提交、安全推送遠端與自動 PR 描述產生功能。
version: 1.1.0
---

# Git 工具 Skill

提供三個核心功能：**Git Smart Commit**（智慧拆分提交）、**安全 Push**（commit 後推送遠端）與 **Git PR Description**（自動產生 PR 描述）。

> Flow 工作流的 per-task commit+push 與 ship 出貨提交都走本 skill：commit 的語意分群需要模型判斷（純 script 做不好），但「提交＋推送這個動作」本身是 Flow 的確定性節點，狀態會落 `.flow/`。

---

## 啟動協議

觸發後，依使用者意圖判斷執行路徑：

1. 提及 commit / 提交 / 智慧提交 → 執行 **Smart Commit 流程**（含 push，見下方推送策略）
2. 提及 push / 推送（單獨）→ 執行 **安全 Push 流程**
3. 提及 PR / Pull Request → 執行 **PR Description 流程**
4. 不確定 → 用 `AskUserQuestion` 詢問

---

## 一、Git Smart Commit 流程

將所有 staged / unstaged 變更，依功能邏輯自動分群後逐批提交，產出乾淨的 conventional commit 歷史，**最後推送遠端**。

詳細流程見 [references/smart-commit.md](references/smart-commit.md)。

### 流程摘要

```
檢查變更 → 分析分群 → 產出計畫 → 逐批執行 → 推送遠端 → 展示結果
```

### 分群優先順序

| 優先級 | 維度 | 範例 |
|--------|------|------|
| 1 | 專案設定檔 | package.json, vite.config.*, .gitignore |
| 2 | 資料層 | src/data/*, src/constants/* |
| 3 | 元件（按名稱分組） | JSX + 樣式 + 測試 |
| 4 | 頁面 / 路由 | src/pages/*, App.* |
| 5 | 全域樣式 | src/index.css, src/styles/* |
| 6 | 工具 / hooks / 型別 | src/utils/*, src/hooks/* |
| 7 | 測試 | *.test.*, *.spec.* |
| 8 | 文件 / 其他 | docs/*, *.md |

### Commit Message 格式

```
<type>(<scope>): <簡短描述，繁體中文>
```

| type | 時機 |
|------|------|
| feat | 新增功能 |
| fix | 修復 bug |
| style | 純樣式 |
| refactor | 重構 |
| chore | 雜務、設定 |
| docs | 文件 |
| test | 測試 |

---

## 二、安全 Push（commit 後推送遠端）

Smart Commit 收尾、或被單獨要求 push 時，依下列**安全策略**推送（完整步驟見 [references/smart-commit.md](references/smart-commit.md) 步驟 6）：

| 情境 | 動作 |
|------|------|
| 無 remote（`git remote` 空） | 跳過 push，告知「無遠端、僅本地 commit」 |
| 當前分支**已有** upstream | 直接 `git push` |
| 當前分支**無** upstream（新分支） | 用 `AskUserQuestion` 白話問是否 `git push --set-upstream origin <branch>`，同意才推 |
| push 失敗（網路 / 拒絕 / 非快轉） | **回報失敗原因、不靜默吞掉**；非快轉先 `git fetch` 看落後狀況，不擅自 `--force` |

**鐵則**：絕不 `git push --force` / `--force-with-lease`，除非使用者明確要求；推前不改寫他人歷史。

---

## 三、Git PR Description 流程

根據分支差異自動產出結構化 PR Title + Description。

詳細流程見 [references/pr-description.md](references/pr-description.md)。

### 流程摘要

```
確認分支 → 蒐集 diff → 分析變更 → 產出 PR Title + Description → 輸出 code block
```

### PR Description 結構

```markdown
## 🎯 為什麼要這樣做
## ⚠️ 修改的內容（按功能分組，禁止檔案路徑）
## 🧪 測試步驟
```

### 格式規範

- 禁止 Markdown 連結格式 `[文字](...)`
- 禁止 URI / scheme
- 禁止出現檔案路徑，一律改用功能描述

---

## 衝突處理

偵測到 Git 衝突時：

1. `git status --short` 辨識衝突檔案
2. 列出衝突摘要（檔案、類型、原因、區段）
3. 逐一展示衝突內容，用 `AskUserQuestion` 提供選項：保留本地 / 保留遠端 / 手動合併 / 同時保留
4. 解決後 `git add` + `git commit`

---

## 邊界情況

- `.env` 或敏感檔案 → 提醒確認是否應被 .gitignore
- 變更 > 50 個檔案 → 產出分組摘要後直接提交（摘要供事後檢視，不阻擋）
- 已有部分 staged → 尊重已 staged 狀態
- 衝突含二進位檔 → 提醒使用者手動選擇
- push 遇 `.env` 等敏感檔已被 commit → 暫停提醒，先處理再推

---

## References 索引

| Reference | 檔案 | 說明 |
|-----------|------|------|
| Smart Commit | [references/smart-commit.md](references/smart-commit.md) | 完整分群規則、執行細節與安全 push |
| PR Description | [references/pr-description.md](references/pr-description.md) | 完整 PR 產生流程與格式 |
