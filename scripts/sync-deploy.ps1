# sync-deploy.ps1 — mirror the LIVE user-owned continuity runtime files into
# deploy/ so one git repo can version the whole project.
#
# The runtime locations are fixed by the harness (G7: the loader caches module
# URLs, so the live files must stay where the patch/preset rows point). This
# repo therefore tracks a mirror: run this script BEFORE every commit, then
# `git status` must show only intended diffs.
#
# Only the CURRENT versions are mirrored (resolved from the web patch and the
# preset composition); every older generation found in deploy/ is moved into
# deploy/archive/ (kept for rollback/traceability — install.ps1 never copies
# it, and the live ~/.dsh directories always keep all generations).
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/sync-deploy.ps1

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir
$deploy = Join-Path $root 'deploy'
$archive = Join-Path $deploy 'archive'

# ── current-version resolution (single source of truth: web patch + composition) ──
# The regexes anchor on the `name:` row so comments mentioning old version
# numbers can never win.
$patch = Get-Content 'C:\Users\wangy\.dsh\profiles\web\cordis.patch.yml' -Raw
$comp = Get-Content 'C:\Users\wangy\.dsh\.agent-presets\continuity\agent.cordis.yml' -Raw
$pluginVer = if ($comp -match '(?m)^\s*name: \./continuity-plugin\.v(\d+)\.mjs') { 'continuity-plugin.v' + $matches[1] + '.mjs' } else { throw 'plugin version not found in agent.cordis.yml' }
$rotationVer = if ($patch -match '(?m)^\s*name: file:///C:/Users/wangy/\.dsh/continuity-host/continuity-rotation\.v(\d+)\.mjs') { 'continuity-rotation.v' + $matches[1] + '.mjs' } else { throw 'rotation version not found in web patch' }
$worktreeVer = if ($patch -match '(?m)^\s*name: file:///C:/Users/wangy/\.dsh/continuity-host/continuity-worktree\.v(\d+)\.mjs') { 'continuity-worktree.v' + $matches[1] + '.mjs' } else { throw 'worktree version not found in web patch' }
$missionVer = if ($patch -match '(?m)^\s*name: file:///C:/Users/wangy/\.dsh/continuity-host/continuity-mission\.v(\d+)\.mjs') { 'continuity-mission.v' + $matches[1] + '.mjs' } else { throw 'mission version not found in web patch' }
$rotationSrc = Get-Content ('C:\Users\wangy\.dsh\continuity-host\' + $rotationVer) -Raw
$sharedVer = if ($rotationSrc -match 'continuity-shared\.v(\d+)\.mjs') { 'continuity-shared.v' + $matches[1] + '.mjs' } else { throw 'shared version not found in rotation driver' }

# source -> destination -> keep-list (everything else in deploy/ is archived)
$fileTargets = @(
  @{
    Src = 'C:\Users\wangy\.dsh\.agent-presets\continuity'
    Dst = (Join-Path $deploy 'agent-presets\continuity')
    Keep = @('agent.cordis.yml', 'preset.yml', $pluginVer)
  },
  @{
    Src = 'C:\Users\wangy\.dsh\continuity-host'
    Dst = (Join-Path $deploy 'continuity-host')
    Keep = @($rotationVer, $worktreeVer, $missionVer, $sharedVer, 'patch-pipeline-test.mjs', 'rotation-beacon.mjs')
  },
  @{
    Src = 'C:\Users\wangy\.dsh\profiles\web'
    Dst = (Join-Path $deploy 'profiles\web')
    Keep = @('cordis.patch.yml')
  },
  @{
    Src = 'C:\Users\wangy\.dsh\profiles\continuity-smoke'
    Dst = (Join-Path $deploy 'profiles\continuity-smoke')
    Keep = @('package.json', 'cordis.patch.yml')
  }
)

function Move-ToArchive($dstDir, $file) {
  $rel = $dstDir.Substring($deploy.Length + 1)
  $archiveDir = Join-Path $archive $rel
  New-Item -ItemType Directory -Force -Path $archiveDir | Out-Null
  Move-Item (Join-Path $dstDir $file) (Join-Path $archiveDir $file) -Force
}

$archived = 0
foreach ($t in $fileTargets) {
  New-Item -ItemType Directory -Force -Path $t.Dst | Out-Null
  # 1. copy the current-version files from the live source
  foreach ($file in $t.Keep) {
    $srcFile = Join-Path $t.Src $file
    if (Test-Path $srcFile) { Copy-Item $srcFile (Join-Path $t.Dst $file) -Force }
    else { Write-Output "  !! missing in live source: $file" }
  }
  # 2. move every non-current file out of the mirror into the archive
  Get-ChildItem -LiteralPath $t.Dst -File -ErrorAction SilentlyContinue | ForEach-Object {
    if ($t.Keep -notcontains $_.Name) {
      Move-ToArchive $t.Dst $_.Name
      $archived += 1
    }
  }
  # 3. drop keep-list files whose live source disappeared (true reflection)
  foreach ($file in $t.Keep) {
    $mirrorFile = Join-Path $t.Dst $file
    if ((Test-Path $mirrorFile) -and -not (Test-Path (Join-Path $t.Src $file))) { Remove-Item $mirrorFile -Force }
  }
}

Write-Output '== deploy mirror synced (current versions only). Mirrored files:'
Get-ChildItem $deploy -Recurse -File | Where-Object { $_.FullName -notlike "$archive*" } | ForEach-Object { $_.FullName.Substring($deploy.Length + 1) } | Sort-Object
Write-Output ''
Write-Output "== archived $archived non-current file(s) into deploy\archive (rollback only; install.ps1 never copies it)"

Write-Output ''
Write-Output '== version references sanity:'
Write-Output ('  plugin    ' + $pluginVer)
Write-Output ('  rotation  ' + $rotationVer)
Write-Output ('  worktree  ' + $worktreeVer)
Write-Output ('  mission   ' + $missionVer)
Write-Output ('  shared    ' + $sharedVer)
