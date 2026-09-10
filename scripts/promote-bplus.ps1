<#
.SYNOPSIS
  把 harness 主 checkout 切到 B+ 基线（0.1.5-rc.2 + 重放的 ignorable 补丁），并重建插件。

.DESCRIPTION
  幂等三步：
    ① 移除临时 worktree（分支被 worktree 占用时主 checkout 无法 checkout 同一分支）
    ② 主 checkout 切到 bplus-0.1.5；pnpm install + build:lib
    ③ 插件重链 node_modules junction + 重新编译 lib（DSH_CHECKOUT = 主 checkout）
  **不碰会话数据、不重启宿主**——那两步由用户自决（见 docs/14 §5）。

  在跑完本脚本之前，**不要重启 DSH**：插件 lib 已按 B+ 编译，而宿主还是旧基线，会错配。

.PARAMETER Checkout
  harness 主 checkout 路径。默认 G:\deepseek-harness。

.PARAMETER Worktree
  临时 B+ worktree 路径。默认 G:\dsh-bplus-wt。

.PARAMETER Branch
  B+ 分支名。默认 bplus-0.1.5。

.PARAMETER SkipPlugin
  只切换 harness，不重编译插件。

.EXAMPLE
  pwsh -File scripts\promote-bplus.ps1
  pwsh -File scripts\promote-bplus.ps1 -SkipPlugin
#>
[CmdletBinding()]
param(
  [string]$Checkout = 'G:\deepseek-harness',
  [string]$Worktree = 'G:\dsh-bplus-wt',
  [string]$Branch = 'bplus-0.1.5',
  [switch]$SkipPlugin
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$gitBash = 'C:\Program Files\Git\bin\bash.exe'

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Fail($m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

if (-not (Test-Path (Join-Path $Checkout '.git'))) { Fail "不是 git 仓库：$Checkout" }
if (-not (Test-Path $gitBash)) { Fail "找不到 Git Bash：$gitBash（build.sh 需要它；WSL bash 会挂在 set: pipefail）" }

# ── ① 移除临时 worktree（若在）────────────────────────────────────────────────
Step "① 移除临时 worktree（若存在）：$Worktree"
if (Test-Path $Worktree) {
  Push-Location $Checkout
  try { git worktree remove --force $Worktree } finally { Pop-Location }
  Write-Host "已移除 $Worktree"
} else {
  Write-Host "无 worktree，跳过"
}
Push-Location $Checkout
try { git worktree prune } finally { Pop-Location }

# ── ② 主 checkout 切到 B+ 并构建 ──────────────────────────────────────────────
Step "② checkout $Branch @ $Checkout"
Push-Location $Checkout
try {
  $branches = git branch --list $Branch
  if (-not $branches) { Fail "本地没有分支 $Branch——先在 worktree 里造出来（见 docs/14 §2.1）" }
  $dirty = git status --porcelain
  if ($dirty) { Write-Host "工作区有改动，先 stash：" -ForegroundColor Yellow; git stash push -u -m "promote-bplus-pre-switch" | Write-Host }
  git checkout $Branch
  Write-Host "HEAD = $(git rev-parse --short HEAD)"
  Write-Host '--- pnpm install ---'
  pnpm install --prefer-offline
  if ($LASTEXITCODE -ne 0) { Fail 'pnpm install 失败' }
  Write-Host '--- pnpm run build:lib ---'
  pnpm run build:lib
  if ($LASTEXITCODE -ne 0) { Fail 'build:lib 失败' }
} finally { Pop-Location }

# ── ③ 重链并重编译插件 ───────────────────────────────────────────────────────
if ($SkipPlugin) {
  Step '③ 跳过插件重建（-SkipPlugin）'
} else {
  Step "③ 重链 + 重编译插件（DSH_CHECKOUT=$Checkout）"
  $env:DSH_CHECKOUT = ($Checkout -replace '\\', '/')
  # build.sh 自己 cd 到仓库根，故传绝对路径（相对路径会被调用方 cwd 影响）。
  & $gitBash (Join-Path $pluginRoot 'scripts/build.sh')
  if ($LASTEXITCODE -ne 0) { Fail '插件 build.sh 失败' }
  Push-Location $pluginRoot
  try {
    Write-Host '--- npm run typecheck:tests ---'
    npm run typecheck:tests
    if ($LASTEXITCODE -ne 0) { Fail 'npm run typecheck:tests 失败——不要重启宿主' }
    Write-Host '--- npm run gate ---'
    npm run gate
    if ($LASTEXITCODE -ne 0) { Fail 'npm run gate 失败——不要重启宿主' }
    # 构建产物级冒烟（跑在 lib/ 上，不是 src）——src 层 vitest 全绿也照样漏构建/链接漂移。
    Write-Host '--- npm run smoke:lib ---'
    npm run smoke:lib
    if ($LASTEXITCODE -ne 0) { Fail 'npm run smoke:lib 失败——lib/ 与 harness 基线不匹配，不要重启宿主' }
  } finally { Pop-Location }
}

Write-Host @"

=== promote 完成 ===
接下来（自行决定，脚本不做）：
  1) 清空 / 挪走 v2 时代的会话与实体：~/.dsh/sessions 、 ~/.dsh/storages
  2) 重启宿主：停掉正在跑的 `pnpm dsh web`，重新 `cd G:\deepseek-harness ; pnpm dsh web`
  3) 浏览器 Ctrl+F5 硬刷新
回滚见 docs/14 §5。
"@ -ForegroundColor Green
