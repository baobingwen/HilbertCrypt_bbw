# 后续开发计划 / Roadmap

本文件记录 v2.1.0 之后计划要做的事。**每次开工前先看这里**，做完一项就把对应小节改成"已完成"
或直接删除；与代码强相关的细节写在各自目录的 README 里，这里只保留决策、任务与验收标准。

状态标记：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成

已完成（详见 [`CHANGELOG.md`](CHANGELOG.md)）：

- [x] 三端算法统一（C++ / Rust-WASM / Python 同曲线、同偏移量公式、同 RGBA 语义）
- [x] Web/WASM 核心源码化，产物可复现（`web/rs`，wasm-bindgen 锁 `=0.2.100`，工具链锁 1.86.0）
- [x] 测试体系与 CI（`tests/`，`.github/workflows/ci.yml` 三个 job 全绿）
- [x] 许可证、变更日志、仓库瘦身（`.git` 728MB → 9.6MB，残留对象留档在 `archive/`）

---

## 方案 B：跨平台支持（让 C++ 端不再只在 Windows 上可用）

**为什么要做**：`Cpp/hilbert_encrypt.cpp` 依赖 `windows.h` / `psapi`，CI 也只能用 Windows runner
验证；这既是使用门槛，也是"只有一台机器验证过"的风险。

### B1. 隔离平台相关代码

- [ ] 新增 `Cpp/platform.h`，把平台差异收敛到几个小函数里：
  - `enable_utf8_console()` —— 现在直接调用 `SetConsoleOutputCP(CP_UTF8)`
  - `current_memory_mb()` —— 现在调用 `GetProcessMemoryInfo`（Linux 上可从 `/proc/self/statm` 读）
  - 日志前缀/换行等保持现状即可
- [ ] 用 `#ifdef _WIN32` 分支实现，非 Windows 走空实现/`/proc` 实现
- [ ] 确认 `CMakeLists.txt` 里 `-lpsapi` 只在 Windows 链接

**验收**：在 Ubuntu 上 `g++ -std=c++20 $(pkg-config --cflags --libs opencv4) hilbert_encrypt.cpp` 能编过，
并且 `--stdin-encrypt` 通路跑通（这条不依赖图像编解码）。

### B2. 构建脚本参数化

- [ ] `Cpp/build.ps1` 里写死的 `D:\msys64\...` 改成"自动探测 + 可覆盖"（已有 `-Gxx`/`-MingwRoot`
      参数，需要补自动探测 `pkg-config`/常见安装路径）
- [ ] 新增 `Cpp/build.sh`（Linux/macOS）：`pkg-config opencv4` 取 flags，产出 `Cpp/bin/hilbert_encrypt`
- [ ] README 补三平台构建说明

### B3. CI 覆盖三平台

- [ ] Windows job：改用 `build.ps1` 编译（现在是内联 g++ 命令），确保"文档路径 = CI 路径"
- [ ] 新增 `ubuntu-latest` / `macos-latest` 的 C++ job：`apt-get install libopencv-dev`（macOS 用
      `brew install opencv`）后跑 `node tests/e2e_cli.test.mjs`
- [ ] 顺带评估：`e2e` 里 TIFF 的像素比对在 Linux 上是否也会遇到 Pillow 崩溃（见 `tests/README.md`）

**验收**：三平台 CI 都能编译 C++ 并跑完端到端；README 的构建命令与 CI 完全一致。

---

## 方案 C：从"混淆"走向"真加密"（需要先定威胁模型）

**背景**：当前是无密钥的确定性置换——`offset = round(φ × 总像素数)` 由尺寸公开推导，
任何人拿到本工具都能还原，图像统计特征也仍在。**先想清楚要防谁**，再选路线：

| 威胁模型 | 目标 | 建议路线 |
| --- | --- | --- |
| 防"随手看到"（相册、文件管理器缩略图、截屏） | 人眼认不出 | 现状已够，不需要加密 |
| 防"爬虫/模型直接读取" | 机器难以识别 | 现状部分有效；加噪声/重采样会更稳（属另一种方案） |
| 防"定向破解"（对方有本工具） | 没有密钥就算不出来 | **必须上密钥**（C1 起） |
| 防"内容保密"（泄露即灾难） | 密码学强度 | 走 C2/C3，并请安全审计 |

### C1. 密钥模式（推荐先做，向后兼容）

- [ ] 密钥派生：`offset = KDF(passphrase, width, height) mod total`，KDF 用 PBKDF2/scrypt/Argon2
      （Python 用 `hashlib.scrypt`，Rust 用 `scrypt`/`argon2` crate 或 `wasm` 友好的实现）
- [ ] 曲线参数也纳入密钥：至少让**曲线起点/方向**随密钥变化，避免"曲线固定、只换 offset"
- [ ] 兼容策略：不带密钥时保持现有行为（`auto` 偏移量），带密钥时走新路径；
      CLI/CLI/Web 三端同时实现，测试里加"同密钥可互通、错密钥解不出"的用例
- [ ] 交互：CLI 加 `--passphrase`（或读环境变量/文件，避免出现在命令行历史），Web 端加输入框

**验收**：
- 三端用同一口令能互相解密；口令错一字节则解出的图与原文无关
- 无口令时代的旧图仍能按旧规则解出（不破坏兼容性）
- `tests/cross_language.test.mjs` 增加密钥分支（同/异口令）

**待决策**：口令派生用什么算法、是否需要 salt/版本号写进图片（PNG 的 `tEXt` 块可存参数元数据）。

### C2. 整图 AEAD 加密（可选，形态会变）

- [ ] 评估 AES-GCM / ChaCha20-Poly1305（Python `cryptography`，Rust `aes-gcm`/`chacha20poly1305`）
- [ ] 需要一个容器格式：原图尺寸 + 加密参数 + 密文（可自定义头，或直接输出 `.bin`）
- [ ] 明确代价：**加密后不再是图片**，不能被图片查看器打开，不能预览缩略图

**验收**：加解密可往返、篡改任意字节都能被认证失败检出。

**注意**：这条会让"图片混淆"这个使用场景消失，只有在威胁模型升级到"内容保密"时才做。

### C3. 稀疏像素加密（研究性）

- [ ] 只加密部分像素/系数，在"抗模型识别"与"保持图片外观"之间取平衡
- [ ] 明确指标：需要一套评估方法（如对常见分类模型的识别率下降幅度），否则没有验收标准

**验收**：待定（先做小规模实验，再决定是否产品化）。

---

## 其它候选（优先级低于 B/C）

- [ ] **Web 端体验**：单张图上限 4096×4096；进度条只有 0/100%；大图耗时主要在 WASM 置换
      （12MP 实测：建曲线 217ms + 置换 1073ms）。可做分块搬运优化，或多 Worker + `SharedArrayBuffer`
      （后者需要 COOP/COEP 响应头，GitHub Pages 不支持，得换部署方式）
- [ ] **线上 Pages 同步**：`https://baobingwen.github.io/tools/GilbertCrypt/test/` 目前仍是旧版
      （旧 `auto` 偏移量），新版 Web 是否替换由你决定（见 README 的兼容性说明）
- [ ] **Python 端性能**：曲线生成是纯 Python 递归（1.28MP 约 1.5s）；可评估用
      `numpy` 向量化或 C 扩展（注意：曾用过"方阵曲线+过滤"的向量化捷径，**点序与广义曲线不一致**，
      已删除，不要再犯）
- [ ] **发布物**：目前仓库不含 `*.exe`/`*.7z` 等二进制发布包（`Cpp/Release/` 里的 v1.0.x 是旧算法存档）。
      如需发布，建议走 GitHub Releases 而不是提交进仓库
- [ ] **历史残留字体**：`html/versions/v3-beta-3/unifont-all.ttf`（20.2MB）已在永久历史里，
      远端实际 clone 仅 9.4MB，**不建议**为此重写历史

---

## 下次开工的起手式

```powershell
git checkout main
git pull
pwsh -File Cpp/build.ps1          # 本机 C++ 产物（含运行时 DLL）
node tests/run_all.mjs            # 全套测试，改动前先确认基线是绿的
```

约定：

1. 改动算法或产物 → 必须过 `node tests/cross_language.test.mjs`（三端等价）与
   `node tests/wasm_parity.mjs`（与旧 blob 行为一致）；
2. 改动 `web/rs/src/lib.rs` → 必须在 Windows 上跑 `pwsh -File web/rs/build.ps1` 并提交产物；
3. 推送前跑 `node tests/remote_bloat_check.mjs`，确认没有大对象要上传；
4. 破坏性变更写进 [`CHANGELOG.md`](CHANGELOG.md)，开发过程记到 [`devlog.md`](devlog.md)。
