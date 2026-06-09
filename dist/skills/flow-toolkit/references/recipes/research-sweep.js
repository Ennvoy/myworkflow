// Flow recipe — research-sweep
// 研究/盤點 fan-out：多來源平行讀，各自獨立 context（firewall），只回傳蒸餾結果。
// 用法：Workflow({ script: <本檔內容>, args: { sources: [...], question } })
// 適合：spec 階段查證高變動領域、plan 階段盤點既有 code、需要廣度優先的調查。
//
// 對齊 Flow 憲法：context firewall（大 context 工作丟 subagent、只收 1–2k 蒸餾）、
//   effort 分級（依複雜度決定來源數）、只在高價值才 fan-out。

export const meta = {
  name: 'flow-research-sweep',
  description: 'Fan-out research across independent sources; each subagent is a context firewall returning a distilled summary',
  phases: [{ title: 'Research', detail: '多來源平行讀、蒸餾回傳' }],
}

// args.sources: [{ id, prompt }]；args.question
// 成本路由（context firewall 的廣度讀＝苦力活，非高 reasoning 對抗審查）：平行來源 worker 走較便宜 model，
//   省 token＝同預算能 fan-out 更多來源（多工 ~15x token，成本常是並行寬度的真天花板）。
//   預設 'sonnet'，args.sourceModel 可覆寫（model 當可抽換參數，不 hardcode model-specific 行為）。
const sources = (args && args.sources) || []
if (!sources.length) { log('research-sweep: 無來源'); return [] }
const SOURCE_MODEL = (args && args.sourceModel) || 'sonnet'

const FINDING_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    source: { type: 'string' },
    urls: { type: 'array', items: { type: 'string' }, description: '實際讀到的 URL/檔案' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          point: { type: 'string' },
          evidence: { type: 'string', description: '引文/數字/檔案行號等客觀依據' },
          apply: { type: 'string', description: '對當前問題的可行結論' },
        },
        required: ['point', 'evidence', 'apply'],
      },
    },
    gaps: { type: 'string', description: '查不到/不確定的缺口（禁腦補，明說缺口）' },
  },
  required: ['source', 'urls', 'findings', 'gaps'],
}

const results = await parallel(
  sources.map(s => () => agent(
    `研究問題：${args.question}\n` +
    `你的來源/範圍：${s.prompt}\n` +
    '紀律：只回客觀證據（引文/數字/檔案行號），查不到就在 gaps 明說缺口、禁腦補。' +
    '你是 context firewall——把大量閱讀蒸餾成精簡 findings 回傳，不要回傳原文全文。',
    { label: `research:${s.id}`, phase: 'Research', schema: FINDING_SCHEMA, model: SOURCE_MODEL }
  ))
)

return results.filter(Boolean)
