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

# ---------------------------------------------------------------- 复制运行时依赖
# Windows 上 MinGW 动态链接的 exe 需要一串 DLL 才能启动，而且**间接依赖**（OpenCV 依赖的
# zlib/lzma/zstd 等）很容易漏——手工清单维护不过来，这里用 objdump 解析导入表，
# 递归算依赖闭包再复制，让 Cpp/bin 自包含（换机器、或在 CI 里被 Node 子进程调用都不怕）。
$objdump = Join-Path $MingwRoot 'bin\objdump.exe'
$binDir = Join-Path $MingwRoot 'bin'
if (-not (Test-Path $objdump)) {
    $cmd = Get-Command objdump -ErrorAction SilentlyContinue
    if ($cmd) { $objdump = $cmd.Source }
}

# 由 Windows 自己提供的系统库，不需要复制
$systemDllPattern = '^(api-ms-|ext-ms-|KERNEL|USER32|ADVAPI|SHELL32|GDI32|OLE32|OLEAUT|COMDLG|WS2_|WSOCK|VCRUNTIME|ucrtbase|MSVCP|ntdll|bcrypt|CRYPT32|PSAPI|WINMM|VERSION|IMM32|SHLWAPI|mpr|dbghelp|POWRPROF|DWMAPI|UxTheme|d3d|DXGI|opengl|setupapi|CFGMGR32|RPCRT4|secur32|normaliz|WLDAP32|urlmon|wininet|IPHLPAPI|DNSAPI|NETAPI32|USERENV|PROFAPI|AUTHZ|SSPICLI|schannel|ncrypt|WINTRUST|imagehlp)'

if (-not $objdump) {
    Write-Warning "找不到 objdump，跳过运行时依赖复制；请确保运行时能找到 MSYS2 的 DLL"
}
else {
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($item.FullName)
    $visited = @{}
    $copied = 0
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        if ($visited.ContainsKey($current)) { continue }
        $visited[$current] = $true

        $imports = & $objdump -p $current 2>$null |
            Select-String 'DLL Name:' |
            ForEach-Object { ($_ -split 'DLL Name:')[1].Trim() }

        foreach ($dll in $imports) {
            if ($dll -match $systemDllPattern) { continue }
            $src = Join-Path $binDir $dll
            if (-not (Test-Path $src)) { continue }   # 系统盘或别处提供的，交给系统加载
            $dst = Join-Path $outDir $dll
            if (-not (Test-Path $dst)) {
                Copy-Item $src $dst -Force
                $copied++
            }
            $queue.Enqueue($dst)
        }
    }
    Write-Host ("已复制 {0} 个运行时依赖 DLL（含间接依赖）到 {1}" -f $copied, $outDir) -ForegroundColor DarkGray

    # 自检：再跑一遍依赖闭包，确认 bin 目录里没有缺口
    $final = @{}
    $q2 = New-Object System.Collections.Queue
    $q2.Enqueue($item.FullName)
    $miss = @()
    while ($q2.Count -gt 0) {
        $cur = $q2.Dequeue()
        if ($final.ContainsKey($cur)) { continue }
        $final[$cur] = $true
        $imports = & $objdump -p $cur 2>$null | Select-String 'DLL Name:' | ForEach-Object { ($_ -split 'DLL Name:')[1].Trim() }
        foreach ($dll in $imports) {
            if ($dll -match $systemDllPattern) { continue }
            $inBin = Join-Path $outDir $dll
            $inSys = Join-Path 'C:\Windows\System32' $dll
            if (Test-Path $inBin) { $q2.Enqueue($inBin) }
            elseif (-not (Test-Path $inSys)) { $miss += $dll }
        }
    }
    if ($miss.Count -gt 0) {
        Write-Warning ("依赖自检发现仍缺失（这些 DLL 需要运行时能通过 PATH 找到）：{0}" -f (($miss | Sort-Object -Unique) -join ', '))
    }
    else {
        Write-Host "依赖自检通过：bin 目录已自包含" -ForegroundColor DarkGray
    }
}
