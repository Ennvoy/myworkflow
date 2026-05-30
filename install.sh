#!/usr/bin/env bash
# Flow 工作流安裝檔（mac/linux 鏡像）。功能對齊 install.ps1，共用 dist/install/*.mjs 的 merge 邏輯。
# 用法：
#   ./install.sh
#   ./install.sh --claude-home /tmp/flow-test-home --skip-external --skip-playwright
set -euo pipefail

CLAUDE_HOME="${HOME}/.claude"
SKIP_EXTERNAL=0
SKIP_PLAYWRIGHT=0
KARPATHY_PLUGIN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --claude-home) CLAUDE_HOME="$2"; shift 2 ;;
    --skip-external) SKIP_EXTERNAL=1; shift ;;
    --skip-playwright) SKIP_PLAYWRIGHT=1; shift ;;
    --karpathy-plugin) KARPATHY_PLUGIN=1; shift ;;
    *) echo "未知參數：$1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$SCRIPT_DIR/dist"
STAMP="$(date +%Y%m%d-%H%M%S)"
MANUAL=()

say()  { echo "[Flow] $1"; }
ok()   { echo "   OK  $1"; }
warn() { echo "   !!  $1" >&2; }

[ -d "$DIST" ] || { echo "找不到 dist/ 於 $DIST —— 請在 Flow 套件根目錄執行 install.sh" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "找不到 node（Claude Code 必備），請先安裝 Node.js" >&2; exit 1; }

say "安裝目標 ClaudeHome = $CLAUDE_HOME"
mkdir -p "$CLAUDE_HOME"/{commands,skills,rules,hooks,agents}

SETTINGS="$CLAUDE_HOME/settings.json"
[ -f "$SETTINGS" ] && { cp "$SETTINGS" "$CLAUDE_HOME/settings.flow-backup-$STAMP.json"; ok "已備份 settings.json"; }

say "複製 Flow 檔案"
cp -f "$DIST"/commands/* "$CLAUDE_HOME/commands/"
cp -Rf "$DIST"/skills/flow-toolkit "$CLAUDE_HOME/skills/"
cp -Rf "$DIST"/skills/git-tools "$CLAUDE_HOME/skills/"
cp -f "$DIST"/rules/flow.md "$CLAUDE_HOME/rules/flow.md"
cp -f "$DIST"/hooks/flow-verify-gate.mjs "$CLAUDE_HOME/hooks/"
cp -f "$DIST"/hooks/flow-session-start.mjs "$CLAUDE_HOME/hooks/"
cp -Rf "$DIST"/agents/* "$CLAUDE_HOME/agents/"
ok "commands / skills/flow-toolkit / skills/git-tools（commit+push+PR）/ rules/flow.md / hooks / agents 已就位"

node "$DIST/install/merge-settings.mjs" "$SETTINGS" "$DIST/hooks/settings.flow.json" "$CLAUDE_HOME"
ok "hook 接線已 merge 進 settings.json"

if [ "$SKIP_EXTERNAL" -eq 0 ]; then
  say "外部 skill 安裝"

  MP_CMD='npx -y skills@latest add mattpocock/skills -s caveman -s grill-me -s handoff -s write-a-skill -g -a "*"'
  if command -v npx >/dev/null 2>&1; then
    if npx -y skills@latest add mattpocock/skills -s caveman -s grill-me -s handoff -s write-a-skill -g -a '*'; then
      ok "mattpocock productivity skills 已全域安裝（caveman/grill-me/handoff/write-a-skill）"
    else warn "mattpocock skills 安裝失敗"; MANUAL+=("$MP_CMD"); fi
  else warn "找不到 npx，跳過 mattpocock"; MANUAL+=("$MP_CMD"); fi

  UI_DONE=0
  if command -v claude >/dev/null 2>&1; then
    if claude plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill >/dev/null 2>&1 \
       && claude plugin install ui-ux-pro-max@ui-ux-pro-max-skill >/dev/null 2>&1; then
      UI_DONE=1; ok "ui-ux-pro-max 已透過 claude CLI 安裝"
    fi
  fi
  if [ "$UI_DONE" -eq 0 ]; then
    warn "ui-ux-pro-max 需在 Claude Code 內安裝（slash 指令）"
    MANUAL+=("在 Claude Code 內跑：/plugin marketplace add nextlevelbuilder/ui-ux-pro-max-skill")
    MANUAL+=("在 Claude Code 內跑：/plugin install ui-ux-pro-max@ui-ux-pro-max-skill")
  fi

  if [ "$KARPATHY_PLUGIN" -eq 1 ]; then
    MANUAL+=("在 Claude Code 內跑：/plugin marketplace add multica-ai/andrej-karpathy-skills")
    MANUAL+=("在 Claude Code 內跑：/plugin install andrej-karpathy-skills@karpathy-skills（multica-ai 失敗則改 forrestchang）")
    warn "karpathy plugin 需在 Claude 內安裝（四原則已 bake 進規則，可不裝）"
  else
    ok "karpathy 四原則已 bake 進薄規則（未裝外部 plugin；要裝加 --karpathy-plugin）"
  fi

  if [ "$SKIP_PLAYWRIGHT" -eq 0 ] && command -v npx >/dev/null 2>&1; then
    say "預熱 Playwright Chromium"
    npx -y playwright@latest install chromium || warn "Playwright 預熱失敗，可日後手動裝"
  fi
else
  say "已指定 --skip-external，跳過外部 skill 與 Playwright"
fi

POST="$CLAUDE_HOME/FLOW-POST-INSTALL.md"
{
  echo "# Flow 安裝後手動步驟（$STAMP）"
  echo
  if [ "${#MANUAL[@]}" -gt 0 ]; then
    echo "下列步驟需在 Claude Code 內或手動完成："
    for m in "${MANUAL[@]}"; do echo "- $m"; done
  else
    echo "無待辦手動步驟，全部自動完成。"
  fi
  echo
  echo "## 驗證安裝"
  echo "- 重開 Claude Code，打 /flow 應看到一鍵總控。"
  echo "- ~/.claude/rules/flow.md 應存在（rules/ 每 session 自動載入）。"
  echo "- ~/.claude/settings.json 的 hooks 應含 flow-verify-gate 與 flow-session-start。"
} > "$POST"
ok "已寫 FLOW-POST-INSTALL.md"

say "安裝完成"
echo
echo "  下一步：重開 Claude Code → 在專案打 /flow 開始"
[ "${#MANUAL[@]}" -gt 0 ] && echo "  另有 ${#MANUAL[@]} 個手動步驟見 $POST"
echo
