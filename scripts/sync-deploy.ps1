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
# The live source is $DSH_HOME (default ~/.dsh), and every mirrored text file
# is SANITIZED: the local user's absolute path prefix (`C:\Users\<user>\`) is
# replaced with the neutral `C:\Users\<USER>\` placeholder, so the public repo
# never carries a personal username. The live files stay untouched.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/sync-deploy.ps1

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir
$deploy = Join-Path $root 'deploy'
$archive = Join-Path $deploy 'archive'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$userPrefix = [regex]::Escape((Join-Path $HOME ''))

# ── current-version resolution (single source of truth: web patch + composition) ──
# The regexes anchor on the `name:` row so comments mentioning old version
# numbers can never win.
$patchPath = Join-Path $dshHome 'profiles\web\cordis.patch.yml'
$compPath = Join-Path $dshHome '.agent-presets\continuity\agent.cordis.yml'
$patch = Get-Content $patchPath -Raw
$comp = Get-Content $compPath -Raw
$pluginVer = if ($comp -match '(?m)^\s*name: \./continuity-plugin\.v(\d+)\.mjs') { 'continuity-plugin.v' + $matches[1] + '.mjs' } else { throw 'plugin version not found in agent.cordis.yml' }
$rotationVer = if ($patch -match '(?m)^\s*name: file:///C:/Users/[^/]+/\.dsh/continuity-host/continuity-rotation\.v(\d+)\.mjs') { 'continuity-rotation.v' + $matches[1] + '.mjs' } else { throw 'rotation version not found in web patch' }
$worktreeVer = if ($patch -match '(?m)^\s*name: file:///C:/Users/[^/]+/\.dsh/continuity-host/continuity-worktree\.v(\d+)\.mjs') { 'continuity-worktree.v' + $matches[1] + '.mjs' } else { throw 'worktree version not found in web patch' }
$missionVer = if ($patch -match '(?m)^\s*name: file:///C:/Users/[^/]+/\.dsh/continuity-host/continuity-mission\.v(\d+)\.mjs') { 'continuity-mission.v' + $matches[1] + '.mjs' } else { throw 'mission version not found in web patch' }
$rotationSrc = Get-Content (Join-Path $dshHome ('continuity-host\' + $rotationVer)) -Raw
$sharedVer = if ($rotationSrc -match 'continuity-shared\.v(\d+)\.mjs') { 'continuity-shared.v' + $matches[1] + '.mjs' } else { throw 'shared version not found in rotation driver' }

# source -> destination -> keep-list (everything else in deploy/ is archived)
$fileTargets = @(
  @{
    Src = (Join-Path $dshHome '.agent-presets\continuity')
    Dst = (Join-Path $deploy 'agent-presets\continuity')
    Keep = @('agent.cordis.yml', 'preset.yml', $pluginVer)
  },
  @{
    Src = (Join-Path $dshHome 'continuity-host')
    Dst = (Join-Path $deploy 'continuity-host')
    Keep = @($rotationVer, $worktreeVer, $missionVer, $sharedVer, 'patch-pipeline-test.mjs', 'rotation-beacon.mjs')
  },
  @{
    Src = (Join-Path $dshHome 'profiles\web')
    Dst = (Join-Path $deploy 'profiles\web')
    Keep = @('cordis.patch.yml')
  },
  @{
    Src = (Join-Path $dshHome 'profiles\continuity-smoke')
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

# ── sanitize: the public repo must never carry the local user's home path ──
# Every mirrored text file (mirror + archive) gets the personal username
# replaced with the neutral `<USER>` placeholder. The regex covers all three
# spellings found in the files: `C:\Users\<USER>\`, `C:/Users/<USER>/` (file
# URLs) and `C:\\Users\\<USER>\\` (escaped inside .mjs strings). Live files
# under $DSH_HOME are never touched.
$sanitized = 0
Get-ChildItem $deploy -Recurse -File | ForEach-Object {
  if ($_.Extension -notin @('.mjs', '.yml', '.yaml', '.ps1', '.json', '.md')) { return }
  $content = [System.IO.File]::ReadAllText($_.FullName)
  if ($content -match 'C:[\\/]+Users[\\/]+wangy[\\/]') {
    $clean = [regex]::Replace($content, '(C:[\\/]+Users[\\/]+)wangy([\\/])', '$1<USER>$2')
    [System.IO.File]::WriteAllText($_.FullName, $clean)
    $sanitized += 1
  }
}
Write-Output "== sanitized $sanitized file(s): personal home path -> <USER> placeholder (live files untouched)"

Write-Output ''
Write-Output '== version references sanity:'
Write-Output ('  plugin    ' + $pluginVer)
Write-Output ('  rotation  ' + $rotationVer)
Write-Output ('  worktree  ' + $worktreeVer)
Write-Output ('  mission   ' + $missionVer)
Write-Output ('  shared    ' + $sharedVer)
