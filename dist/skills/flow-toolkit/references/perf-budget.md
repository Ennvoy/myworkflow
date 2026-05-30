# 效能硬閘門：量什麼、budget 怎麼設（/flow-verify、/flow-ship 用）

**核心**：「讀取或渲染太久」**就是驗證不通過**——不是警告、不是 nice-to-have，是 **FAIL**。效能與功能同級，是交付能不能「直接拿來用」的條件。

## 鐵則：不准平均，任一維度不達標即 FAIL

用多維度獨立門檻，**任一維度低於 floor → 整體 FAIL**，高平均不能買回失敗維度。例：功能對但首屏 5 秒 = FAIL，不因為「其他都很好」放行。

## 量什麼（三類，p50 + p95 都量）

| 類 | 指標 | 怎麼量 | 典型 budget（依專案在 REQ-PERF-* 定） |
|---|---|---|---|
| **Load 載入** | LCP、TTFB、FCP | Playwright + `performance` API / Lighthouse CI | LCP p95 < 2.5s；TTFB p95 < 600ms |
| **Render 渲染/互動** | INP、互動延遲、長任務 | 點擊到畫面回應的時間 | 互動回應 p95 < 200ms |
| **API/後端** | 端點延遲、DB query 時間 | 對真 DB 真資料量打 N 次取分位 | 列表 p95 < 300ms；寫入 p95 < 500ms |

**為什麼 p95 不能只看 p50**：平均/中位數漂亮但尾巴（p95/p99）爛 = 一部分使用者每次都卡，體驗殺手藏在尾延遲。

**為什麼要對真 DB 真資料量**：mock / 空 DB 量不到 N+1 query、缺 index、分頁退化。seed 有代表性資料量（不是 3 筆，是接近真實規模）再量。

## budget 怎麼從需求來

`/flow-spec` 逼出 `REQ-PERF-*`（含指標 + 數字 + 分位數 + 條件）：
```
REQ-PERF-001：dashboard 首屏 LCP < 2.5s（p95，4G 模擬，cold cache）
REQ-PERF-002：GET /api/items?page=N p95 < 300ms（seed 10 萬列下）
REQ-PERF-003：搜尋輸入到結果渲染 INP < 200ms（p95）
```
沒寫 REQ-PERF-* = 放棄效能驗收。`/flow-spec` 訪談時 SHALL 對「使用者會在意速度的畫面/操作」逼出至少一條。

## 怎麼量（具體）

- **前端 load/render**：Playwright spec 內讀 `performance.getEntriesByType('navigation')`、`PerformanceObserver` 抓 LCP/INP；或跑 Lighthouse CI（`npx @lhci/cli autorun`）對 production build。
- **API 延遲**：對真服務真 DB 打 20–50 次同端點，排序取 p50/p95（範例見 `playwright-real-data-template.md` 的 REQ-PERF 測試）。
- **務必對 production build + 真 DB**：dev build 的延遲不代表使用者體驗。

## 效能設計提醒（build 階段就要顧，不是驗證才補）

- 貴資源（DB 連線 / browser / container）**lazy 起**，別擋首 token / 首屏路徑（尾延遲最大的勝場）。
- 列表必分頁 + index；防 N+1（eager load / dataloader）。
- 前端：code split、關鍵 CSS、避免 render-blocking、圖片 lazy load。

## 驗證流程位置

- `/flow-build` 每個 feature 結尾：跑該 feature 相關的 REQ-PERF-*（窄範圍）。
- `/flow-ship` Step 3：跑**完整** REQ-PERF-* 全集，任一不達標不放行。
