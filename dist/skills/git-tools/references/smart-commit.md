# Git Smart Commit — 完整執行細節

## 步驟 1：檢查變更狀態

```bash
git status --short
git diff
git diff --cached
```

若無變更，告知使用者後結束。

## 步驟 2：分析並分群

依以下優先順序將檔案變更分群，每組代表一個獨立邏輯單元：

| 優先級 | 維度 | 範例 |
|--------|------|------|
| 1 | 專案設定檔 | `package.json`, `vite.config.*`, `.gitignore` |
| 2 | 資料層 / config data | `src/data/*`, `src/constants/*` |
| 3 | 元件（按元件名稱分組） | 元件 JSX + 對應樣式 + 對應測試 |
| 4 | 頁面 / 路由 | `src/pages/*`, `src/App.jsx` |
| 5 | 全域樣式 | `src/index.css`, `src/styles/*` |
| 6 | 工具 / hooks / 型別 | `src/utils/*`, `src/hooks/*` |
| 7 | 測試 | `*.test.*`, `*.spec.*` |
| 8 | 文件 / 其他 | `docs/*`, `*.md` |

### 分群規則

- 同一元件的 JSX + CSS Module + 測試 → 歸同一組
- 極小改動（< 5 行）→ 合併到最相關的鄰近組
- 新增檔案用 `feat`，修改用 `fix`/`refactor`/`style`，刪除用 `chore`

## 步驟 3：產出 Commit 計畫

先列出計畫並展示（**不需使用者確認，直接執行**；衝突 / `.env` 等敏感檔才問）：

```
📋 Commit 計畫（共 N 個 commit）

1. chore(project): 初始化專案設定與相依套件
   → package.json, vite.config.js, .gitignore

2. feat(data): 新增首頁各區塊的設定資料
   → src/data/navigation.js, src/data/hero.js

3. feat(navbar): 新增 Navbar 元件（含 RWD 漢堡選單）
   → src/components/Navbar.jsx

→ 直接逐批提交（不需確認）
```

## 步驟 4：逐批執行 Commit

依序執行：

```bash
git add <file1> <file2> ...
git commit -m "<type>(<scope>): <subject>"
```

### Commit Message 規則

- 格式：`<type>(<scope>): <簡短描述，繁體中文>`
- Subject：繁體中文、不超過 50 字、不以句號結尾、動詞開頭

## 步驟 5：推送遠端（commit 後 push）

commit 完成後，依**安全策略**推送（避免誤推 / 改寫他人歷史）：

### 5.1 先確認有 remote

```bash
git remote
```

無輸出 → 無遠端，**跳過 push**，告知使用者「僅本地 commit、無遠端可推」後進步驟 6。

### 5.2 判斷當前分支是否有 upstream

```bash
git rev-parse --abbrev-ref --symbolic-full-name "@{u}"
```

- **exit 0（有 upstream）** → 直接推：

  ```bash
  git push
  ```

- **exit 非 0（無 upstream，多為新分支）** → 用 `AskUserQuestion` 白話問：「這是新分支，遠端還沒有對應分支，要不要建立並推上去？」使用者同意才執行：

  ```bash
  git push --set-upstream origin <current-branch>
  ```

### 5.3 push 失敗處理（不靜默吞）

- **非快轉（rejected, non-fast-forward）**：先 `git fetch` 看落後幾個 commit，回報落後狀況讓使用者決定要 rebase 還是 merge。**絕不擅自** `git push --force` / `--force-with-lease`。
- **網路 / 認證失敗**：回報原因（不是靜默通過），建議使用者檢查 remote 或憑證後重試。

> **Flow 流程內**：per-task commit 後的 push 由 `/flow-build` 驅動，trunk 一般已有 upstream → 直接 `git push`；**push 失敗只警告、不中斷 build**（網路問題不該卡住交付）。

## 步驟 6：確認結果

```bash
git log --oneline -20
git status --short
```

展示 commit 歷史與推送結果給使用者確認。

---

## 衝突處理流程

### 偵測衝突

```bash
git status --short
```

辨識 `UU`（雙方修改）、`AA`（雙方新增）、`DU`/`UD`（一方刪除一方修改）等狀態。

### 列出衝突摘要

```
⚠️ 偵測到 Git 衝突，共 N 個檔案：

1. 📄 src/components/Header.jsx
   - 衝突類型：雙方修改（UU）
   - 衝突原因：本地與遠端都修改了導覽列的連結項目
   - 衝突區段：第 15-28 行
```

### 逐一解決

對每個衝突檔案，讀取衝突標記（`<<<<<<<` 到 `>>>>>>>`），用 `AskUserQuestion` 提供選項：

1. 保留本地版本（HEAD）
2. 保留遠端版本（incoming）
3. 手動合併
4. 同時保留兩者

### 完成提交

```bash
git add <resolved-file>
git commit -m "merge: 解決合併衝突（簡述涉及的模組）"
git log --oneline -5
git status --short
```
