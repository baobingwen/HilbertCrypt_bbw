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

## 仓库体积排查（只读工具）

`.git` 里可能残留"曾经 `git add` 过、但从未进入提交"的大对象。下面几个脚本用来定位它们：

| 脚本 | 作用 |
| --- | --- |
| `repo_bloat.mjs` | 概览：`.git` 实际占用、可达对象大小、按目录/扩展名分布 |
| `repo_bloat_unreachable.mjs` | 列出所有**不可达**对象（含 pack 与松散）并按大小排序 |
| `repo_bloat_identify.mjs` | 按魔数判断类型，并用 `git hash-object` 反查工作区里的同名文件，认领"旧版本残留" |
| `repo_bloat_dimensions.mjs` | 按图像尺寸（PNG IHDR / JPEG SOF）认领无法按内容匹配的历史图片 |
| `repo_bloat_export.mjs` | 把只存在于 `.git` 里的图片导出到 `tests/out/unreachable/` 并生成 `index.html` 供人工确认 |
| `repo_bloat_archive.mjs` | 把**全部**不可达对象导出到忽略目录留档（逐个用 `git hash-object` 复核），`--gc` 时在校验全过后执行清理 |

清理（不可逆，会永久删除不可达对象）：

```bash
node tests/repo_bloat_archive.mjs --gc     # 推荐：先留档、校验，再清理
git gc --prune=now                         # 或者手动清理
```

2026-09-12 已执行过一次：`.git` 从 728.5MB 降至 9.6MB（释放 718.9MB），
导出的 89 个对象（726.6MB）留档在 `archive/2026-09-12-orphaned-objects/`（该目录被忽略），
清单见其中的 `MANIFEST.md`。

## 产物目录

`tests/out/` 是运行期产物（沙箱目录、基准图、临时 fixture、体积排查报告），已被 `.gitignore` 忽略。
