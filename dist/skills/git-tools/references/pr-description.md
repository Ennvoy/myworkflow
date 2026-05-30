# Git PR Description — 完整執行細節

## 步驟 1：確認分支資訊

```bash
git branch --show-current
git log --oneline main..HEAD
```

- 預設目標 branch 為 `main`（舊 repo 若為 `master` 則改用 `master`；使用者指定其他 base branch 以使用者為準）
- 若無差異，告知使用者後結束

## 步驟 2：蒐集變更資訊

```bash
git log --oneline main..HEAD
git log --format="%h %s%n%b" main..HEAD
git diff --stat main..HEAD
git diff main..HEAD
```

## 步驟 3：分析變更內容

- **變更目的**：這個 branch 要解決什麼問題或新增什麼功能
- **修改範圍**：涉及哪些元件、模組、設定檔
- **影響層面**：是否有破壞性變更、是否影響既有功能

## 步驟 4：產生 PR Title

格式：`<type>: <簡短描述>`

| type | 時機 |
|------|------|
| feat | 新增功能 |
| fix | 修復 bug |
| refactor | 重構 |
| style | 樣式 |
| chore | 雜務 |
| docs | 文件 |
| test | 測試 |

規則：繁體中文、不超過 72 字、動詞開頭。

## 步驟 5：產生 PR Description

```markdown
## 🎯 為什麼要這樣做
簡述此 PR 的背景與動機

## ⚠️ 修改的內容
依功能與需求分組，每組列出修改方向與具體內容。
**禁止**出現任何檔案路徑，一律改用功能描述。

### [功能名稱 / 需求項目]
- **修改方向**：...
- **內容**：
  - 具體修改點（純功能描述）

## 🧪 測試步驟
必須為每一個修改模組產生至少一個測試案例。

### 測試案例 1：[模組 A 的測試情境]
1. 操作步驟
2. **預期結果**：描述預期行為
```

## 步驟 6：輸出結果

以 markdown code block 輸出完整 PR Title + Description，使用者可直接複製貼上。

## 格式嚴格規範

- **禁止**任何 Markdown 連結格式 `[文字](...)`
- **禁止**任何 URI / scheme（如 `file://`）
- **禁止**出現任何檔案路徑，一律改用純功能描述

## 邊界情況

- 有未提交的變更 → 提醒使用者先提交或 stash
