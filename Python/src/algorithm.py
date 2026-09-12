# Copyright [2025] <鲍炳文>
"""已废弃的模块名，保留仅为兼容旧调用方。

真正的实现已经搬到 `gilbert_core`，并且**算法发生了不兼容变更**：

- 旧版（本文件的历史实现）：2^n 方阵希尔伯特曲线 + 按宽高过滤，只与旧版 Python 互通
- 新版（`gilbert_core`）：广义希尔伯特曲线，与 C++ / Rust(WASM) 逐字节等价

请改用：

    python -m src.cli -i 输入 -o 输出 -m encrypt|decrypt
"""

from __future__ import annotations

import os
import sys
import warnings

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gilbert_core import GOLDEN_RATIO, HilbertImageProcessor, default_offset  # noqa: E402

__all__ = ["HilbertImageProcessor", "GOLDEN_RATIO", "default_offset"]

warnings.warn(
    "Python/src/algorithm.py 已废弃：请改用 gilbert_core.HilbertImageProcessor，"
    "旧版曲线与 C++/Web 不兼容。",
    DeprecationWarning,
    stacklevel=2,
)
