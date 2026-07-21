#Requires -Version 5.1
<#
.SYNOPSIS
  Flow 工作流安裝檔（Windows 主力）。把 dist/ 的 commands/skills/rules/hooks 裝進 ~/.claude，
  merge hook 接線進 settings.json，把薄規則注入 CLAUDE.md，並（可選）跑三個外部 skill 安裝指令。
  冪等可重跑、自動備份。換新電腦：clone 本套件 → 跑這支即可。
.PARAMETER ClaudeHome
  目標 .claude 目錄（預設 ~/.claude）。測試時可指向拋棄式 temp 目錄。
.PARAMETER SkipExternal
  跳過外部網路安裝（mattpocock skills / ui-ux-pro-max / playwright 瀏覽器）。
.PARAMETER SkipPlaywright
  跳過預熱 Playwright 瀏覽器 binary。
.PARAMETER KarpathyPlugin
  額外安裝 karpathy plugin（四原則已 bake 進薄規則，預設不裝外部 plugin）。
.EXAMPLE
  ./install.ps1
.EXAMPLE
  ./install.ps1 -ClaudeHome "$env:TEMP\flow-test-home" -SkipExternal -SkipPlaywright
#>
[CmdletBinding()]
param(
  [string]$ClaudeHome = (Join-Path $env:USERPROFILE '.claude'),
  [switch]$SkipExternal,
  [switch]$SkipPlaywright,
  [switch]$KarpathyPlugin,
  [switch]$Quiet
)

# --- 一律 UTF-8（呼叫 node/npx/git 前）---
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dist = Join-Path $ScriptDir 'dist'

function Say($m, $c = 'Cyan') { if (-not $Quiet) { Write-Host "[Flow] $m" -ForegroundColor $c } }
function Ok($m)   { if (-not $Quiet) { Write-Host "   OK  $m" -ForegroundColor Green } }
function Warn($m) { Write-Host "   !!  $m" -ForegroundColor Yellow }

$manual = New-Object System.Collections.Generic.List[string]

# 0) 健全性檢查
if (-not (Test-Path $Dist)) { throw "找不到 dist/ 於 $Dist —— 請在 Flow 套件根目錄執行 install.ps1" }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "找不到 node（Claude Code 必備）。請先裝 Node.js 再重跑。" }

# 0.5) 安裝前跑 dist 測試（確定性閘門：裝壞的 dist 裝不出去）
Say "跑 dist 測試（node --test：statelib / clean-verify / hooks 閘門）"
$testFiles = @(Get-ChildItem $Dist -Recurse -Filter '*.test.mjs' | ForEach-Object FullName)
if ($testFiles.Count -gt 0) {
  & node --test @testFiles
  if ($LASTEXITCODE -ne 0) { throw "dist 測試未過（exit $LASTEXITCODE）—— 中止安裝，先修紅再裝。" }
  Ok "dist 測試全綠（$($testFiles.Count) 個測試檔）"
} else { Warn "dist 內無 *.test.mjs，跳過測試閘門" }

Say "安裝目標 ClaudeHome = $ClaudeHome"

# 1) 建目錄
foreach ($d in 'commands', 'skills', 'rules', 'hooks', 'agents') {
  New-Item -ItemType Directory -Force -Path (Join-Path $ClaudeHome $d) | Out-Null
}

# 2) 備份既有 settings.json
$settingsPath = Join-Path $ClaudeHome 'settings.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (Test-Path $settingsPath) {
  Copy-Item $settingsPath (Join-Path $ClaudeHome "settings.flow-backup-$stamp.json")
  Ok "已備份 settings.json（settings.flow-backup-$stamp.json）"
}

# 3) 複製 Flow payload（只覆蓋 Flow 自有檔，不動其他）
Say "複製 Flow 檔案"
Copy-Item (Join-Path $Dist 'commands\*') (Join-Path $ClaudeHome 'commands') -Recurse -Force
Copy-Item (Join-Path $Dist 'skills\flow-toolkit') (Join-Path $ClaudeHome 'skills') -Recurse -Force
Copy-Item (Join-Path $Dist 'skills\git-tools') (Join-Path $ClaudeHome 'skills') -Recurse -Force
Copy-Item (Join-Path $Dist 'skills\design-system-base') (Join-Path $ClaudeHome 'skills') -Recurse -Force
Copy-Item (Join-Path $Dist 'rules\flow.md') (Join-Path $ClaudeHome 'rules\flow.md') -Force
Copy-Item (Join-Path $Dist 'hooks\*.mjs') (Join-Path $ClaudeHome 'hooks') -Force -Exclude '*.test.mjs'
Copy-Item (Join-Path $Dist 'agents\*') (Join-Path $ClaudeHome 'agents') -Recurse -Force
# 升級清理：已退役的 agent 定義檔（v0.23.0 起 spec-reviewer 拆成 spec-redteam/spec-consistency）
Remove-Item (Join-Path $ClaudeHome 'agents\spec-reviewer.md') -Force -ErrorAction SilentlyContinue
# 寫安裝來源/版本標記（供 flow-session-start 非阻擋漂移提醒：改了 dist 沒重裝時提醒）
$flowVersion = ''
try { $flowVersion = (Get-Content (Join-Path $ScriptDir 'VERSION') -Raw -Encoding utf8 -ErrorAction Stop).Trim() } catch {}
$prov = @{ version = $flowVersion; source = $ScriptDir; installedAt = $stamp } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $ClaudeHome '.flow-version.json'), $prov, (New-Object Text.UTF8Encoding($false)))
Ok "已寫 .flow-version.json（v$flowVersion，來源 $ScriptDir）"
$cmdCount = (Get-ChildItem (Join-Path $ClaudeHome 'commands') -Filter 'flow*.md').Count
$agentCount = (Get-ChildItem (Join-Path $ClaudeHome 'agents') -Filter '*.md' -ErrorAction SilentlyContinue).Count
Ok "commands（$cmdCount 個 flow*.md）/ skills/flow-toolkit / skills/git-tools（commit+push+PR）/ skills/design-system-base（150 套品牌基底）/ rules/flow.md / hooks / agents（$agentCount 個：red-team/code-reviewer/evaluator/spec-redteam/spec-consistency）已就位"

# 4) merge hook 接線進 settings.json
& node (Join-Path $Dist 'install\merge-settings.mjs') $settingsPath (Join-Path $Dist 'hooks\settings.flow.json') $ClaudeHome
if ($LASTEXITCODE -ne 0) { throw "settings.json merge 失敗（exit $LASTEXITCODE）。已備份，請檢查既有 settings.json 是否合法 JSON。" }
Ok "hook 接線已 merge 進 settings.json（verify-gate / session-start / size-check / stall-monitor / dispatch 四合一＝commit-gate+auto-gate+spec-gate+design-base-hint）"

# 5) 外部 skill 安裝（依補充指定；用各自官方指令）
if (-not $SkipExternal) {
  Say "外部 skill 安裝"

  # 5a) mattpocock/skills — 只裝 productivity 4 個（Flow 用 grill-me；其餘為通用工具）。
  #     -g 全域、-a claude-code 只進 Claude Code（不散到 50+ 種 agent）、--copy 避 Windows symlink 權限、-y 非互動
  $npx = Get-Command npx -ErrorAction SilentlyContinue
  $mpCmd = 'npx -y skills@latest add mattpocock/skills -s caveman -s grill-me -s handoff -s write-a-skill -g -a claude-code --copy -y'
  if ($npx) {
    try {
      & npx -y skills@latest add mattpocock/skills -s caveman -s grill-me -s handoff -s write-a-skill -g -a claude-code --copy -y
      if ($LASTEXITCODE -eq 0) { Ok "mattpocock productivity skills 已全域安裝（caveman/grill-me/handoff/write-a-skill）" }
      else { Warn "mattpocock skills 安裝非 0 退出，改列入手動步驟"; $manual.Add($mpCmd) }
    } catch { Warn "mattpocock skills 安裝失敗：$($_.Exception.Message)"; $manual.Add($mpCmd) }
  } else { Warn "找不到 npx，跳過 mattpocock"; $manual.Add($mpCmd) }

  # 5b) ui-ux-pro-max — Claude plugin（slash 指令需在 Claude 內跑；試 claude CLI）
  $claude = Get-Command claude -ErrorAction SilentlyContinue
  $uiMarket = 'nextlevelbuilder/ui-ux-pro-max-skill'
  $uiPlugin = 'ui-ux-pro-max@ui-ux-pro-max-skill'
  $uiDone = $false
  if ($claude) {
    try {
      & claude plugin marketplace add $uiMarket 2>$null
      & claude plugin install $uiPlugin 2>$null
      if ($LASTEXITCODE -eq 0) { $uiDone = $true; Ok "ui-ux-pro-max 已透過 claude CLI 安裝" }
    } catch { }
  }
  if (-not $uiDone) {
    Warn "ui-ux-pro-max 需在 Claude Code 內安裝（slash 指令），已列入手動步驟"
    $manual.Add("在 Claude Code 內跑：/plugin marketplace add $uiMarket")
    $manual.Add("在 Claude Code 內跑：/plugin install $uiPlugin")
  }

  # 5c) karpathy — 預設不裝（四原則已 bake 進薄規則）；-KarpathyPlugin 才裝
  if ($KarpathyPlugin) {
    $kMarket = 'multica-ai/andrej-karpathy-skills'   # 你指定的命名空間（其 README 上游為 forrestchang）
    $kPlugin = 'andrej-karpathy-skills@karpathy-skills'
    $manual.Add("在 Claude Code 內跑：/plugin marketplace add $kMarket")
    $manual.Add("在 Claude Code 內跑：/plugin install $kPlugin（若 multica-ai 解析失敗，改用 forrestchang/andrej-karpathy-skills）")
    Warn "karpathy plugin 需在 Claude 內安裝，已列入手動步驟（四原則本身已 bake 進規則，可不裝）"
  } else {
    Ok "karpathy 四原則已 bake 進薄規則（未裝外部 plugin；要裝加 -KarpathyPlugin）"
  }

  # 5d) Playwright 瀏覽器預熱（machine-level；@playwright/test 由各專案 /flow-verify 自行加）
  if (-not $SkipPlaywright -and $npx) {
    try {
      Say "預熱 Playwright Chromium（首次較久）"
      & npx -y playwright@latest install chromium
      if ($LASTEXITCODE -eq 0) { Ok "Playwright Chromium 已就緒" } else { Warn "Playwright 安裝非 0 退出，可日後手動 npx playwright install chromium" }
    } catch { Warn "Playwright 預熱失敗：$($_.Exception.Message)" }
  }
}
else { Say "已指定 -SkipExternal，跳過外部 skill 與 Playwright" }

# 6) 寫 POST-INSTALL.md（手動步驟備忘）
$postPath = Join-Path $ClaudeHome 'FLOW-POST-INSTALL.md'
$post = @()
$post += "# Flow 安裝後手動步驟（$stamp）"
$post += ""
if ($manual.Count -gt 0) {
  $post += "下列步驟需在 Claude Code 內或手動完成："
  foreach ($m in $manual) { $post += "- $m" }
} else {
  $post += "無待辦手動步驟，全部自動完成。"
}
$post += ""
$post += "## 驗證安裝"
$post += "- 重開 Claude Code，打 /flow 應看到一鍵總控；/flow-spec /flow-plan /flow-build /flow-verify /flow-ship 應齊全。"
$post += "- ~/.claude/rules/flow.md 應存在（rules/ 每 session 自動載入，等同 CLAUDE.md 優先級）。"
$post += "- ~/.claude/settings.json 的 hooks 應含 flow-verify-gate 與 flow-session-start。"
[IO.File]::WriteAllText($postPath, ($post -join "`r`n"), (New-Object Text.UTF8Encoding($false)))
Ok "已寫 FLOW-POST-INSTALL.md"

# 7) 總結
Say "安裝完成" 'Green'
if (-not $Quiet) {
  Write-Host ""
  Write-Host "  下一步：" -ForegroundColor White
  Write-Host "   1. 重開 Claude Code" -ForegroundColor Gray
  Write-Host "   2. 在專案資料夾打 /flow 開始（或 /flow-spec 從需求訪談起）" -ForegroundColor Gray
  if ($manual.Count -gt 0) { Write-Host "   3. 看 $postPath 完成 $($manual.Count) 個手動步驟" -ForegroundColor Gray }
  Write-Host ""
}
