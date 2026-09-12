# 测试说明

三端（C++ / Web-WASM / Python）共用**同一条广义希尔伯特曲线**和**同一个偏移量公式**，
这里的测试就是为了把这件事钉死：任何一端偷偷改了算法，都会在这里红掉。

## 一键运行

```bash
node tests/run_all.mjs          # 全部
node tests/run_all.mjs --quick  # 跳过耗时的端到端大图用例
```

需要：
- Node ≥ 20
- C++ 可执行文件：`powershell -File Cpp/build.ps1`（缺失时相关用例自动跳过）
- Python 3.10（`HilbertCrypt_Env` 或任意带 numpy/Pillow 的解释器），可用 `PY_EXE` 环境变量指定：
  `$env:PY_EXE = "D:\Bingwen_Bao\anaconda3\envs\HilbertCrypt_Env\python.exe"`

## 各测试文件

| 文件 | 验证内容 |
| --- | --- |
| `gilbert_reference.mjs` | 纯 JS 参考实现（曲线 + 置换），是其它所有测试的"标准答案" |
| `cross_language.test.mjs` | **跨语言等价性**：Node 参考 / Rust-WASM / C++ / Python 四端，曲线坐标、像素置换、解密往返逐字节一致 |
| `wasm_parity.mjs` | 把 `web/rs` 重新构建出的 wasm 与仓库里的旧 blob 逐项比对（导出表、曲线、像素输出、边界行为） |
| `web_ui.test.mjs` | Web 端契约：worker 真的调用 WASM、`index.html` 的偏移量公式与命令行一致、错误路径会恢复 UI；并用**未改动的 `worker.js`** 跑一遍真实尺寸（1382×924）的收发 |
| `e2e_cli.test.mjs` | 端到端：C++ 与 Python 在 PNG/灰度/BMP/TIFF/WebP 上的往返、**两端混淆结果像素一致**、`--offset/--jobs` 等选项行为、有损格式必须报警告 |
| `bench.mjs` | 性能基线（C++ 原地 vs 另开缓冲区、WASM 各阶段耗时、Python） |
| `png.mjs` | 测试用的极简 PNG 解码器：按**像素**比较，不受编码器滤波策略影响 |
| `serve_web.mjs` | 本地静态服务器（正确设置 `application/wasm`），用于浏览器手工验证 |

## 产物目录

`tests/out/` 是运行期产物（沙箱目录、基准图、临时 fixture），已被 `.gitignore` 忽略。
