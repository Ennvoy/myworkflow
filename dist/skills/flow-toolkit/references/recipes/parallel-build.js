// Flow recipe — parallel-build：一波互不依賴的 features 在同 repo 平行生成。
// worker 只寫各自不重疊的檔（conflictZone 互斥）、不 commit、不跑整包 build；build/驗證/commit 由 orchestrator 序列做（見 flow-build Step 4–5）。
// 紅軍唯一執行點＝本檔 Stage 1（flow-build Step 2 不在主迴圈另跑，雙重執行＝token 雙燒）。
// 用法：Workflow({ script: <本檔內容>, args: { wave: [...], contractPath, reqPath } })
//   → 回傳每 feature 的 {feature, files, selfCheck, attackCoverage, blockers, driveBy, redTeam}。
//   orchestrator 收到後 SHALL：① 把 redTeam 落檔 .flow/redteam/<id>.json（ship 的 code-reviewer 必讀輸入）
//   ② 對賬 attackCoverage——任一 high 攻擊無 covered 項或 testFile 不存在 → 該 feature 暫停（flow-build Step 4）。
//   ③ blockers 非空的 feature＝該 worker 終止，orchestrator **不得 re-spawn 同一 worker**，直接帶進 flow-build Step 4 人工閘門（升級而非靜默丟棄、不悶燒整波 token）。

export const meta = {
  name: 'flow-parallel-build',
  description: 'Fan-out a wave of independent features as same-repo parallel workers (generate-only: red-team → TDD → write disjoint files; orchestrator integrates serially)',
  phases: [
    { title: 'RedTeam', detail: '每 feature 平行紅軍攻擊面（唯讀）' },
    { title: 'Generate', detail: '每 feature 一個 worker，同 repo 寫各自不重疊的檔 + 測試（不 build 整包、不 commit）' },
  ],
}

// args.wave: [{ id, title, req, conflictZone, ui? }]；args.contractPath / args.reqPath
// 成本路由＝兩根正交軸（Reasoning Sandwich）：
//   ① model 軸——平行苦工 worker 走較便宜 model（預設 'sonnet'，args.workerModel 可覆寫），省 token＝同預算 fan-out 更寬的波。
//   ② effort 軸（同 model 內的 reasoning_effort）——機械性 generate 用中檔（worker），高價值對抗審查（紅軍）維持高檔不降級。
//      inverse-scaling：對明確任務強拉 effort 反降準、均一高 effort 比 balanced 差。兩軸皆可覆寫、不 hardcode model/effort 行為。
const wave = (args && args.wave) || []
if (!wave.length) { log('parallel-build: 空波次，無事可做'); return [] }
const WORKER_MODEL  = (args && args.workerModel)  || 'sonnet'
const WORKER_EFFORT = (args && args.workerEffort)  || 'medium'   // 平行苦工 generate：中檔
const RED_EFFORT    = (args && args.redTeamEffort) || 'high'     // 紅軍對抗審查：高檔不降級

const ATTACK_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    feature: { type: 'string' },
    attacks: {
      type: 'array',
      minItems: 3,          // 釘死 prompt 的「列 3–5 個」下限：紅軍回 1-2 個攻擊＝schema 驗證失敗（引擎強制、非自律）
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', description: '攻擊編號（A1/A2…）——worker 回報 attackCoverage 對賬用' },
          scenario: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          failingTestHint: { type: 'string', description: '建議先寫成哪個失敗安全測試' },
        },
        required: ['id', 'scenario', 'severity', 'failingTestHint'],
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
    attackCoverage: {
      type: 'array',
      description: '紅軍攻擊面逐項對賬：每個 attack id 對應的失敗安全測試（先紅後綠）。orchestrator 會驗 testFile 真實存在——high 攻擊不准 skipped。',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          attackId: { type: 'string' },
          testFile: { type: 'string', description: '對應測試檔路徑（covered 時必填）' },
          status: { type: 'string', enum: ['covered', 'skipped'] },
          reason: { type: 'string', description: 'skipped 時必填：為何不適用' },
        },
        required: ['attackId', 'status'],
      },
    },
    blockers: { type: 'array', items: { type: 'string' }, description: '真依賴未 ready 等 BLOCKED 原因；無則空' },
    driveBy: { type: 'array', items: { type: 'string' }, description: '順手發現的問題（safety red flag 必在此標出）' },
  },
  required: ['feature', 'files', 'selfCheck', 'attackCoverage', 'blockers', 'driveBy'],
}

// ── Pipeline：每個 feature 獨立走「紅軍 → 同 repo 生成」，無 barrier。紅軍唯讀、worker 寫各自不重疊的檔。──
const results = await pipeline(
  wave,
  // Stage 1：紅軍攻擊面（唯讀；紅軍唯一執行點，主迴圈不另跑）
  (f) => agent(
    `你是 red-team 攻擊面分析者。針對 feature「${f.title}」(${f.id})，讀 ${args.reqPath} 對應 REQ 與現有 code，` +
    `列 3–5 個破壞情境（邊界值 / 併發 / 惡意輸入 / 相依故障 / 配置漂移），每個給編號 id（A1..An）、標 severity，並給「該先寫成哪個失敗安全測試」。`,
    { label: `red:${f.id}`, phase: 'RedTeam', schema: ATTACK_SCHEMA, agentType: 'red-team', effort: RED_EFFORT }
  ),
  // Stage 2：同 repo 生成（吃上一步攻擊面）——平行寫各自不重疊的檔，不 commit、不跑整包 build
  (attack, f) => agent(
    `你是 feature worker，在目前這個 repo 實作「${f.title}」(${f.id})。\n` +
    `**邊界鐵則（同 repo 平行安全靠這個）**：只新增/修改你 conflictZone 內的檔（${(f.conflictZone && JSON.stringify(f.conflictZone)) || '見 tasks.md'}）；\n` +
    `  絕不碰共用檔（全域 router / 共享型別 / package.json / lockfile / DB migration / 中央 config）——那些是序列 foundation 的事。\n` +
    `契約：import ${args.contractPath} 的共享 type/schema，兩端同一份。需求：${args.reqPath} 對應 ${f.req}。\n` +
    `紅軍攻擊面（含 id，逐項對賬）：\n${JSON.stringify(attack && attack.attacks, null, 2)}\n` +
    `  每個攻擊 SHALL 先寫失敗安全測試、再用防禦碼轉綠，並回報 attackCoverage（attackId→testFile）；\n` +
    `  真的不適用才標 skipped+reason——**high severity 不准 skipped**（orchestrator 會驗 testFile 存在、不覆蓋會被擋整合）；\n` +
    `  命中高危面（auth/注入/權限/金流…）的攻擊**即使非 high 也不准無痕 skipped**（須使用者拍板 redteam-waiver decision，否則整合閘門 exit 2）。\n` +
    `TDD：Red 先寫你自己的測試檔、單跑出真 assertion failure → Green 最小實作轉綠 → Refactor。\n` +
    `真實資料鏈路：涉 API/資料 SHALL 打真後端真 DB、禁 mock 假綠；真依賴未 ready（上游 5xx/未實作）→ 標 BLOCKED，不准 mock fallback。\n` +
    `**硬出口**：撞 hard block（上游 5xx / 未實作 / rate-limited / 型別契約缺）→ 立即在 blockers 回報並**停止本 worker**，禁反覆重試或自行降級 mock（悶燒會吃掉整波 ~15x token）。\n` +
    `**你只負責生成，不做整合**：可單跑你自己的單元測試檔（TDD）；但**不要**跑整包 build / tsc / 起 dev server / git add / git commit\n` +
    `  （那些會跟其他 worker 搶 .next/tsbuildinfo/port 與 .git/index.lock）——整包 build、驗證、commit 由主流程序列做。\n` +
    (f.ui ? `涉 UI：依附帶的 ui-ux-pro-max component 建議，accessibility（ARIA/keyboard/focus）清單逐項實作。\n` : '') +
    `安全 red flag（SQLi/auth bypass/密碼明文/缺 WHERE 的 destructive query）→ 在 driveBy 標出。\n` +
    `回傳結構化結果：你改了哪些檔（files）、自檢（單元綠/真實資料）、attackCoverage、blockers、driveBy。`,
    { label: `gen:${f.id}`, phase: 'Generate', schema: GEN_SCHEMA, model: WORKER_MODEL, effort: WORKER_EFFORT }
  ).then((g) => (g ? { ...g, redTeam: (attack && attack.attacks) || [] } : g))  // 紅軍清單隨結果帶回 → orchestrator 落檔 .flow/redteam/<id>.json
)

return results.filter(Boolean)
