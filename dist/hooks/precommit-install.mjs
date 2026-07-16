// precommit-install.mjs — 冪等安裝 Flow 的 git 原生 pre-commit 兜底（W3-3）。
// session-start hook 自動呼叫（首次醒目告知）＋ CLI `flow-state install-precommit` 手動呼叫，單一事實來源。
// 紀律：① 只裝標準 .git/hooks（core.hooksPath 空時）；被 husky/lefthook 改向（core.hooksPath 非空）→ 醒目
//        警告「兜底沒裝進」而非靜默裝進一個不會執行的地方（比沒裝更糟的假安全感）。② 既有 pre-commit 用
//        marker 區塊 append、絕不 clobber。③ 全程 fail-silent/不 throw：安裝失敗回 warn，永不影響 session/commit。
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));   // hooks/ 目錄（flow-precommit.mjs 同層）
const BEGIN = '# >>> flow-gate (managed by flow-toolkit) >>>';
const END = '# <<< flow-gate <<<';
const BLOCK_RE = /# >>> flow-gate \(managed by flow-toolkit\) >>>[\s\S]*?# <<< flow-gate <<<\n?/;

function git(cwd, args) {
  try { return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim(); }
  catch { return ''; }
}

// 回 { installed, alreadyInstalled, skipped, warn, path }。呼叫端據 installed（首裝）醒目告知、據 warn 提醒。
export function installPrecommit(cwd) {
  const gitDir = git(cwd, ['rev-parse', '--git-dir']);
  if (!gitDir) return { skipped: 'not-git' };                       // 非 git repo → 不裝
  const scriptPosix = join(here, 'flow-precommit.mjs').replace(/\\/g, '/');   // sh 用正斜線（Windows 路徑也轉）
  // 兩道守衛都是關鍵 robustness（fail-open：結構性缺失一律不擋 commit）：
  //   ① `[ -f <script> ]`：Flow 卸載/搬移後 flow-precommit.mjs 不在了 → 自動 no-op（否則 `node <不存在路徑>` exit 非 0＝brick 該 repo 所有 commit）。
  //   ② `command -v node`：node 不在 hook 的 sh PATH（GUI git / CI 常缺）→ 整段跳過（否則 `node: command not found` exit 127＝brick）。
  const block = [BEGIN, `if [ -f "${scriptPosix}" ] && command -v node >/dev/null 2>&1; then node "${scriptPosix}" || exit $?; fi`, END].join('\n');

  // core.hooksPath 被 husky/lefthook 改向 → 不硬裝（避免與其管理機制打架 / 裝進 husky 內部 wrapper）；醒目警告可手動補。
  const hooksPath = git(cwd, ['config', '--get', 'core.hooksPath']);
  if (hooksPath) {
    return { skipped: 'custom-hookspath', warn: `偵測到自訂 git hook 路徑（core.hooksPath=${hooksPath}，多半是 husky/lefthook）——Flow 沒自動裝 pre-commit 兜底以免打架。要兜底：把「node "${scriptPosix}"」加進你的 pre-commit，或跑 flow-state install-precommit 後手動確認。` };
  }
  // C-54：worktree 下 --git-dir 指向 .git/worktrees/<name>，其 hooks/ 不是 commit 實際會執行的位置；
  // --git-common-dir 指向共用主 .git（hooks 真正所在）。非 worktree 兩者相同。Git 2.5+（無虞）。
  const commonDir = git(cwd, ['rev-parse', '--git-common-dir']) || gitDir;
  const hooksDir = isAbsolute(commonDir) ? join(commonDir, 'hooks') : join(cwd, commonDir, 'hooks');
  const target = join(hooksDir, 'pre-commit');
  const cur = existsSync(target) ? safeRead(target) : '';
  const firstTime = !BLOCK_RE.test(cur);
  let next;
  if (BLOCK_RE.test(cur)) next = cur.replace(BLOCK_RE, block + '\n');            // 更新（路徑可能變；我們自己的區塊，安全 replace）
  else if (cur.trim()) {
    // 既有 pre-commit → append，不 clobber。但先看第一行 shebang：非 POSIX shell 直譯器（python/ruby/perl/node 手寫 hook）
    // append POSIX sh 區塊會讓整檔被該直譯器當語法錯 → brick commit。偵測到非 sh 就別 append，改醒目 warn（同 custom-hookspath）。
    const shebang = (cur.match(/^#!.*$/m) || [''])[0];
    if (shebang && !/\b(sh|bash|dash|zsh|ksh)\b/.test(shebang)) {
      return { skipped: 'foreign-interpreter', warn: `既有 pre-commit 是非 sh 直譯器（${shebang.trim()}）——Flow 沒自動 append 以免破壞你的 hook。要兜底：手動把「node "${scriptPosix}"」接進去，或改用 core.hooksPath 管理。` };
    }
    next = (cur.endsWith('\n') ? cur : cur + '\n') + block + '\n';
  } else next = '#!/bin/sh\n' + block + '\n';                                    // 全新
  if (next === cur) return { alreadyInstalled: true, path: target };            // 冪等：已裝且無變動
  try {
    if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });
    writeFileSync(target, next, 'utf8');
    try { chmodSync(target, 0o755); } catch { /* Windows no-op / 權限問題不致命 */ }
    return firstTime ? { installed: true, path: target } : { alreadyInstalled: true, path: target };
  } catch (e) { return { warn: `pre-commit 兜底寫入失敗（${target}）：${e.message}` }; }
}

function safeRead(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }
