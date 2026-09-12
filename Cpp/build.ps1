# 构建 C++ 命令行版本。
# 用法:
#   powershell -File Cpp/build.ps1                 # 优化构建
#   powershell -File Cpp/build.ps1 -DebugBuild     # 带调试符号
#
# 依赖: MSYS2 mingw64 工具链 + OpenCV（默认路径可在参数里覆盖）

[CmdletBinding()]
param(
    [string]$Gxx = 'D:\msys64\mingw64\bin\g++.exe',
    [string]$MingwRoot = 'D:\msys64\mingw64',
    [switch]$DebugBuild,
    [switch]$StaticLink   # 尝试静态链接（历史上不稳定，默认关闭）
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path $Gxx)) {
    # 退回到 PATH 里的 g++
    $cmd = Get-Command g++ -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "找不到 g++：$Gxx" }
    $Gxx = $cmd.Source
}

$include = Join-Path $MingwRoot 'include\opencv4'
$lib = Join-Path $MingwRoot 'lib'
if (-not (Test-Path $include)) { throw "找不到 OpenCV 头文件目录：$include" }
if (-not (Test-Path $lib)) { throw "找不到 OpenCV 库目录：$lib" }

$outDir = Join-Path $here 'bin'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$out = Join-Path $outDir 'hilbert_encrypt.exe'

$flags = @('-std=c++20', '-Wall', '-Wextra', '-Wno-unknown-pragmas')
if ($DebugBuild) { $flags += @('-g', '-O0') } else { $flags += @('-O2', '-DNDEBUG') }
if ($StaticLink) { $flags += @('-static', '-static-libgcc', '-static-libstdc++') }

$libs = @('-lopencv_core', '-lopencv_imgproc', '-lopencv_imgcodecs', '-lpsapi')

$gxxArgs = $flags + @("-I$include", (Join-Path $here 'hilbert_encrypt.cpp'), '-o', $out, "-L$lib") + $libs

Write-Host "g++ $($gxxArgs -join ' ')" -ForegroundColor DarkGray
& $Gxx @gxxArgs
if ($LASTEXITCODE -ne 0) { throw "编译失败 (exit $LASTEXITCODE)" }

$item = Get-Item $out
Write-Host ("构建完成: {0}  ({1:N0} 字节)" -f $item.FullName, $item.Length) -ForegroundColor Green
