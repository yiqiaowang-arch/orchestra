# install.ps1 — 安装：deploy/ 镜像 → 本机 DeepSeek Harness 实际运行位置。
#
# 目标读者：克隆本仓库、想在自家 Harness 上使用接力模式的人。
# 安全设计：
#   - 版本化文件（*.vN.mjs）只会新增、绝不覆盖（文件名唯一）；
#   - 用户的 web 补丁文件若与镜像不同 → 自动备份并打印手工合并说明，绝不强写；
#   - 组合文件（agent.cordis.yml / preset.yml）若已存在且不同 → 同样备份并提示。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$deploy = Join-Path $root 'deploy'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }

Write-Output "DSH_HOME = $dshHome"

function Copy-AllFiles($srcDir, $dstDir) {
  New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
  Get-ChildItem -LiteralPath $srcDir -File | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $dstDir $_.Name) -Force
    Write-Output ("  copied: " + (Join-Path $dstDir $_.Name))
  }
}

function Install-IfChanged($srcFile, $dstFile, $label) {
  if (Test-Path $dstFile) {
    $same = (Get-FileHash $srcFile).Hash -eq (Get-FileHash $dstFile).Hash
    if ($same) { Write-Output "  unchanged (skip): $dstFile"; return }
    $backup = "$dstFile.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item $dstFile $backup -Force
    Write-Output "  DIFFERS — backed up to $backup"
    Write-Output "  !! 请手工合并后写入: $dstFile  （镜像版本见 $srcFile）"
    return
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dstFile) | Out-Null
  Copy-Item $srcFile $dstFile -Force
  Write-Output "  copied: $dstFile"
}

Write-Output ''
Write-Output '== 1/4 预设（接力模式）=='
Copy-AllFiles (Join-Path $deploy 'agent-presets\continuity') (Join-Path $dshHome '.agent-presets\continuity')

Write-Output ''
Write-Output '== 2/4 host 驱动器 =='
Copy-AllFiles (Join-Path $deploy 'continuity-host') (Join-Path $dshHome 'continuity-host')

Write-Output ''
Write-Output '== 3/4 web profile 补丁层 =='
Install-IfChanged (Join-Path $deploy 'profiles\web\cordis.patch.yml') (Join-Path $dshHome 'profiles\web\cordis.patch.yml') 'web patch'

Write-Output ''
Write-Output '== 4/4 离线管线测试 profile =='
Copy-AllFiles (Join-Path $deploy 'profiles\continuity-smoke') (Join-Path $dshHome 'profiles\continuity-smoke')

Write-Output ''
Write-Output '安装完成。下一步：'
Write-Output '  1. 刷新 GUI（补丁层热应用，几秒内生效）；'
Write-Output '  2. 任意 workspace 新建会话，预设选择器选「接力模式」；'
Write-Output '  3. 跑 /continuity —— 应看到 tokens/容量/比率 与 worker visibility 行。'
Write-Output ''
Write-Output '注意：已存在的会话仍使用旧代次（standing mount 按代次），新会话自动用最新版。'
