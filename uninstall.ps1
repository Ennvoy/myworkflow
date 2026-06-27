#Requires -Version 5.1
<#
.SYNOPSIS
  Flow 工作流反安裝檔（Windows）。移除 install.ps1 裝進 ~/.claude 的 Flow 自有檔，
  並從 settings.json 反向拔除 Flow 的 hook 接線（flow-verify-gate / flow-session-start）。
  冪等可重跑、編輯 settings.json / CLAUDE.md 前自動備份。
  預設「保留 git-tools skill」（commit+push 機制，脫離 Flow 仍可單獨用）；-RemoveGitTools 才一起清。
  外部 skill（mattpocock / ui-ux-pro-max / Playwright）屬第三方，不在移除範圍，僅列手動指令。
.PARAMETER ClaudeHome
  目標 .claude 目錄（預設 ~/.claude）。測試可指向拋棄式 temp 目錄。
.PARAMETER RemoveGitTools
  連同 git-tools skill 一起移除（完全還原到裝 Flow 前）。
.PARAMETER KeepGitTools
  明確保留 git-tools skill（與預設相同；提供以利覆寫 / 可讀性）。
.PARAMETER DryRun
  只列出將移除的項目，不實際刪除。
.EXAMPLE
  ./uninstall.ps1
.EXAMPLE
  ./uninstall.ps1 -DryRun
.EXAMPLE
  ./uninstall.ps1 -RemoveGitTools
#>
[CmdletBinding()]
param(
  [string]$ClaudeHome = (Join-Path $env:USERPROFILE '.claude'),
  [switch]$RemoveGitTools,
  [switch]$KeepGitTools,
  [switch]$DryRun,
  [switch]$Quiet
)

# --- 一律 UTF-8（呼叫 node 前）---
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dist = Join-Path $ScriptDir 'dist'

function Say($m, $c = 'Cyan') { if (-not $Quiet) { Write-Host "[Flow] $m" -ForegroundColor $c } }
function Ok($m)   { if (-not $Quiet) { Write-Host "   OK  $m" -ForegroundColor Green } }
function Warn($m) { Write-Host "   !!  $m" -ForegroundColor Yellow }

# git-tools 預設保留；-RemoveGitTools 才移除，-KeepGitTools 覆寫優先
$removeGit = $RemoveGitTools.IsPresent -and -not $KeepGitTools.IsPresent

Say "反安裝目標 ClaudeHome = $ClaudeHome"
if ($DryRun) { Say "（DryRun：只預覽，不刪除任何東西）" 'Yellow' }

# 1) 算移除清單（只列實際存在者）
$targets = New-Object System.Collections.Generic.List[string]
$cmdDir = Join-Path $ClaudeHome 'commands'
if (Test-Path $cmdDir) {
  Get-ChildItem $cmdDir -Filter 'flow*.md' -ErrorAction SilentlyContinue | ForEach-Object { $targets.Add($_.FullName) }
}
$ft = Join-Path $ClaudeHome 'skills\flow-toolkit'
if (Test-Path $ft) { $targets.Add($ft) }
$dsb = Join-Path $ClaudeHome 'skills\design-system-base'
if (Test-Path $dsb) { $targets.Add($dsb) }   # install.ps1 有裝 → 反安裝也要清（否則殘留、仍被當 active skill 載入）
$gt = Join-Path $ClaudeHome 'skills\git-tools'
if ($removeGit -and (Test-Path $gt)) { $targets.Add($gt) }
$rf = Join-Path $ClaudeHome 'rules\flow.md'
if (Test-Path $rf) { $targets.Add($rf) }
foreach ($hk in 'flow-verify-gate.mjs', 'flow-session-start.mjs', 'flow-size-check.mjs', 'flow-commit-gate.mjs', 'flow-design-base-hint.mjs', 'flow-stall-monitor.mjs', 'flow-auto-gate.mjs', 'flow-spec-gate.mjs') {
  $p = Join-Path $ClaudeHome "hooks\$hk"
  if (Test-Path $p) { $targets.Add($p) }
}
foreach ($ag in 'red-team.md', 'code-reviewer.md', 'spec-reviewer.md') {
  $p = Join-Path $ClaudeHome "agents\$ag"
  if (Test-Path $p) { $targets.Add($p) }
}
$post = Join-Path $ClaudeHome 'FLOW-POST-INSTALL.md'
if (Test-Path $post) { $targets.Add($post) }

# 2) 列出計畫
if ($targets.Count -eq 0) {
  Say "沒有發現 Flow 自有檔（可能未安裝或已移除）。"
} else {
  Say "將移除下列 $($targets.Count) 個 Flow 自有項目："
  foreach ($t in $targets) { Write-Host "   - $($t.Replace($ClaudeHome, '~/.claude'))" -ForegroundColor Gray }
}
if (-not $removeGit -and (Test-Path $gt)) { Ok "保留 git-tools skill（要一起移除請加 -RemoveGitTools）" }
Say "settings.json 的 Flow hook 接線（flow-verify-gate / flow-session-start）將被反向移除"

if ($DryRun) {
  Say "DryRun 結束，未變更任何檔案。" 'Yellow'
  exit 0
}

# 3) 編輯 settings.json / CLAUDE.md 前先備份
$settingsPath = Join-Path $ClaudeHome 'settings.json'
$claudeMd = Join-Path $ClaudeHome 'CLAUDE.md'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (Test-Path $settingsPath) {
  Copy-Item $settingsPath (Join-Path $ClaudeHome "settings.flow-uninstall-backup-$stamp.json")
  Ok "已備份 settings.json（settings.flow-uninstall-backup-$stamp.json）"
}
if (Test-Path $claudeMd) {
  Copy-Item $claudeMd (Join-Path $ClaudeHome "CLAUDE.flow-uninstall-backup-$stamp.md")
  Ok "已備份 CLAUDE.md（CLAUDE.flow-uninstall-backup-$stamp.md）"
}

# 4) 刪除 Flow 自有檔 / 目錄
foreach ($t in $targets) { if (Test-Path $t) { Remove-Item $t -Recurse -Force } }
if ($targets.Count -gt 0) { Ok "$($targets.Count) 個 Flow 檔案 / 目錄已移除" }

# 5) 反向移除 settings.json hook + 清舊版 CLAUDE.md FLOW 區塊（node helper）
$helper = Join-Path $Dist 'install\flow-uninstall.mjs'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node -and (Test-Path $helper)) {
  & node $helper $settingsPath $claudeMd
  if ($LASTEXITCODE -ne 0) { Warn "settings.json / CLAUDE.md 反向處理非 0 退出（exit $LASTEXITCODE）。已備份，請檢查。" }
  else { Ok "settings.json hook 接線已反向移除；CLAUDE.md 舊版 inline FLOW 區塊已清（若有）" }
} else {
  Warn "找不到 node 或 $helper，跳過 settings.json 反向移除——請手動刪除 settings.json 內 flow-verify-gate / flow-session-start 兩條 hook"
}

# 6) 收尾 + 外部 skill 提醒
Say "反安裝完成" 'Green'
if (-not $Quiet) {
  Write-Host ""
  Write-Host "  外部 skill 屬第三方、未移除（要清請手動）：" -ForegroundColor White
  Write-Host "   - ui-ux-pro-max：在 Claude Code 內 /plugin uninstall ui-ux-pro-max@ui-ux-pro-max-skill" -ForegroundColor Gray
  Write-Host "   - mattpocock/skills、Playwright Chromium：依各自方式移除" -ForegroundColor Gray
  Write-Host "  重開 Claude Code 生效。要重新安裝：./install.ps1" -ForegroundColor Gray
  Write-Host ""
}
