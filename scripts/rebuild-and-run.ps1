<#
.SYNOPSIS
  在当前 harness（B+）上重建 dsh-price-less 并重启 `pnpm dsh web`。

.DESCRIPTION
  幂等五步：
    ① 插件重链 node_modules junction + 重编译 lib（DSH_CHECKOUT = 当前 harness）
    ② 验收：typecheck:tests → gate → smoke:lib
    ③ 产物层探针：probe:channel（事实轨走会话日志真源还是降级 KV 镜像）
       + probe:provider（U17 取代路径：preset 的 provider 行能否被解析并落地）
    ④ 停掉占用端口的旧宿主进程
    ⑤ 从 harness 启动 `pnpm dsh web`（前台，Ctrl+C 停）

  **不碰会话数据**：B+ 与现有会话同为格式 v3（最高迁移包 `session-format-v2-to-v3`，
  现有文件 = `session.v3.jsonl.zstd`），**不要**清空/挪走 `~/.dsh/sessions` 与 `~/.dsh/storages`。

  前置：harness checkout 已在 B+（`bplus-0.1.5` @ `f0dc41471c`）。若还在旧基线，先跑
  `pwsh -File scripts\promote-bplus.ps1` 切基线，再跑本脚本。

.PARAMETER Checkout
  harness checkout 路径。默认 `G:\deepseek-harness`。

.PARAMETER Port
  宿主端口，用于定位旧宿主进程。默认 `3080`。

.PARAMETER SkipRestart
  只重建 + 验收，不重启（不杀进程、不起 web）。

.PARAMETER SkipChecks
  跳过 ②③（赶时间时用；**不建议**，gate/smoke 是"构建产物本身正确"的唯一证据）。

.EXAMPLE
  pwsh -File scripts\rebuild-and-run.ps1
  pwsh -File scripts\rebuild-and-run.ps1 -SkipRestart
#>
[CmdletBinding()]
param(
  [string]$Checkout = 'G:\deepseek-harness',
  [int]$Port = 3080,
  [switch]$SkipRestart,
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$gitBash = 'C:\Program Files\Git\bin\bash.exe'

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Fail($m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

if (-not (Test-Path (Join-Path $Checkout 'packages'))) { Fail "不是 harness checkout：$Checkout" }
if (-not (Test-Path $gitBash)) { Fail "找不到 Git Bash：$gitBash（PATH 上的 bash 是 WSL，build.sh 会挂在 set: pipefail）" }

# ── ① 重链 + 重编译（build.sh 自己 cd 到仓库根，故传绝对路径）────────────────────
Step "① 插件重链 + 重编译（DSH_CHECKOUT=$Checkout）"
$env:DSH_CHECKOUT = ($Checkout -replace '\\', '/')
& $gitBash (Join-Path $pluginRoot 'scripts/build.sh')
if ($LASTEXITCODE -ne 0) { Fail '插件 build.sh 失败' }

Push-Location $pluginRoot
try {
  if (-not $SkipChecks) {
    # ── ② 验收（任何一项红 = 不要重启宿主：会拿到"插件新、宿主旧"的错配）──────────
    Step '② 验收：typecheck:tests → gate → smoke:lib'
    npm run typecheck:tests ; if ($LASTEXITCODE -ne 0) { Fail 'typecheck:tests 失败——不要重启宿主' }
    npm run gate            ; if ($LASTEXITCODE -ne 0) { Fail 'gate 失败——不要重启宿主' }
    npm run smoke:lib       ; if ($LASTEXITCODE -ne 0) { Fail 'smoke:lib 失败——不要重启宿主' }

    # ── ③ 通道探针：ignorable 透传是否在产物层闭合 ────────────────────────────────
    Step '③ 通道探针 probe:channel + 取代路径探针 probe:provider'
    npm run probe:channel
    if ($LASTEXITCODE -ne 0) { Fail '通道未闭合（事实轨会降级 KV 镜像）——检查 harness 是否真的在 B+' }
    # U17：取代路线的前提（包 exports 解析 / 模块实例同一 / 根 realm 无泄漏 / 缝可从 isolate 组内解析）
    # 全都不在 src 层，只有产物层看得出；红了说明 preset 换行会挂载失败。
    npm run probe:provider
    if ($LASTEXITCODE -ne 0) { Fail '取代路径未闭合（preset 的 provider 行会挂载失败）' }
  } else {
    Step '② ③ 已按 -SkipChecks 跳过'
  }
} finally {
  Pop-Location
}

if ($SkipRestart) {
  Write-Host "`n=== 完成（-SkipRestart，未重启宿主）===" -ForegroundColor Green
  exit 0
}

# ── ④ 停掉旧宿主 ──────────────────────────────────────────────────────────────
Step "④ 停掉占用端口 $Port 的旧宿主"
$pids = @()
try {
  $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess -Unique)
} catch {
  $pids = @(netstat -ano | Select-String ":$Port\s" | ForEach-Object {
    $f = ($_ -split '\s+') | Where-Object { $_ -ne '' }
    if ($f[-1] -match '^\d+$' -and ($_ -match 'LISTENING')) { $f[-1] }
  } | Sort-Object -Unique)
}
$stopped = 0
foreach ($p in $pids) {
  if ($p -and [int]$p -gt 0) {
    Write-Host "  stop PID $p"
    Stop-Process -Id ([int]$p) -Force -ErrorAction SilentlyContinue
    $stopped++
  }
}
if ($stopped -eq 0) { Write-Host '  端口空闲（没有旧宿主在跑）' } else { Start-Sleep -Seconds 2 }

# ── ⑤ 起 web（前台）────────────────────────────────────────────────────────────
Step "⑤ 从 harness 启动：pnpm dsh web"
Write-Host "  cwd = $Checkout" -ForegroundColor DarkGray
Write-Host '  Ctrl+C 停止' -ForegroundColor DarkGray
Set-Location $Checkout
pnpm dsh web
