# spec 多角度審查迴圈（/flow-spec 用，on-demand）

> 目標：「各種不同角度反覆 review 到完全沒有問題」的**機讀版**——哪些角度審過、審了幾輪、審的是哪版文字、每條發現的下場，全部是檔案事實，不是模型自報。
> 設計依據：lens 綁「**互異機制**」而非換 persona（Nine Judges 實證：同模型換提示詞 9 評審 ≈ 2.18 張獨立票＝假多角度）。

## 五鏡頭矩陣（機制互異，缺一不可互替）

| Lens | 機制 | 執行 | 閘門 |
|---|---|---|---|
| L1 形式 lint | 純 script（非 LLM） | `flow-state spec-ready` | 每輪必跑，exit 2 |
| L2 需求紅軍 | 對抗目標函數 | `spec-redteam` subagent → `spec-review redteam` | freeze 對賬 ≥2 輪 |
| L3 全集一致性 | 斷開 context（看不到訪談） | `spec-consistency` subagent → `spec-review consistency` | freeze 對賬 ≥2 輪 |
| L4 跨模型家族 | Codex CLI（裝了就跑、沒裝跳過） | `spec-review codex --exec "<codex 命令>" --file <findings>`（id 前綴 `SR-CX-`） | 有 ledger 就一併對賬，不強制 |
| L5 人眼＋真點擊 | 互動原型走查＋使用者定版 | `mockup-check` ＋ `decision ui-signoff` | freeze 對賬 |

## 固定輪結構（散文只管順序，「跑完沒」全交閘門）

1. **首輪**：蘇格拉底訪談＋grill-me 收斂後 → **requirements.md 已落檔＋首次 `spec-ready` 綠**（CLI 缺檔 exit 2）→ **L2＋L3 全跑**（L4 有裝也跑）→ findings 存暫存檔（**放 `.flow/spec-review/` 之外**——目錄內只認 CLI 寫的 `<lens>-r<n>.json`，雜檔不算輪但別汙染）→ `flow-state spec-review <lens> --file` 落 ledger（**docHash 由 CLI 自算**，綁定當下文字；id 前綴綁 lens `SR-RT-`/`SR-CS-`/`SR-CX-`，跨 lens 撞號 CLI 拒收）。
2. **終局化**：每條 finding SHALL 走到四種終局之一（`flow-state review-resolve <SR-id> --as …`），指標當下即驗、freeze 再驗：
   - `resolved:REQ-xxx` — 質疑落成了真 REQ（id 須實存於 requirements.md）
   - `open` — 進 `### 開放問題` 段帶 `[SR-id]` 標籤的 bullet → 既有 spec-ready 閘門逼到**彈窗問使用者**、逼到清零（模型不能腦補答案）
   - `deferred:<decisionId>` / `rejected:<decisionId>` — decision 檔實存（rejected 是**洩壓閥**：吹毛求疵的發現留審計線即可關閉，迴圈才有界；一筆 decision 可批次覆蓋多條低嚴重度）
3. **中間輪**：只重跑「上一輪有 findings、或 requirements.md 改過（docHash 變了）」的 lens——省 token、閘門終態不縮水。
4. **末輪**：全 lens 重跑，目標零新發現。
5. **凍結**：`spec-ready --freeze` 機檢——L2/L3 各 **≥2 輪**、**末輪 findings 為空**（或滿 **3 輪封頂**且全終局）、**末輪 docHash == 現行文字**（審完偷改文即失效、重跑末輪）、diagnose review 全綠、（走原型路）ui-signoff 實存。

## lens 輸入鐵則（防死循環）

spawn L2/L3 時 SHALL 附上**前輪 findings＋終局狀態**。完整紀律見 `references/finding-discipline.md`——沒有這條，lens 第 2 輪會把被 rejected 的毛病再找出來一次 → 末輪永不為空。

## Fail 時回哪一步

| 閘門訊息 | 回哪步 |
|---|---|
| lens「x」未跑 / 未收斂 | 步驟 1/3：spawn 對應 subagent 再 spec-review 落檔 |
| docHash 不符 | 文字審後改過——重跑該 lens 一輪（步驟 3） |
| finding 未終局 / 指標失效 | 步驟 2：review-resolve（open 的答案落地後改 resolved） |
| 開放問題未清零 | 回訪談：彈窗問使用者、拍板後清 bullet |
| 查無 ui-signoff | 開瀏覽器讓使用者走查→彈窗定版→`decision ui-signoff` |

## 誠實邊界（威脅模型分層）

- 機器釘死的：lens **缺席**（沒跑就是沒跑）、輪數、審的**是哪版文字**（docHash）、發現**不能無痕蒸發**（終局對賬）、裸寫 ledger（flow-spec-gate exit 2）。
- 機器釘不死的：ledger「出處」（模型可不 spawn subagent 自編 findings）＋「使用者真的點過彈窗」——防**懶惰淺審**不防蓄意欺騙；偽造＝編結構化連環謊＋git 審計線可稽，與手改 state.json 同級。
- **輕量路徑（小功能跳訪談）只跑 L1**，不套 lens 矩陣——閘門重到把人擠出正門＝負資產。

## 成本

每次凍結前多 2~5 個 subagent 呼叫（L2/L3 各 ≥2 輪、中間輪按需），spec 階段 token 約 +20~30%。spec 是全 pipeline 最上游的隨機源：凍結版 REQ 集合不同＝下游 plan/build/verify 全部錨定不同——上游 1 token 的收斂省下游 ~15x fan-out 的重工。
