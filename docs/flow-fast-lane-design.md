# B 包設計稿：小功能快速通道（fast lane）——待使用者拍板，未實作

> 狀態：**設計稿**（2026-07-21，肥大審查 B 包）。實作前 SHALL 由使用者逐節拍板。
> 問題根源（肥大審查結論）：Flow「小功能輕量路徑」（/flow Step 0.5）只砍 spec 前段約 8-10 個節點，
> 下游 build/verify/ship 約 15 個閘門原封不動——最小功能（1 task、1 REQ-E2E）仍要精確呼叫 flow-state
> CLI 19+ 次、約 10 個彈窗。對真正瑣碎的小改動，開銷不成比例。

## 一、設計目標與不可讓步邊界

**目標**：符合嚴格條件的小改動，CLI 呼叫從 19+ 次降到約 8 次、彈窗降到 2-3 個——**跳過的是「對單
task 無意義的空轉關卡」，不是防護本身**。

**不可讓步（任何方案都不得動）**：
- `flow-state done` 自帶閘門（verify 空擋完成）、`flow-commit-gate`（secrets/垃圾/未 done）、TDD 紅→綠、真實資料鏈路禁 mock——這些防的失敗模式與 task 大小無關。
- 快速通道的**啟用判定 SHALL 是機檢**（CLI 算給你看），不是模型散文自稱「這是小功能」。
- 每次啟用 SHALL 留 decision 審計（`fast-lane` decision，記判定依據快照），事後可稽核。

## 二、啟用條件（三項全中才開，機檢）

`flow-state fast-lane --check` 逐項驗，任一不中 → exit 2 印原因、走正常全速路：

1. **單 task**：manifest tasks 數 == 1（本輪新增）且無 P-*/X-*。
2. **無平行**：該 task 無 blockedBy、conflictZone 單一——scope/redteam 的「跨 worker」前提不存在。
3. **未命中高風險**：requirements 全文過 `isHighRiskAttackText`（含排除句剝除）為 false，且 diff 不碰
   dep manifest / migration / auth 相關路徑（正則同 auto-gate C-5 清單）。

**T1 逃逸鐵則不變**：途中冒出需求級變動（新實體/角色/auth/RBAC/payment/個資）→ 立即升回全速路
（既有憲法規則，快速通道不豁免）。

## 三、快速通道下每個閘門的處置（逐條）

| 閘門 | 全速路 | 快速通道 | 理由 |
|---|---|---|---|
| 訪談/grill-me/lens ×2/原型 | 必跑 | 跳（既有 Step 0.5 已定） | 不變 |
| spec-ready --freeze | 必跑 | **保留**（精簡 REQ 也要凍結分母） | 下游對賬的根，砍了全鏈失去基準 |
| plan-check | 必跑 | **併入 fast-lane --check 順跑**（同一次呼叫） | 1 task 的 REQ↔task 覆蓋檢查極便宜，不值得省，但可併呼叫 |
| wave --compute | 必跑 | **跳**（1 task 無拓樸可算）；dispatch 直接逐字抽該 task REQ 區塊 | 空轉；逐字投餵防漂移由 fast-lane 內建同一抽取函式保留 |
| scope --wave | 必跑 | **改單 task 版**：仍用 git 真實 diff 對 conflictZone，只是不驗「波成員」 | 越界檢查對單 task 仍有意義（防改到宣告外的共用檔），只砍波次對賬部分 |
| redteam --wave | 必跑 | **降級**：攻擊面 ≥1（非 ≥3）、無獨立紅軍 subagent、由主迴圈自列＋失敗安全測試；高危關鍵字命中＝條件 3 不過、根本進不了快速通道 | 瑣碎改動硬湊 3 攻擊面是表演；但至少想一個失敗模式的紀律保留 |
| journey-check | web 必跑 | **保留**（禁 mock 掃描便宜且防假綠核心） | 不動 |
| verify-e2e | 逐條 | **保留**（僅 1 條，成本低） | 不動 |
| verify-perf | 逐條 | 無 REQ-PERF 時本來就不跑；有則保留 | 不動 |
| code-review（藍軍） | 必跑 | **降級**：不 spawn 獨立 subagent，主迴圈對 diff 自查＋落 findings（空陣列也落）；red flag 終局規則不變 | 單 task 小 diff 的獨立 context 邊際價值低；審計軌跡保留 |
| complete-check | 必跑 | **保留**（終局對賬永不跳） | 唯一收斂點 |
| done（自帶閘門）/ commit-gate | 必跑 | **保留** | 與大小無關 |

估算：CLI 呼叫 19+ → 約 8（fast-lane --check、spec-ready --freeze、scope、journey-check、verify-e2e、
done、complete-check、decision fast-lane）；彈窗 ~10 → 2-3（起手確認走快速通道、凍結確認、出貨確認）。

## 四、防鑽漏洞分析（紅軍自問）

- **「把大功能拆成 N 個單 task 連續走快速通道」**：每輪 fast-lane decision 都留檔，連續 ≥2 輪快速通道
  → 第三輪起 `fast-lane --check` 硬性 exit 2 要求走全速路（頻率熔斷，機檢）。
- **「requirements 措辭迴避高風險詞」**：條件 3 同時掃 diff 路徑（auth/ 目錄、dep manifest、migration），
  文字迴避躲不掉路徑命中；且 T1 語義逃逸照舊由 ship 端 decisions 對賬事後抓。
- **「模型宣稱單 task 但 manifest 多 task」**：條件 1 讀 manifest 機檢，不信自報。
- **「快速通道下偷偷 fan-out」**：mode 記進 manifest；scope 單 task 版發現多 conflictZone 變動即 exit 2。

## 五、實作範圍（拍板後）

1. `flow-state fast-lane --check`（statelib 純函式＋CLI case，含頻率熔斷與 decision 落檔）。
2. `scope --task <id>` 單 task 變體（重用 checkScope，跳波次對賬）。
3. `redteam` 單 task 降級判定（門檻參數化，非新程式路徑）。
4. `/flow` Step 0.5 文件改寫＋`complete-check` 認得 fast-lane decision（審計鏈完整）。
5. 測試：條件三項逐項紅綠、熔斷、審計檔存在性；全套回歸。

## 六、明確不做（本設計稿範圍外）

- 不給快速通道開任何 mock/假資料豁免。
- 不把快速通道做成預設——永遠 opt-in（起手彈窗選項），且機檢不過就自動回全速路。
- spec lens 降級為單 lens 的提案（原 B2）**撤回**：lens 只在走完整訪談時才跑，小功能本來就跳過，無交集。
