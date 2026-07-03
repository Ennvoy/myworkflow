#!/usr/bin/env node
// flow-precommit.mjs — git 原生 pre-commit hook 執行體（W3-3，flow-session-start 冪等安裝進 repo）。
// git 直接執行、無 stdin JSON、無 command 字串、cwd=工作樹根。只跑「看 staged」的兩道（secrets + 驗證垃圾）——
// 閘門二（task delivered）需 commit message、pre-commit 階段還沒有，留在 PreToolUse 端。
// 價值：封掉 PreToolUse 攔不到的整批繞法（你手動 commit / worker 子行程 / npm script / release 腳本 / MCP run_code）。
// 設計鐵則：fail-open（非 flow 專案 / 取不到 staged / core 模組載入失敗（半卸載）/ 任何例外 → exit 0 放行；
//   git commit 絕不因 hook bug 卡死）。core 走「try 內動態 import」——半卸載時模組缺失落 catch 放行，不 fail-closed。
//   真要跳過用 git 原生 `git commit --no-verify`（documented 逃生門、reflog 可稽核）。
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cwd = process.cwd();
if (!existsSync(join(cwd, '.flow'))) process.exit(0);  // 非 flow 專案 → 不管（本 hook 只在 Flow 專案有意義）

(async () => {
  try {
    // 動態 import in try：commit-gate-core 缺失/壞掉（Flow 半卸載）→ 落 catch → fail-open，不擋 commit。
    const core = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'commit-gate-core.mjs')).href);
    const staged = core.stagedFiles(cwd);
    const s = core.secretsReason(cwd, staged);
    if (s) { process.stderr.write(s + '\n  （這是 Flow 的 git pre-commit 兜底；真要跳過：git commit --no-verify）\n'); process.exit(1); }
    const a = await core.artifactsReason(cwd, staged);
    if (a) { process.stderr.write(a + '\n  （這是 Flow 的 git pre-commit 兜底；真要跳過：git commit --no-verify）\n'); process.exit(1); }
  } catch { /* fail-open：core 載入失敗/任何例外都放行，不卡死 commit */ }
  process.exit(0);
})();
