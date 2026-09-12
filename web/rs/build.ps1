# 构建 web/src/wasm/ 下的 WebAssembly 核心与 JS 胶水。
# 用法: pwsh -File web/rs/build.ps1
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here '..\..')
$out  = Join-Path $repo 'web\src\wasm'
$bindgenDir = Join-Path $here 'target\bindgen'
$wasm = Join-Path $here 'target\wasm32-unknown-unknown\release\lp_crypt_wasm_core.wasm'

Push-Location $here
try {
    Write-Host '[1/3] cargo build --release --target wasm32-unknown-unknown' -ForegroundColor Cyan
    cargo build --release --target wasm32-unknown-unknown
    if ($LASTEXITCODE -ne 0) { throw "cargo build 失败 ($LASTEXITCODE)" }

    Write-Host '[2/3] wasm-bindgen --target web --reference-types' -ForegroundColor Cyan
    wasm-bindgen --target web --reference-types --out-dir $bindgenDir --out-name lp_crypt_wasm_core $wasm
    if ($LASTEXITCODE -ne 0) { throw "wasm-bindgen 失败 ($LASTEXITCODE)" }

    Write-Host '[3/3] 复制产物到 web/src/wasm/' -ForegroundColor Cyan
    Copy-Item (Join-Path $bindgenDir 'lp_crypt_wasm_core.js')      $out -Force
    Copy-Item (Join-Path $bindgenDir 'lp_crypt_wasm_core_bg.wasm') $out -Force

    foreach ($f in 'lp_crypt_wasm_core.js', 'lp_crypt_wasm_core_bg.wasm') {
        $p = Join-Path $out $f
        $hash = (Get-FileHash $p -Algorithm SHA256).Hash
        Write-Host ("  {0,-32} {1,8} bytes  {2}" -f $f, (Get-Item $p).Length, $hash)
    }
    Write-Host '完成。' -ForegroundColor Green
}
finally {
    Pop-Location
}
