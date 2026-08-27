# 一键重建插件内嵌 embedding 运行时（win32-x64 CPU 精简版）。
# 幂等：npm install → sharp 存根 → 平台/GUI 冗余裁剪。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $root 'vendor\embedding-runtime'

Push-Location $vendor
try {
  if (-not (Test-Path 'package.json')) {
    Set-Content -Path 'package.json' -Encoding UTF8 -Value '{"name":"embedding-runtime","version":"0.1.0","private":true,"dependencies":{"@huggingface/transformers":"^3.7.0","onnxruntime-node":"^1.22.0"}}'
  }
  npm install --legacy-peer-deps | Out-Null

  # sharp 存根（文本推理不需要图像；真实 sharp ~240MB）
  $stub = Join-Path $vendor 'node_modules\sharp'
  New-Item -ItemType Directory -Force -Path $stub | Out-Null
  Set-Content -Path (Join-Path $stub 'package.json') -Encoding UTF8 -Value '{"name":"sharp","version":"0.0.0-stub","main":"index.js"}'
  Set-Content -Path (Join-Path $stub 'index.js') -Encoding UTF8 -Value "module.exports = function sharp() { throw new Error('sharp stub: 本运行时仅文本推理，图像功能不可用') }; module.exports.default = module.exports;"

  # 裁剪：只留 win32-x64 CPU
  $nm = Join-Path $vendor 'node_modules'
  foreach ($p in @('onnxruntime-web','sharp')) { Remove-Item (Join-Path $nm $p) -Recurse -Force -ErrorAction SilentlyContinue }
  foreach ($base in @("$nm\onnxruntime-node\bin\napi-v6", "$nm\@huggingface\transformers\node_modules\onnxruntime-node\bin\napi-v3")) {
    if (Test-Path $base) {
      foreach ($p in @('darwin','linux')) { Remove-Item (Join-Path $base $p) -Recurse -Force -ErrorAction SilentlyContinue }
      Remove-Item (Join-Path $base 'win32\arm64') -Recurse -Force -ErrorAction SilentlyContinue
      foreach ($f in @('DirectML.dll','dxcompiler.dll')) { Remove-Item (Join-Path $base "win32\x64\$f") -Force -ErrorAction SilentlyContinue }
    }
  }
  Remove-Item "$nm\@huggingface\transformers\dist\ort-wasm-simd-threaded.jsep.wasm" -Force -ErrorAction SilentlyContinue
  Write-Output "vendor runtime ready:"
  Get-ChildItem $nm -Recurse -File | Measure-Object Length -Sum | ForEach-Object { Write-Output ("  {0:N0} MB" -f ($_.Sum/1MB)) }
} finally {
  Pop-Location
}
