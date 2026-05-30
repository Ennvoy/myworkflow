# EARS 需求語法速查（/flow-spec 用）

EARS = Easy Approach to Requirements Syntax。把需求寫成「觸發 → 系統回應」的可驗句型，讓每條需求都能對應到一個可驗收的行為。**API 名/欄位/狀態碼/enum 保留英文**。

## 五種句型

| 型別 | 模板 | 範例 |
|---|---|---|
| Ubiquitous（恆常） | 系統應 `<行為>` | REQ-001：系統應將所有密碼以 bcrypt（cost≥12）雜湊後儲存 |
| Event-driven（事件） | **當** `<trigger>` 時，系統應 `<回應>` | REQ-002：當 user 點擊 loginButton 時，系統應呼叫 POST /api/auth/login 並回傳 access_token |
| State-driven（狀態） | **當處於** `<狀態>` 時，系統應 `<行為>` | REQ-003：當 user session 已過期時，系統應將受保護路由導向 /login 並回傳 401 |
| Unwanted（異常） | **若** `<異常>`，系統應 `<處置>` | REQ-004：若 login 連續失敗 5 次，系統應鎖定該帳號 15 分鐘並回傳 429 |
| Optional（選配） | **在** `<feature>` 啟用時，系統應 `<行為>` | REQ-005：在 2FA 啟用時，系統應於密碼驗證後要求 TOTP code |

## 特殊前綴（Flow 專用）

- **`REQ-E2E-*`**：可 demo 的端到端 user journey，**Phase 4/5 驗證的來源**。
  例：`REQ-E2E-001：訪客可完成「註冊 → 收驗證信 → 登入 → 看到空 dashboard」全程`
- **`REQ-PERF-*`**：效能 budget，**Phase 5 的硬閘門**。一定要含「指標 + 數字 + 分位數」。
  例：`REQ-PERF-001：dashboard 首屏 LCP < 2.5s（p95，4G 模擬）`；`REQ-PERF-002：GET /api/items?page=N p95 < 300ms（10 萬列 seed 資料下）`
- **`REQ-RBAC-*`**：含角色/權限的系統自動注入（動態 RBAC，禁 hardcode 角色）。

## 寫好需求的自查

- [ ] 每條有明確 trigger 與可觀察的回應（不是「系統應好用」這種不可驗句）
- [ ] 異常路徑有寫（空狀態、錯誤、權限不足、併發、相依故障）
- [ ] 每條主功能至少有一條對應的 `REQ-E2E-*`
- [ ] 有效能需求的畫面/API 有對應 `REQ-PERF-*`（含分位數）
- [ ] scope 規則寫清楚（誰能讀寫誰的資料）
- [ ] 過度翻譯檢查：API/欄位/狀態碼是英文，不是「呼叫『認證登入端點』」
