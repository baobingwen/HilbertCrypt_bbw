# 小土豆图片混淆 · Python 端

## 当前实现（推荐）

与 C++ / Web(WASM) **同一条曲线、同一个偏移量公式**，三端产物可以互相解混淆。

```
python -m src.cli -i 输入.png -o 输出.png -m encrypt
python -m src.cli -i 输入.png -o 输出.png -m decrypt
python -m src.cli --folder ./files -m encrypt      # 批量（原地覆盖，先备份）
```

可选参数：`--offset N`（显式偏移量，与 Web 端"偏移参数"输入框同义）、
`-g/--golden-ratio`（自定义比例，默认 0.618…）。

环境（`HilbertCrypt_Env`）：

```
python==3.10
numpy>=2
pillow>=11
opencv-python-headless   # 仅 tests 里的对照脚本需要，主程序不依赖
```

## 单元测试

```
python tests/test_algorithm.py        # 内置执行器，无需 pytest
python -m pytest tests -q             # 装了 pytest 也可以
```

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `src/gilbert_core.py` | **生产实现**：广义希尔伯特曲线 + 像素重排 |
| `src/cli.py` | 命令行入口 |
| `src/gilbert_compat.py` | 跨语言等价测试的 stdin/stdout 通路（算法仍在 `gilbert_core`） |
| `src/algorithm.py` | 兼容垫片，导入即提示已废弃 |
| `tests/test_algorithm.py` | 单元测试（曲线双射、点序、往返可逆、偏移量归一化） |
| `legacy/` | 早期实现存档（**算法不兼容**，仅用于解旧版加密的图） |

## 与旧版的关系

早期版本（`bbw_tphx*.py`，已归档到 `legacy/`）用的是
"2^n 方阵希尔伯特曲线 + 按宽高过滤"，与 C++/Web 的广义希尔伯特曲线不是同一条曲线，
因此旧版的加密结果**无法**用当前任何版本解出，反之亦然。
旧版加密的图片只能继续用 `legacy/` 里的脚本解密，详见 `legacy/README.md`。
