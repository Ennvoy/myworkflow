#!/usr/bin/env bash
# Flow 工作流反安裝檔（mac/linux 鏡像）。移除 install.sh 裝進 ~/.claude 的 Flow 自有檔，
# 並從 settings.json 反向拔除 Flow 的 hook 接線。冪等、編輯前自動備份。
# 預設保留 git-tools skill；--remove-git-tools 才一起清。外部 skill 不在移除範圍。
# 用法：
#   ./uninstall.sh
#   ./uninstall.sh --dry-run
#   ./uninstall.sh --remove-git-tools
#   ./uninstall.sh --claude-home /tmp/flow-test-home
set -euo pipefail

CLAUDE_HOME="${HOME}/.claude"
REMOVE_GIT=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --claude-home) CLAUDE_HOME="$2"; shift 2 ;;
    --remove-git-tools) REMOVE_GIT=1; shift ;;
    --keep-git-tools) REMOVE_GIT=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "未知參數：$1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$SCRIPT_DIR/dist"
STAMP="$(date +%Y%m%d-%H%M%S)"

say()  { echo "[Flow] $1"; }
ok()   { echo "   OK  $1"; }
warn() { echo "   !!  $1" >&2; }

say "反安裝目標 ClaudeHome = $CLAUDE_HOME"
[ "$DRY_RUN" -eq 1 ] && say "（dry-run：只預覽，不刪除任何東西）"

# 1) 算移除清單（只列實際存在者）
TARGETS=()
if [ -d "$CLAUDE_HOME/commands" ]; then
  while IFS= read -r f; do TARGETS+=("$f"); done < <(find "$CLAUDE_HOME/commands" -maxdepth 1 -name 'flow*.md' 2>/dev/null)
fi
[ -d "$CLAUDE_HOME/skills/flow-toolkit" ] && TARGETS+=("$CLAUDE_HOME/skills/flow-toolkit")
[ -d "$CLAUDE_HOME/skills/design-system-base" ] && TARGETS+=("$CLAUDE_HOME/skills/design-system-base")  # install.sh 有裝 → 也要清
{ [ "$REMOVE_GIT" -eq 1 ] && [ -d "$CLAUDE_HOME/skills/git-tools" ]; } && TARGETS+=("$CLAUDE_HOME/skills/git-tools")
[ -f "$CLAUDE_HOME/rules/flow.md" ] && TARGETS+=("$CLAUDE_HOME/rules/flow.md")
# C-18：動態 glob hooks/flow-*.mjs（同 commands 的 find 模式），不再硬編清單——原硬編 8 支漏 stop-gate/precompact，
# 卸載殘留檔。命名慣例掃描，新增 hook 自動涵蓋、零漂移。
if [ -d "$CLAUDE_HOME/hooks" ]; then
  while IFS= read -r f; do TARGETS+=("$f"); done < <(find "$CLAUDE_HOME/hooks" -maxdepth 1 -name 'flow-*.mjs' 2>/dev/null)
fi
for ag in red-team.md code-reviewer.md spec-reviewer.md evaluator.md spec-redteam.md spec-consistency.md; do
  [ -f "$CLAUDE_HOME/agents/$ag" ] && TARGETS+=("$CLAUDE_HOME/agents/$ag")
done
[ -f "$CLAUDE_HOME/FLOW-POST-INSTALL.md" ] && TARGETS+=("$CLAUDE_HOME/FLOW-POST-INSTALL.md")

# 2) 列出計畫
if [ "${#TARGETS[@]}" -eq 0 ]; then
  say "沒有發現 Flow 自有檔（可能未安裝或已移除）。"
else
  say "將移除下列 ${#TARGETS[@]} 個 Flow 自有項目："
  for t in "${TARGETS[@]}"; do echo "   - ${t/#$CLAUDE_HOME/~/.claude}"; done
fi
{ [ "$REMOVE_GIT" -eq 0 ] && [ -d "$CLAUDE_HOME/skills/git-tools" ]; } && ok "保留 git-tools skill（要一起移除請加 --remove-git-tools）"
say "settings.json 的 Flow hook 接線將被反向移除"

if [ "$DRY_RUN" -eq 1 ]; then
  say "dry-run 結束，未變更任何檔案。"
  exit 0
fi

# 3) 編輯 settings.json / CLAUDE.md 前先備份
SETTINGS="$CLAUDE_HOME/settings.json"
CLAUDE_MD="$CLAUDE_HOME/CLAUDE.md"
[ -f "$SETTINGS" ] && { cp "$SETTINGS" "$CLAUDE_HOME/settings.flow-uninstall-backup-$STAMP.json"; ok "已備份 settings.json"; }
[ -f "$CLAUDE_MD" ] && { cp "$CLAUDE_MD" "$CLAUDE_HOME/CLAUDE.flow-uninstall-backup-$STAMP.md"; ok "已備份 CLAUDE.md"; }

# 4) 刪除 Flow 自有檔 / 目錄
if [ "${#TARGETS[@]}" -gt 0 ]; then
  for t in "${TARGETS[@]}"; do rm -rf "$t"; done
  ok "${#TARGETS[@]} 個 Flow 檔案 / 目錄已移除"
fi

# 5) 反向移除 settings.json hook + 清舊版 CLAUDE.md FLOW 區塊（node helper）
if command -v node >/dev/null 2>&1 && [ -f "$DIST/install/flow-uninstall.mjs" ]; then
  if node "$DIST/install/flow-uninstall.mjs" "$SETTINGS" "$CLAUDE_MD"; then
    ok "settings.json hook 接線已反向移除；CLAUDE.md 舊版 inline FLOW 區塊已清（若有）"
  else
    warn "settings.json / CLAUDE.md 反向處理非 0 退出（已備份，請檢查）"
  fi
else
  warn "找不到 node 或 helper，請手動刪 settings.json 內 flow-verify-gate / flow-session-start 兩條 hook"
fi

# 6) 收尾 + 外部 skill 提醒
say "反安裝完成"
echo
echo "  外部 skill 屬第三方、未移除（要清請手動）：ui-ux-pro-max（/plugin uninstall）、mattpocock/skills、Playwright"
echo "  重開 Claude Code 生效。要重新安裝：./install.sh"
echo
