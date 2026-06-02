// Flow recipe — parallel-build：一波互不依賴的 features 在同 repo 平行生成。
// worker 只寫各自不重疊的檔（conflictZone 互斥）、不 commit、不跑整包 build；build/驗證/commit 由 orchestrator 序列做（見 flow-build Step 4–5）。
// 用法：Workflow({ script: <本檔內容>, args: { wave: [...], contractPath, reqPath } }) → 回傳每 feature 的 {feature, files, selfCheck, blockers, driveBy}。

export const meta = {
  name: 'flow-parallel-build',
  description: 'Fan-out a wave of independent features as same-repo parallel workers (generate-only: red-team → TDD → write disjoint files; orchestrator integrates serially)',
  phases: [
    { title: 'RedTeam', detail: '每 feature 平行紅軍攻擊面（唯讀）' },
    { title: 'Generate', detail: '每 feature 一個 worker，同 repo 寫各自不重疊的檔 + 測試（不 build 整包、不 commit）' },
  ],
}

// args.wave: [{ id, title, req, conflictZone, ui? }]；args.contractPath / args.reqPath
// 成本路由（Reasoning Sandwich：plan/verify 高、中間 generation 低）：平行苦工 worker 走較便宜的 model，
// 省 token＝同預算能 fan-out 更寬的波（多工 ~15x token，成本常是並行寬度的真天花板）。
// 預設 'sonnet'，但 args.workerModel 可覆寫（model 當可抽換參數，不 hardcode model-specific 行為）。
const wave = (args && args.wave) || []
if (!wave.length) { log('parallel-build: 空波次，無事可做'); return [] }
const WORKER_MODEL = (args && args.workerModel) || 'sonnet'

const ATTACK_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    feature: { type: 'string' },
    attacks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          scenario: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          failingTestHint: { type: 'string', description: '建議先寫成哪個失敗安全測試' },
        },
        required: ['scenario', 'severity', 'failingTestHint'],
      },
    },
  },
  required: ['feature', 'attacks'],
}

// 生成階段回傳（worker 不 commit、不跑整包 build）：orchestrator 用 files 決定序列整合的 review/verify 範圍。
const GEN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    feature: { type: 'string' },
    files: { type: 'array', items: { type: 'string' }, description: '本 worker 新增/修改的檔（應落在自己的 conflictZone 內）' },
    selfCheck: {
      type: 'object', additionalProperties: false,
      properties: {
        unitGreen: { type: 'boolean', description: '自己寫的單元測試檔在 worker 內單跑為綠（TDD 紅→綠）' },
        realData: { type: 'string', enum: ['pass', 'n/a', 'blocked'], description: 'API/資料若有：打真 DB 通過 / 不涉資料 / 真依賴未 ready' },
      },
      required: ['unitGreen', 'realData'],
    },
    blockers: { type: 'array', items: { type: 'string' }, description: '真依賴未 ready 等 BLOCKED 原因；無則空' },
    driveBy: { type: 'array', items: { type: 'string' }, description: '順手發現的問題（safety red flag 必在此標出）' },
  },
  required: ['feature', 'files', 'selfCheck', 'blockers', 'driveBy'],
}

// ── Pipeline：每個 feature 獨立走「紅軍 → 同 repo 生成」，無 barrier。紅軍唯讀、worker 寫各自不重疊的檔。──
const results = await pipeline(
  wave,
  // Stage 1：紅軍攻擊面（唯讀）
  (f) => agent(
    `你是 red-team 攻擊面分析者。針對 feature「${f.title}」(${f.id})，讀 ${args.reqPath} 對應 REQ 與現有 code，` +
    `列 3–5 個破壞情境（邊界值 / 併發 / 惡意輸入 / 相依故障 / 配置漂移），每個標 severity，並給「該先寫成哪個失敗安全測試」。`,
    { label: `red:${f.id}`, phase: 'RedTeam', schema: ATTACK_SCHEMA, agentType: 'red-team' }
  ),
  // Stage 2：同 repo 生成（吃上一步攻擊面）——平行寫各自不重疊的檔，不 commit、不跑整包 build
  (attack, f) => agent(
    `你是 feature worker，在目前這個 repo 實作「${f.title}」(${f.id})。\n` +
    `**邊界鐵則（同 repo 平行安全靠這個）**：只新增/修改你 conflictZone 內的檔（${(f.conflictZone && JSON.stringify(f.conflictZone)) || '見 tasks.md'}）；\n` +
    `  絕不碰共用檔（全域 router / 共享型別 / package.json / lockfile / DB migration / 中央 config）——那些是序列 foundation 的事。\n` +
    `契約：import ${args.contractPath} 的共享 type/schema，兩端同一份。需求：${args.reqPath} 對應 ${f.req}。\n` +
    `紅軍攻擊面（先寫失敗安全測試、再用防禦碼轉綠）：\n${JSON.stringify(attack && attack.attacks, null, 2)}\n` +
    `TDD：Red 先寫你自己的測試檔、單跑出真 assertion failure → Green 最小實作轉綠 → Refactor。\n` +
    `真實資料鏈路：涉 API/資料 SHALL 打真後端真 DB、禁 mock 假綠；真依賴未 ready（上游 5xx/未實作）→ 標 BLOCKED，不准 mock fallback。\n` +
    `**你只負責生成，不做整合**：可單跑你自己的單元測試檔（TDD）；但**不要**跑整包 build / tsc / 起 dev server / git add / git commit\n` +
    `  （那些會跟其他 worker 搶 .next/tsbuildinfo/port 與 .git/index.lock）——整包 build、驗證、commit 由主流程序列做。\n` +
    (f.ui ? `涉 UI：依附帶的 ui-ux-pro-max component 建議，accessibility（ARIA/keyboard/focus）清單逐項實作。\n` : '') +
    `安全 red flag（SQLi/auth bypass/密碼明文/缺 WHERE 的 destructive query）→ 在 driveBy 標出。\n` +
    `回傳結構化結果：你改了哪些檔（files）、自檢（單元綠/真實資料）、blockers、driveBy。`,
    { label: `gen:${f.id}`, phase: 'Generate', schema: GEN_SCHEMA, model: WORKER_MODEL }
  )
)

return results.filter(Boolean)
