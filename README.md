# 小土豆图片混淆工具 / Potato Image Obfuscator

<!-- 顶部语言切换提示 -->
<details>
<summary>🌐 语言切换 / Language Switch</summary>

- [中文](#中文) | [English](#english)
</details>

---

<a id="中文"></a>

## 🇨🇳 中文文档

### 🚀 项目概述

一个基于广义希尔伯特（Gilbert）曲线与黄金分割比偏移的图片混淆工具，提供命令行（C++、Python）
与 Web（HTML + WebAssembly）两种使用方式：把图像像素沿空间填充曲线重新排列，并整体循环位移。

> **混淆 ≠ 加密。** 本项目不涉及密钥，`offset` 由图片尺寸公开推导，任何人都能用同样的工具还原。
> 它解决的是"防止图片被随意浏览/被内容识别模型直接读取"，不是保密。需要真正保密请使用
> AES/RSA 之类的加密方案。

### ✨ 核心算法

1. 生成覆盖 `width × height` 矩形、且每个像素恰好访问一次的**广义希尔伯特曲线**；
2. 沿曲线做循环位移：加密时 `dst[(i + offset) % total] = src[i]`，解密反向；
3. `offset = round(0.618033988749895 × total)`，也可手动指定。

三段实现（C++、Rust/WASM、Python）使用**同一条曲线、同一个偏移量公式、同样的 4 字节/像素语义**，
产物可以互相解混淆——这一点由 `tests/cross_language.test.mjs` 强制保证（四端逐字节比对）。

### 📦 各端用法

#### C++ 命令行（主力，最快）

环境：MSYS2 mingw64 + OpenCV 4.12（`g++ -std=c++20`）。

```powershell
powershell -File Cpp/build.ps1          # 构建，产物在 Cpp/bin/hilbert_encrypt.exe

cd <存放图片的目录>
Cpp/bin/hilbert_encrypt.exe -e                       # 混淆 files/ 下的图片
Cpp/bin/hilbert_encrypt.exe -d                       # 解混淆
Cpp/bin/hilbert_encrypt.exe -e -o 1234567            # 指定偏移量（auto 为默认）
Cpp/bin/hilbert_encrypt.exe -e -j 4                  # 指定并发线程数
Cpp/bin/hilbert_encrypt.exe -h                       # 完整帮助
```

要点：

- 处理 `./files/` 目录，**原地覆盖**原文件，请先备份；
- PNG/TIFF/BMP 无损，可完整还原；**JPG/WebP 是有损格式**，混淆后再压缩会破坏像素对应关系，
  程序会打印警告，并可用 `--jpeg-quality` / `--webp-quality` 调整；
- 写入采用"临时文件 + 改名"的原子方式，中途失败不会留下半张图。

#### Web 版（浏览器，WASM 加速）

- 线上地址（GitHub Pages）：<https://baobingwen.github.io/tools/GilbertCrypt/test/>
- 本地运行当前版本：

```powershell
node tests/serve_web.mjs        # 起服务后访问 http://127.0.0.1:8080/
```

打开页面 → 选择或拖入图片 → 点"混淆/解混淆"。页面上的"偏移参数"留空或填 `auto` 即使用默认值，
与命令行公式完全一致；填数字则用该偏移量（可用于解出早期版本用 `auto` 混淆的图片，见"兼容性"）。

> ⚠️ 线上 Pages 站点**尚未同步到本版本**，它用的是旧的 `round(φ×(总像素数-1))` 偏移量：
> 用线上版本 `auto` 混淆的图片，需要把偏移量手动 ±1 才能用命令行/新版本解出。

> 🔧 本机实测：本环境解析 `baobingwen.github.io` 得到的是非公网地址，无法替你确认线上页面是否仍在服务，
> 上面这条按"线上仍是旧版"处理，请你以浏览器实际打开的结果为准。

#### Python 版

```powershell
python -m src.cli -i 输入.png -o 输出.png -m encrypt
python -m src.cli --folder files -m encrypt      # 批量原地覆盖
```

详见 [`Python/README.md`](Python/README.md)。

### 📊 性能基线

数据由 `node tests/bench.mjs` 生成（本机 28 逻辑核 / 32GB）：

| 尺寸 | 像素 | C++（含读写盘） | Rust/WASM（仅置换） | Python（含读写盘） |
| --- | --- | --- | --- | --- |
| 1024×768 | 0.79 MP | 0.43 s | 29 ms | 1.7 s |
| 1382×924 | 1.28 MP | 0.43 s | 49 ms | 2.6 s |
| 1920×1080 | 2.07 MP | 0.45 s | 63 ms | — |
| 4000×3000 | 12 MP | 0.45 s | 623 ms | — |

C++ 用固定大小线程池并发处理多张图；单张图的耗时主要在编解码，像素重排本身只占很小一部分
（`--out-of-place` 与默认的原地置换耗时基本一致，原地置换省的是内存而不是时间）。

### 🧪 测试

```powershell
node tests/run_all.mjs          # 全部（Rust 单测 + 跨语言 + Web 契约 + 端到端 CLI）
node tests/run_all.mjs --quick  # 跳过耗时用例
```

详见 [`tests/README.md`](tests/README.md)。

### ⚠️ 兼容性说明（重要）

本版本统一了各端算法与偏移量公式，因此与一年前的旧版本存在**三处不兼容**：

| 变更 | 影响 | 补救方式 |
| --- | --- | --- |
| Web 端默认偏移量由 `round(φ×(总像素数-1))` 改为 `round(φ×总像素数)` | 用旧 Web 版 `auto` 值混淆的图片，新版解不出 | 在"偏移参数"里试 `自动值±1`；显式填过数字的不受影响 |
| Python 端曲线换成广义希尔伯特曲线 | 旧 Python 加密的图片无法再解 | 用 `Python/legacy/` 里的旧脚本解密 |
| `web/src/wasm/` 产物由 `web/rs` 重新构建 | 需成对替换 wasm 与 JS 胶水，不要混用 | 直接 `node tests/run_all.mjs` 验证 |

### 🌍 项目结构

```
.
├── Cpp/                      # C++ 命令行版
│   ├── hilbert_encrypt.cpp   #   唯一源码
│   ├── build.ps1             #   一键构建
│   └── CMakeLists.txt
├── web/                      # Web 版
│   ├── src/                  #   当前版本（index.html + worker.js + wasm/）
│   ├── rs/                   #   WASM 核心的 Rust 源码（产物 web/src/wasm 由它生成）
│   ├── versions/             #   历史版本存档
│   └── tmp/                  #   开发期临时快照（不参与构建）
├── Python/                   # Python 版
│   ├── src/                  #   当前实现（gilbert_core.py + cli.py）
│   ├── tests/                #   单元测试
│   └── legacy/               #   旧算法存档（不兼容）
├── js/                       # 最初的 Node.js 实现（算法源头，仅存档）
├── tests/                    # 跨语言/端到端/契约测试（Node）
├── files/                    # 命令行工具的默认处理目录（自动创建）
└── images/                   # 大体积测试素材（不纳入版本管理）
```

### ⚠️ 其它注意事项

- 命令行工具会**覆盖原文件**，处理前请备份；
- Web 版单张图上限 4096×4096 像素（WASM 内存与浏览器画布限制），超大图请用命令行；
- 目前仅在 Windows 上验证过（依赖 `windows.h`/`psapi` 与 MSYS2 工具链）。

<a id="english"></a>

## English Documentation

Waiting for a stable version.

暂无英文版说明，等待大版本再更新
