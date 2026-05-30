// Flow recipe — parallel-verify
// 對多個維度/feature 平行起「結構性獨立」的 Evaluator（反自評樂觀）。
// 用法：Workflow({ script: <本檔內容>, args: { targets: [...], contractPath } })
// 回傳：每個 target 的 PASS/FAIL + 證據 + 失敗點
//
// 對齊 Flow 憲法：Evaluator 全新 context（看不到 builder chain-of-thought）、
//   只透過檔案/契約溝通、對抗人設（找失敗不是核准）、真實資料鏈路、效能硬閘門。

export const meta = {
  name: 'flow-parallel-verify',
  description: 'Spawn structurally-independent Evaluators per target (Playwright real-data chain + perf hard gate, adversarial persona)',
  phases: [{ title: 'Verify', detail: '每維度/feature 獨立 Evaluator 平行驗證' }],
}

// args.targets: [{ id, kind: 'web'|'api'|'e2e'|'perf', req, journey }]
const targets = (args && args.targets) || []
if (!targets.length) { log('parallel-verify: 無 target'); return [] }

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    target: { type: 'string' },
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'BLOCKED'] },
    dimensions: {
      type: 'array',
      description: '各維度獨立門檻；任一 < floor 即整體 FAIL（不准平均）',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', description: '如 functionality / real-data-chain / console-clean / perf-p95' },
          pass: { type: 'boolean' },
          evidence: { type: 'string', description: '客觀證據：截圖路徑 / 數字 / API status / DB 撈回結果' },
        },
        required: ['name', 'pass', 'evidence'],
      },
    },
    mockDetected: { type: 'boolean', description: '是否抓到 mock/stub/寫死 fixture 冒充真實鏈路' },
    perf: { type: 'string', description: 'p50/p95 實測數字 vs budget' },
    failNotes: { type: 'string' },
  },
  required: ['target', 'verdict', 'dimensions', 'mockDetected', 'perf', 'failNotes'],
}

const EVALUATOR_PERSONA =
  '你是對抗性 QA Evaluator。你的工作是【找失敗】，不是核准。預設懷疑：除非有客觀證據，否則判 FAIL。\n' +
  '你看不到、也不要相信 builder 的說法——只信你自己跑出來的 artifact。\n'

const results = await parallel(
  targets.map(t => () => agent(
    EVALUATOR_PERSONA +
    `驗證 target「${t.id}」(kind=${t.kind})，對照契約 ${args.contractPath} 與需求 ${t.req}。\n` +
    (t.journey ? `User journey：${t.journey}\n` : '') +
    '鐵則：\n' +
    '1. 真實資料鏈路：UI → 真 API → 真 query → 真 DB。測試資料經【真 create API】seed 進真 DB 再讀回。' +
    '若在 API client/網路層/前端發現 mock/stub/MSW/寫死 fixture 攔截 → mockDetected=true、該維度 FAIL。\n' +
    '2. Web 三鐵則：production build（非 dev）+ Playwright headed + console/pageerror listener 結尾零 error。\n' +
    '3. 永不信任 exit 0：斷言實際產物（DB 撈得到剛 seed 的列、UI 畫得出來、API 回正確 shape）。\n' +
    '4. 效能硬閘門：對真 DB 真資料量量 p50+p95，任一維度超 budget → 該維度 FAIL（不准用平均救）。\n' +
    '真依賴未 ready → BLOCKED（不是 PASS、不是用 mock 假裝）。\n' +
    '逐維度回報 pass + 客觀 evidence，整體 verdict = 任一維度 FAIL 則 FAIL。',
    { label: `verify:${t.id}`, phase: 'Verify', schema: VERDICT_SCHEMA }
  ))
)

return results.filter(Boolean)
