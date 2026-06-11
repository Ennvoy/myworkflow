#!/usr/bin/env node
// Flow deterministic gate (PreToolUse on Bash/PowerShell) — 攔 `git commit`，三道確定性閘門：
//   閘門〇「secrets 不進歷史」：staged 含 .env/私鑰類檔案 → 擋下，先移出 staging＋補 .gitignore
//     （Flow 是 per-task commit 後立即 push 的高頻自動流，secret 一進 commit 幾秒內就上遠端、留在歷史——這裡是唯一確定性節點）。
//   閘門一「先清、再 commit」：staged 含驗證垃圾（Tier A 產物，含 .playwright-mcp 的 MCP console/page 殘留）
//     → 擋下，叫模型先跑 clean-verify-artifacts --apply --gitignore（白名單判斷與 clean script 共用同一套規則）。
//   閘門二「先標、再 commit」：commit message 點名某 flow task，但它在 .flow/ledger 還不是 delivered
//     → 擋下，叫模型先跑 `flow-state done <id>`（done 自帶 verify 閘門；delivered 才放行）。
//   `--amend` 不豁免：閘門〇/一照常（把垃圾/secret 折進上一個 commit 是被擋後最自然的逃生門）；
//     閘門二看「有無解析到新訊息」——純 --no-edit amend 訊息為空自然放行，帶新 -m 點名 task 照擋。
//   訊息解析含 PowerShell here-string（@'…'@ / @"…"@，Windows 多行 commit message 主形）。
// 設計鐵則：fail-open（解析不出 / 非 flow 專案 / 非 git commit / git 或 import 失敗 → 一律放行，絕不誤擋）。
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exit0 = () => process.exit(0);
function stripBom(s) { return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; }

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  let input;
  try { input = JSON.parse(stripBom(raw).trim() || '{}'); } catch { return exit0(); }

  const tool = input.tool_name ?? input.toolName ?? '';
  if (tool !== 'Bash' && tool !== 'PowerShell') return exit0();
  const ti = input.tool_input ?? input.toolInput ?? {};
  const cmd = String(ti.command ?? '');
  // 只攔真正的 commit；放行非 commit / 唯讀 git（--amend 不豁免，見檔頭）。
  if (!/\bgit\b[^\n]*\bcommit\b/.test(cmd)) return exit0();

  const cwd = input.cwd ?? process.cwd();
  if (!existsSync(join(cwd, '.flow'))) return exit0(); // 非 flow 專案

  // staged 清單只取一次（閘門〇/一共用）。取不到 → null＝兩道檔案閘門都 fail-open。
  let staged = null;
  try {
    staged = execFileSync('git', ['-C', cwd, 'diff', '--cached', '--name-only', '-z'], { maxBuffer: 1 << 26 })
      .toString('utf8').split('\0').filter(Boolean);
  } catch {}

  // ── 閘門〇：secrets 不進歷史 ──
  // 檔名白名單式偵測（確定性、近零額外 IO）；樣板（*.example 等）與公鑰放行。
  // .npmrc/.pypirc 常見且多半只有 registry 設定 → 只在 staged 內容真含 token/password 才擋（內容讀 staged 版本）。
  if (staged) {
    const SECRET_RE = [
      /(^|\/)\.env(\.[^/]+)?$/i,                       // .env / .env.local / .env.production…
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
        if (/(_authToken|password\s*[=:])/i.test(body)) secrets.push(p);
      } catch {} // 讀不到 staged 內容 → fail-open（純 registry 設定不誤擋）
    }
    if (secrets.length) {
      const reason = [
        'Flow commit gate：擋下 commit —— staged 含 secrets 類檔案（per-task commit 會立即 push，一進歷史就收不回）：',
        ...secrets.slice(0, 10).map((p) => '    ' + p),
        secrets.length > 10 ? `    …還有 ${secrets.length - 10} 項` : '',
        '  先移出 staging 並補 .gitignore：',
        ...secrets.slice(0, 10).map((p) => `    git restore --staged "${p}"`),
        '  真要進 repo 的樣板請改名 *.example（如 .env.example，填假值）。別把真 secret commit 進來繞過本閘門。',
      ].filter(Boolean).join('\n');
      process.stderr.write(reason + '\n');
      process.exit(2); // exit 2 → Claude Code 擋下工具呼叫，把 stderr 餵回模型
    }
  }

  // ── 閘門一：先清、再 commit ──
  // staged 裡有驗證垃圾（Tier A 產物 + 產物目錄，含 .playwright-mcp 的 MCP 殘留）→ 擋下叫先清。
  // 白名單判斷 import 自 clean-verify-artifacts（單一事實來源）。全程 fail-open：import 失敗不擋，往下走閘門二。
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const cleanPath = join(here, '..', 'skills', 'flow-toolkit', 'clean-verify-artifacts.mjs');
    const clean = await import(pathToFileURL(cleanPath).href);
    const trash = (staged || []).filter((p) => clean.isCommitBlockableArtifact(p));
    if (trash.length) {
      const show = trash.slice(0, 10).map((p) => '    ' + p).join('\n');
      const more = trash.length > 10 ? `\n    …還有 ${trash.length - 10} 項` : '';
      const reason = [
        'Flow commit gate：擋下 commit —— 這些「驗證垃圾」已被 git add 進 staging，會污染交付 diff：',
        show + more,
        '  先清、再 commit（白名單式，保 source 測試檔/specs/.flow ledger/baseline）：',
        `    node "${cleanPath}" --root "${cwd}" --apply --gitignore`,
        '  （--gitignore 會補忽略規則，之後 git add -A 不會再把它們吃進來。別手改繞過本閘門。）',
      ].join('\n');
      process.stderr.write(reason + '\n');
      process.exit(2);
    }
  } catch {} // import 不到 clean script / 其他例外 → fail-open，往下走閘門二

  // ── 閘門二：先標、再 commit ──
  // 取 commit 訊息：PowerShell here-string @'…'@/@"…"@、-m "..."/'...'、或 -F <file>。取不到就 fail-open。
  // amend 不整體豁免：純 `--amend --no-edit`（無新 -m）訊息解析為空自然放行；帶新 -m 點名 task 仍受本閘門管
  // （把未交付 task 折進上一個 commit 跟新 commit 一樣違反「先標、再 commit」）。
  let msg = '';
  for (const m of cmd.matchAll(/-m\s+@(['"])([\s\S]*?)\1@/g)) msg += ' ' + m[2];
  for (const m of cmd.matchAll(/-m\s+("([^"]*)"|'([^']*)'|((?!@)\S+))/g)) msg += ' ' + (m[2] ?? m[3] ?? m[4] ?? ''); // (?!@)：不重吃 here-string 殘渣
  const fm = cmd.match(/-F\s+("([^"]*)"|'([^']*)'|(\S+))/);
  if (fm) { const f = fm[2] ?? fm[3] ?? fm[4]; try { msg += ' ' + readFileSync(f, 'utf8'); } catch {} }
  if (!msg.trim()) return exit0(); // 解析不出訊息 → 不誤擋

  // 動態載入 statelib（與本 hook 同發行結構：hooks/ 與 skills/flow-toolkit/ 同層）。
  let S;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const statelibPath = join(here, '..', 'skills', 'flow-toolkit', 'statelib.mjs');
    S = await import(pathToFileURL(statelibPath).href); // Windows 反斜線路徑也安全
  } catch { return exit0(); } // 載不到 statelib → 放行

  // 先用便宜的 readManifest 取 id 清單，比對訊息有沒有點名 task；沒點名就免跑全量 reconstruct（多數 docs/chore commit 走這條）。
  let manifest;
  try { manifest = await S.readManifest(cwd); } catch { return exit0(); }
  const ids = (manifest.tasks || []).map((t) => t.id).filter(Boolean);
  if (!ids.length) return exit0();

  // task id 在訊息裡以單字邊界出現？前面不可是 \w 或 -（避免吃進更大的 token）、後面不可接 \w 或 -。
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordHit = (needle, hay) => new RegExp('(^|[^\\w-])' + esc(needle) + '(?![\\w-])').test(hay);
  // 比對 needle：canonical id + 複合波次尾段 token（如 F-1186-W0-5 → 也認 W0-5，吃下 v1.18.6/W0-5 這種裝飾 scope）。
  const needles = (id) => {
    const out = [id];
    const m = id.match(/([A-Za-z]+\d+(?:-\d+)+)$/);
    if (m && m[1] !== id && m[1].length >= 3) out.push(m[1]);
    return out;
  };
  const named = ids.filter((id) => needles(id).some((n) => wordHit(n, msg)));
  if (!named.length) return exit0(); // 訊息沒點名任何 task → 免跑全量 reconstruct，直接放行

  // 訊息點名了 task → 才跑全量 reconstruct，用三來源合併（manifest→state.json→ledger）判 delivered（語意與原本一致）。
  let view;
  try { view = await S.reconstruct(cwd); } catch { return exit0(); }
  // 找出「訊息點名、但還沒 delivered」的 task。
  const blocking = named.filter((id) => (view.tasks[id] || {}).state !== 'delivered');
  if (!blocking.length) return exit0();

  const list = blocking.join(', ');
  const reason = [
    `Flow commit gate：擋下 commit —— 這些 task 還沒標完成就要 commit（違反「先標、再 commit」）：${list}`,
    `  先跑：node "${process.env.HOME || process.env.USERPROFILE || '~'}/.claude/skills/flow-toolkit/flow-state.mjs" done ${blocking[0]}`,
    `  （done 會驗 .flow/state.json 的 verify/tdd——還沒真跑 /flow-verify 綠燈會被它擋；綠了它翻 tasks.md [x] + 寫 ledger delivered。）`,
    `  別手改 ledger/tasks.md 繞過本閘門（系統性違規）；真的非 task commit 才改 commit scope 不帶 task id。`,
  ].join('\n');
  process.stderr.write(reason + '\n');
  process.exit(2); // exit 2 → Claude Code 擋下工具呼叫，把 stderr 餵回模型
});
