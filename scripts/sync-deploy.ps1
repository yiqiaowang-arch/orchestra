# sync-deploy.ps1 — mirror the LIVE user-owned continuity runtime files into
# deploy/ so one git repo can version the whole project.
#
# The runtime locations are fixed by the harness (G7: the loader caches module
# URLs, so the live files must stay where the patch/preset rows point). This
# repo therefore tracks a mirror: run this script BEFORE every commit, then
# `git status` must show only intended diffs.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/sync-deploy.ps1

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir
$deploy = Join-Path $root 'deploy'

# source -> destination (file-filtered copies only: never drag boot-generated files in)
$fileTargets = @(
  @{ Src = 'C:\Users\wangy\.dsh\.agent-presets\continuity'; Dst = (Join-Path $deploy 'agent-presets\continuity'); Files = @('*') },
  @{ Src = 'C:\Users\wangy\.dsh\continuity-host'; Dst = (Join-Path $deploy 'continuity-host'); Files = @('*.mjs') },
  @{ Src = 'C:\Users\wangy\.dsh\profiles\web'; Dst = (Join-Path $deploy 'profiles\web'); Files = @('cordis.patch.yml') },
  @{ Src = 'C:\Users\wangy\.dsh\profiles\continuity-smoke'; Dst = (Join-Path $deploy 'profiles\continuity-smoke'); Files = @('package.json', 'cordis.patch.yml') }
)

foreach ($t in $fileTargets) {
  New-Item -ItemType Directory -Force -Path $t.Dst | Out-Null
  foreach ($file in $t.Files) {
    Get-ChildItem -LiteralPath $t.Src -File | Where-Object { $_.Name -like $file } | ForEach-Object {
      Copy-Item $_.FullName (Join-Path $t.Dst $_.Name) -Force
    }
  }
}

# Remove mirror copies whose live source disappeared (keeps the mirror a true reflection).
foreach ($t in $fileTargets) {
  Get-ChildItem -LiteralPath $t.Dst -File -ErrorAction SilentlyContinue | ForEach-Object {
    if (-not (Test-Path (Join-Path $t.Src $_.Name))) { Remove-Item $_.FullName -Force }
  }
}

Write-Output '== deploy mirror synced. Mirrored files:'
Get-ChildItem $deploy -Recurse -File | ForEach-Object { $_.FullName.Substring($deploy.Length + 1) } | Sort-Object

Write-Output ''
Write-Output '== version references sanity:'
$patch = Get-Content 'C:\Users\wangy\.dsh\profiles\web\cordis.patch.yml' -Raw
$comp = Get-Content 'C:\Users\wangy\.dsh\.agent-presets\continuity\agent.cordis.yml' -Raw
if ($patch -match 'continuity-rotation\.v(\d+)\.mjs') { Write-Output ('  rotation  v' + $matches[1]) }
if ($patch -match 'continuity-worktree\.v(\d+)\.mjs') { Write-Output ('  worktree  v' + $matches[1]) }
if ($patch -match 'continuity-mission\.v(\d+)\.mjs') { Write-Output ('  mission   v' + $matches[1]) }
if ($comp -match 'continuity-plugin\.v(\d+)\.mjs') { Write-Output ('  plugin    v' + $matches[1]) }
