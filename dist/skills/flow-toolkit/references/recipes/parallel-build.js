// Flow recipe — parallel-build
// 一波互不依賴的 features，fan-out 成 worktree 隔離的平行 worker。
// 用法：把當前波次的 features 清單 + 契約填進 args，丟給 Workflow 工具跑。
//   Workflow({ script: <本檔內容>, args: { wave: [...], contractPath, reqPath } })
// 回傳：每個 feature 的 {feature, branch, commits, tier1, blockers, driveBy}
//
// 對齊 Flow 憲法：foundation 先序列（呼叫端保證）、features 才平行、紅軍先行、
//   TDD、真實資料鏈路自檢（禁 mock 假綠）、小盒子工具、結構化回傳。

export const meta = {
  name: 'flow-parallel-build',
  description: 'Fan-out a wave of independent features to worktree-isolated workers (red-team → TDD → real-data Tier-1 self-check)',
  phases: [
    { title: 'RedTeam', detail: '每 feature 平行紅軍攻擊面（唯讀、零隔離）' },
    { title: 'Build', detail: '每 feature 一個 worktree worker，TDD + 真實鏈路自檢' },
  ],
}

// args.wave: [{ id, title, req, conflictZone, ui? }]；args.contractPath / args.reqPath
const wave = (args && args.wave) || []
if (!wave.length) { log('parallel-build: 空波次，無事可做'); return [] }

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

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    feature: { type: 'string' },
    branch: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    tier1: {
      type: 'object', additionalProperties: false,
      properties: {
        build: { type: 'boolean' }, unit: { type: 'boolean' },
        apiRealDb: { type: 'boolean', description: 'API 打真 DB 通過（非 mock）' },
        smoke: { type: 'boolean' },
      },
      required: ['build', 'unit', 'apiRealDb', 'smoke'],
    },
    blockers: { type: 'array', items: { type: 'string' }, description: '真依賴未 ready 等 BLOCKED 原因；無則空' },
    driveBy: { type: 'array', items: { type: 'string' }, description: '順手發現的問題（safety red flag 要在此標出）' },
  },
  required: ['feature', 'branch', 'commits', 'tier1', 'blockers', 'driveBy'],
}

// ── Pipeline：每個 feature 獨立走「紅軍 → worktree worker」，無 barrier ──
// 紅軍唯讀可零隔離並行；worker 用 worktree 隔離避免改同檔打架。
const results = await pipeline(
  wave,
  // Stage 1：紅軍攻擊面（唯讀）
  (f) => agent(
    `你是 red-team 攻擊面分析者。針對 feature「${f.title}」(${f.id})，讀 ${args.reqPath} 對應 REQ 與現有 code，` +
    `列 3–5 個破壞情境（邊界值 / 併發 / 惡意輸入 / 相依故障 / 配置漂移），每個標 severity，並給「該先寫成哪個失敗安全測試」。`,
    { label: `red:${f.id}`, phase: 'RedTeam', schema: ATTACK_SCHEMA, agentType: 'red-team' }
  ),
  // Stage 2：worktree worker 實作（吃上一步的攻擊面）
  (attack, f) => agent(
    `你是 feature worker，在隔離 worktree 實作「${f.title}」(${f.id})。\n` +
    `契約：import ${args.contractPath} 的共享 type/schema，兩端同一份。\n` +
    `需求：${args.reqPath} 對應 ${f.req}。\n` +
    `紅軍攻擊面（先寫失敗安全測試、再用防禦碼轉綠）：\n${JSON.stringify(attack && attack.attacks, null, 2)}\n` +
    `紀律：TDD 三相（Red 實跑出真 assertion failure → Green 最小實作 → Refactor）。\n` +
    `Tier-1 自檢鐵則：production build + unit + API + headless smoke。\n` +
    `真實資料鏈路：API/資料驗證 SHALL 打真後端真 DB、禁 mock 假綠、測試資料經真 create API seed 進真 DB；\n` +
    `真依賴未 ready（上游 5xx / 未實作）→ 標 BLOCKED，不准 mock fallback 假裝綠。\n` +
    (f.ui ? `涉 UI：依附帶的 ui-ux-pro-max component 建議，accessibility（ARIA/keyboard/focus）清單逐項實作。\n` : '') +
    `每個 task 完成 per-task commit（scope 帶 ${f.id}）。安全 red flag（SQLi/auth bypass/密碼明文/缺 WHERE 的 destructive query）→ 在 driveBy 標出。\n` +
    `回傳結構化結果。`,
    { label: `build:${f.id}`, phase: 'Build', schema: BUILD_SCHEMA, isolation: 'worktree' }
  )
)

return results.filter(Boolean)
