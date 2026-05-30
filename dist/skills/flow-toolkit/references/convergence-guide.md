# 收束指南：context 預算 + 完成謂詞 + 文件生命週期（/flow-compact 用）

**兩個層次別混**：
- **過程中的 context 衛生** = `/flow-compact`（讓長流程不腐化）
- **真的做完了** = `/flow-ship` 的**完成謂詞**（防無限寫入的終點）

## 一、context 預算（防腐化）

- 可用上限約 **170k**、~147k 開始退化、超過 ~60% 利用率變笨（n² attention 稀釋）。
- **working set 壓在視窗 ~40–50% 以下**，碰 **~60% 觸發 `/flow-compact`**（別等模型開始抄捷徑、提早草草收尾——這叫 context anxiety）。
- **薄 root + on-demand**：always-on 只放憲法目錄，specs / reference 用到才載。
- **subagent context firewall**：吵雜/大 context 工作丟獨立 subagent，只收回 1–2k 蒸餾結果。
- **just-in-time 讀取**：傳檔案路徑/handle，不把整個檔內容塞進 prompt；用 Grep/Glob/Read 隨用隨查。

## 二、compaction 原則：先刪尾保 cache prefix

prompt cache 命中價 = miss 的 1/10，而 cache 靠 **prefix 穩定**。所以：
- **先壓縮/歸檔最新的尾巴**與已完成段落，**保住開頭的系統/設定 prefix**。
- **保留最近存取的熱檔**逐字不動（工作連續性）。
- **禁止**先砍開頭的需求/設計骨幹。

## 三、文件生命週期（防無限寫入）

| 文件 | 寫入時機 | 收束時機 | 鐵則 |
|---|---|---|---|
| `specs/requirements.md` | spec 階段，**凍結** | 已實作章節摘要、全文歸檔 | 凍結後每迴圈重讀、不漂移 |
| `specs/design.md` | plan 階段 | 已實作決策摘要 | **接縫契約、未完成 REQ、open questions 留主檔** |
| `specs/tasks.md` | plan 階段 | 已 `[x]` 段詳情收一行 | `[ ]`/`[x]` 狀態是完成謂詞判據，保持可讀 |
| `.flow/state.json` | 每 action write-ahead | 已完成 action journal 歸檔 | 當前 phase + 未完成 dangling 保留 |

**計畫是可丟棄/可再生的**：tasks/design 從 requirements 重生的成本 = 一個 planning loop。別把它當聖物無止盡打磨——「再潤一次同一個檔」是 context 腐化的來源，不是進步。

**append-only 學習**：迴圈間的學習以**短條目累加**（「build 指令是 X」「這個 test 卡在 Y」），不是越寫越長的敘事（敘事下個 loop 又污染 context）。保持簡短。

## 四、完成謂詞（收束的終點，防無限寫入）

`/flow-ship` 檢查，全中才算「做完」：

```
所有 tasks.md F-*/P-* 為 [x]
  ∧ 所有 REQ-E2E-* 驗證綠
  ∧ 所有 REQ-PERF-* 達 budget（p50+p95）
  ∧ 所有 X-* cross-cutting 清空
→ 寫 state.json phase="shipped"、發 <promise>COMPLETE</promise>、停止迭代
```

任一未中 → 回對應階段補，**不准出通過報告**。滿足謂詞 → **收**，不再打磨（Ralph 完成訊號的精神：有明確終點，不是真無限）。

## 五、one item per loop（過程紀律）

build 階段一個迴圈只推進**一個** task（一條 user story），做完、驗綠、commit、退出，下個迴圈乾淨重讀計畫。穩定後可放寬，一出軌就收回一件。小範圍 = 少 context 消耗 + 少漂移空間。

## 收束後回報

壓了多少、歸檔到哪（`specs/archive/<date>/`）、context 預算降到約多少、距完成謂詞還差哪幾項。
