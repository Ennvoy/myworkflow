// commit-gate-core.mjs — Flow commit 三道閘門的共用判定核心（W3-3 抽出，單一事實來源）。
// 兩處呼叫：① hooks/flow-commit-gate.mjs（PreToolUse，看 command 字串＋stdin JSON，跑全三道）
//          ② hooks/flow-precommit.mjs（git 原生 pre-commit，git 直接執行、只跑「看 staged」的前兩道）
// 每個函式回 reason 字串（該擋）或 null（放行）；exit code 由呼叫端決定（PreToolUse 用 2、git hook 用 1）。
// 設計鐵則：fail-open（取不到 staged / import 失敗 / 例外 → 一律 null＝放行，絕不誤擋 git commit）。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));   // hooks/ 目錄（skills/flow-toolkit 在 ../skills/flow-toolkit）

// staged 清單（-z NUL 分隔）。取不到回 null（fail-open：兩道檔案閘門都放行）。
export function stagedFiles(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'diff', '--cached', '--name-only', '-z'], { maxBuffer: 1 << 26 })
      .toString('utf8').split('\0').filter(Boolean);
  } catch { return null; }
}

// ── 閘門〇：secrets 不進歷史 ──
// 檔名白名單式偵測（確定性、近零額外 IO）；樣板（*.example 等）與公鑰放行。
// .npmrc/.pypirc 常見且多半只有 registry 設定 → 只在 staged 內容真含 token/password 才擋（讀 staged 版本）。
export function secretsReason(cwd, staged) {
  if (!staged) return null;
  const SECRET_RE = [
    /(^|\/)\.env(\.[^/]+)?$/i,                       // .env / .env.local / .env.production…
    /(^|\/)[^/]+\.env$/i,                            // production.env / prod.env / dev.env（無前導點的 dotenv 變體；*.env.example 由 SECRET_OK_RE 豁免）
    /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.[^/]*)?$/i,  // SSH 私鑰
    /\.(pem|p12|pfx|keystore|jks|key)$/i,            // 憑證/金鑰容器（*.key＝openssl/nginx 私鑰最常見名）
    /(^|\/)(service[-_]account[^/]*|credentials|gcp[-_]?key|firebase[-_]adminsdk[^/]*)\.json$/i, // 雲端 service account 金鑰
  ];
  const SECRET_OK_RE = /\.(example|sample|template|dist|pub)$/i;
  const secrets = staged.filter((p) => !SECRET_OK_RE.test(p) && SECRET_RE.some((re) => re.test(p)));
  const TOKENY_RE = /(^|\/)\.(npmrc|pypirc)$/i;
  for (const p of staged.filter((q) => TOKENY_RE.test(q))) {
    try {
      const body = execFileSync('git', ['-C', cwd, 'show', ':' + p], { maxBuffer: 1 << 20 }).toString('utf8');
      // 只在帶「真正字面值」時擋——排除 env 變數引用（${VAR}/$VAR，npm 官方推薦的安全寫法），否則誤擋乾淨 .npmrc。
      if (/_authToken\s*=\s*(?!\$\{|\$[A-Za-z_])['"]?\S/i.test(body) || /password\s*[=:]\s*(?!\$\{|\$[A-Za-z_])['"]?\S/i.test(body)) secrets.push(p);
    } catch {} // 讀不到 staged 內容 → fail-open（純 registry 設定不誤擋）
  }
  if (!secrets.length) return null;
  return [
    'Flow commit gate：擋下 commit —— staged 含 secrets 類檔案（per-task commit 會立即 push，一進歷史就收不回）：',
    ...secrets.slice(0, 10).map((p) => '    ' + p),
    secrets.length > 10 ? `    …還有 ${secrets.length - 10} 項` : '',
    '  先移出 staging 並補 .gitignore：',
    ...secrets.slice(0, 10).map((p) => `    git restore --staged "${p}"`),
    '  真要進 repo 的樣板請改名 *.example（如 .env.example，填假值）。別把真 secret commit 進來繞過本閘門。',
  ].filter(Boolean).join('\n');
}

// ── 閘門一：先清、再 commit ──
// staged 裡有驗證垃圾（Tier A 產物 + 產物目錄，含 .playwright-mcp 的 MCP 殘留）→ 擋下叫先清。
// 白名單判斷 import 自 clean-verify-artifacts（單一事實來源）。全程 fail-open：import 失敗回 null。
export async function artifactsReason(cwd, staged) {
  try {
    const cleanPath = join(here, '..', 'skills', 'flow-toolkit', 'clean-verify-artifacts.mjs');
    const clean = await import(pathToFileURL(cleanPath).href);
    const trash = (staged || []).filter((p) => clean.isCommitBlockableArtifact(p));
    if (!trash.length) return null;
    const show = trash.slice(0, 10).map((p) => '    ' + p).join('\n');
    const more = trash.length > 10 ? `\n    …還有 ${trash.length - 10} 項` : '';
    return [
      'Flow commit gate：擋下 commit —— 這些「驗證垃圾」已被 git add 進 staging，會污染交付 diff：',
      show + more,
      '  先清、再 commit（白名單式，保 source 測試檔/specs/.flow ledger/baseline）：',
      `    node "${cleanPath}" --root "${cwd}" --apply --gitignore`,
      '  （--gitignore 會補忽略規則，之後 git add -A 不會再把它們吃進來。別手改繞過本閘門。）',
    ].join('\n');
  } catch { return null; } // import 不到 clean script / 其他例外 → fail-open
}

// ── 閘門二：先標、再 commit ──（需 commit message；pre-commit 階段拿不到 → 只在 PreToolUse 跑）
// 訊息點名某 flow task，但它在 .flow/ledger 還不是 delivered → 擋下叫先跑 flow-state done。
export async function taskDeliveredReason(cwd, msg) {
  if (!msg || !msg.trim()) return null;
  let S;
  try {
    const statelibPath = join(here, '..', 'skills', 'flow-toolkit', 'statelib.mjs');
    S = await import(pathToFileURL(statelibPath).href);
  } catch { return null; } // 載不到 statelib → 放行

  // 先用便宜的 readManifest 取 id 清單，比對訊息有沒有點名 task；沒點名就免跑全量 reconstruct。
  let manifest;
  try { manifest = await S.readManifest(cwd); } catch { return null; }
  const ids = (manifest.tasks || []).map((t) => t.id).filter(Boolean);
  if (!ids.length) return null;

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordHit = (needle, hay) => new RegExp('(^|[^\\w-])' + esc(needle) + '(?![\\w-])').test(hay);
  const needles = (id) => {
    const out = [id];
    const m = id.match(/([A-Za-z]+\d+(?:-\d+)+)$/);
    if (m && m[1] !== id && m[1].length >= 3) out.push(m[1]);
    return out;
  };
  // 剝除「交叉引用」子句（unblocks/blocks/refs/see/depends on + id、或括號引用），只留「本 commit 宣稱交付」的 id——
  // 否則「F-1 done (unblocks F-2)」會被尚未 delivered 的 F-2 誤擋（本 commit 其實只交付 F-1）。剝完再掃。
  const refStripped = msg
    .replace(/\((?:un)?blocks?\b[^)]*\)/gi, ' ')                                            // (unblocks F-2) / (blocks F-2)
    .replace(/\b(?:un)?blocks?\b\s*:?\s*[A-Za-z][\w.-]*-[\w.-]+/gi, ' ')                    // unblocks F-2 / blocks F-2
    .replace(/\b(?:refs?|see|related(?:[ -]?to)?|depends?[ -]on|per)\b\s*:?\s*[A-Za-z][\w.-]*-[\w.-]+/gi, ' '); // refs/see/depends on F-2
  const named = ids.filter((id) => needles(id).some((n) => wordHit(n, refStripped)));
  if (!named.length) return null; // 訊息沒點名任何要交付的 task → 免跑全量 reconstruct

  let view;
  try { view = await S.reconstruct(cwd); } catch { return null; }
  const blocking = named.filter((id) => (view.tasks[id] || {}).state !== 'delivered');
  if (!blocking.length) return null;

  const list = blocking.join(', ');
  return [
    `Flow commit gate：擋下 commit —— 這些 task 還沒標完成就要 commit（違反「先標、再 commit」）：${list}`,
    `  先跑：node "${process.env.USERPROFILE || process.env.HOME || '~'}/.claude/skills/flow-toolkit/flow-state.mjs" done ${blocking[0]}`,
    `  （done 會驗 .flow/state.json 的 verify/tdd——還沒真跑 /flow-verify 綠燈會被它擋；綠了它翻 tasks.md [x] + 寫 ledger delivered。）`,
    `  別手改 ledger/tasks.md 繞過本閘門（系統性違規）；真的非 task commit 才改 commit scope 不帶 task id。`,
  ].join('\n');
}
