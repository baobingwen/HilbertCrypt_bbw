# 历史版本（已归档，不再维护）

这里的脚本是 Python 版的早期实现，**算法与当前的 C++ / Web / `Python/src` 不兼容**，
互相之间也无法解混淆，仅作存档：

| 文件 | 对应版本 | 说明 |
| --- | --- | --- |
| `bbw_tphx.py` | v1.0 | 纯 Python 循环生成 2^n 希尔伯特曲线，逐像素循环重排 |
| `bbw_tphx_with_opencv.py` | v1.1 | 用 OpenCV 读图 + NumPy 向量化，曲线仍是 2^n 方阵过滤 |

旧算法与现行算法的差异：

- 旧版：生成 `2^n × 2^n` 的**标准希尔伯特曲线**，再按 `x < width and y < height` 过滤取前 `width*height` 个点
- 现行：直接生成覆盖 `width × height` 矩形的**广义希尔伯特（Gilbert）曲线**，与 C++/Rust 完全同一条曲线

如果你手上有用旧版加密的图片，只能继续用旧版脚本解密（把文件放回 `files/` 后运行对应脚本）。

当前维护的 Python 实现见 `../src/`，命令行入口 `python -m src.cli`。
