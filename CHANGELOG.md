# 更新日志 / Changelog

本项目在 v2.1.0 之前没有维护变更日志。旧版本（浏览器版、Python CLI、C++ CLI 各自独立演进）
只能从 git 历史与 `devlog.md` 还原，这里只列出关键节点；从 v2.1.0 起按
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的格式维护，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [2.1.0] - 2026-09-12

一次"复盘 + 还债"版本：把三套实现统一到同一条曲线，让浏览器端产物可复现，并建立测试体系。
**本次包含破坏性变更**，升级前请看"不兼容变更"一节。

### 新增

- **Web/WASM 核心从零补齐源码**：`web/rs`（Rust crate），产物 `web/src/wasm/*` 由它生成，
  不再是无源二进制。`web/rs/build.ps1` 一键构建，wasm-bindgen 锁死 `=0.2.100`。
- **原地循环置换**：WASM 与 C++ 的像素重排改为沿置换环就地搬运，峰值内存从 2 份缓冲区降为
  1 份缓冲区 + 1 bit/像素（`--out-of-place` 保留旧写法用于对照与基准）。
- **三端互通**：Python 改用与 C++/WASM 相同的广义希尔伯特曲线、相同偏移量公式、
  相同 RGBA 语义，任一端混淆的图都能被其它端解出。
- **C++ CLI 选项**：`-o/--offset`（`auto` 或显式数值）、`-j/--jobs`（并发线程数）、
  `--jpeg-quality`、`--webp-quality`、`--in-place/--out-of-place`、`-q/--quiet`、`-h/--help`。
- **Python CLI**：`python -m src.cli -i 输入 -o 输出 -m encrypt|decrypt`，支持 `--folder` 批量、
  `--offset` 显式偏移量。
- **测试体系 `tests/`**：
  - `cross_language.test.mjs`：Node 参考实现 / Rust-WASM / C++ / Python 四端逐字节比对
  - `wasm_parity.mjs`：重建产物与仓库内产物、v2-alpha 旧 blob 的行为比对
  - `web_ui.test.mjs`：Web 端契约 + 用真实尺寸跑 worker 收发
  - `e2e_cli.test.mjs`：C++/Python 往返、两端产物一致、CLI 选项行为
  - `bench.mjs`：性能基线；`run_all.mjs`：一键跑全套
- **仓库体积工具**：`repo_bloat*.mjs` 系列（盘点/识别/导出/留档）与 `remote_bloat_check.mjs`
  （推送前检查远端大对象）。
- **构建与文档**：`Cpp/build.ps1`、`web/rs/README.md`、`tests/README.md`、`Python/README.md`、
  `package.json`（test/bench/build/serve 入口）、`LICENSE`（MIT）、`.github/workflows/ci.yml`。
- **Web 端**：`tests/serve_web.mjs`（正确设置 `application/wasm` 的本地静态服务器）。

### 修复

- **`web/src/worker.js` 内存泄漏**：`const gilbert` 遮蔽外层 `let gilbert`，导致 `finally` 中的
  释放是死代码；异常路径下 WASM 内存永不释放。现在成功/失败都保证 `free()`。
- **Web 端错误路径**：Worker 报错或返回数据异常时，UI 会永久停留在"处理中"且按钮禁用；
  现在统一走 `resetProcessingState()` 恢复。
- **C++ 整数溢出**：`int64_t total = width * height` 先按 `int` 相乘再提升，3 亿像素以上的图会溢出；
  现全程 `int64_t`。
- **C++ 写入不原子**：直接覆盖原文件，中途失败会留下半张图；改为"同目录临时文件 + 改名"，
  失败时回退为直接覆盖。
- **C++ 线程模型**：原来一个文件一个线程；改为固定大小线程池（默认取文件数与 CPU 核数的较小值）。
- **曲线正确性校验**：新增"双射"校验，曲线若重复覆盖或漏掉像素会当场报错，而不是静默丢数据。
- **有损格式提示**：`jpg/jpeg/webp` 压缩会改变像素、破坏可还原性，现在会打印明确警告。
- **Python 曲线实现**：删除了一条"生成 2^n 方阵曲线再按宽高过滤"的向量化捷径——
  它只是方形特例下与广义曲线相同，非方形上的点序并不一致（正是旧版无法与 C++/Web 互通的原因）。

### 不兼容变更

- **Python**：曲线算法更换，旧版（`bbw_tphx*.py`）加密的图片无法用当前版本解出；
  旧实现已归档到 `Python/legacy/`，需要时用旧脚本解密。
- **Web**：默认偏移量由 `round(φ × (总像素数 - 1))` 改为 `round(φ × 总像素数)`，
  与命令行一致。用**旧版 Web 的 `auto` 值**混淆过的图片，需要把偏移量手动 `±1` 才能用当前版本解出；
  显式填过数字的不受影响。
- **WASM 产物**：`web/src/wasm/` 下的 wasm 与 JS 胶水必须成对替换，不要与旧版混用。

### 工程与仓库

- 清理 `.git` 中 718.9MB 的不可达历史残留对象（早期 PyInstaller 流程里 `git add` 过
  `build/`、`*.exe`、`*.7z` 与测试大图，提交被改写后一直留在对象库）；
  对象已留档到忽略目录 `archive/2026-09-12-orphaned-objects/`，`.git` 728.5MB → 9.6MB。
- `.gitignore` 精确化：`devlog.md`、`js/`（算法的 Node.js 源头）、`tests/`、`Python/tests/`、
  `*.spec` 纳入版本控制；测试目录的产物规则移到 `tests/.gitignore`。
- 删除 `web/src/index.html.txt`、`web/src/worker.js.txt`（与源文件逐字节相同的重复副本）。
- 远端清理：只保留 `origin`，移除指向同一地址的重复别名。

## 历史版本（无变更日志时期）

- **v2.0.0-alpha**（2025-05-13）：Web 端改用 Rust → WebAssembly 做全像素操作，
  引入 Worker 与 `lp_crypt_wasm_core` 核心；整合 dev/beta/Release 多面板结构。
- **v1.3.0**（2025-04-20）：Web 端加入操作锁（修复处理中切换图片导致崩溃）、
  Unifont 字体、进度条与说明卡片。
- **v1.2.0**（2025-04-18）：Web 端拆出 `worker.js`，开始把像素计算移出主线程。
- **v1.0.0 / v1.1.0**（2025-04-15）：Web 端最初可用的混淆页面（前身为"小番茄"项目）。
- **C++ CLI v1.0.0 / v1.0.1**（2025-04-27 / 04-28）：命令行版建立，多线程处理、
  兼容 PNG/JPG/BMP/WebP/TIFF，v1.0.1 改进进度输出与线程上下文日志。
- **Python CLI v1.0 / v1.1 / v1.2**（2025-03-07 ~ 03-08）：纯 Python → OpenCV 加速 →
  NumPy 向量化，仅支持命令行运行与 PNG/JPG。
