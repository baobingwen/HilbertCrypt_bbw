# Copyright [2025] <鲍炳文>
"""小土豆图片混淆 —— Python 参考实现（与 C++/Rust(WASM) 逐字节等价）。

与旧版 Python 实现（`bbw_tphx*.py`）的关键区别：

1. 曲线算法换成**广义希尔伯特曲线**，与 C++/Rust 完全同一条曲线。
   旧版用的是"2^n 方阵希尔伯特曲线 + 按宽高过滤"，与其它语言不兼容。
2. 偏移量固定为 ``round((sqrt(5)-1)/2 * 总像素数)``，与 C++/Web 同公式。
3. 像素重排固定按 RGBA（4 字节/像素）处理，与浏览器端 Canvas 一致，
   因此 Python 混淆的结果可以被 C++/Web 解混淆，反之亦然。
"""

from __future__ import annotations

import math
import sys
from typing import List, Sequence, Tuple

import numpy as np

BYTES_PER_PIXEL = 4

# 曲线生成为递归实现，超大图时递归深度与 log2(边长) 同阶；
# 这里放宽上限，避免异常高的图片触发 RecursionError。
if sys.getrecursionlimit() < 100000:
    sys.setrecursionlimit(100000)

# 黄金分割比 (sqrt(5)-1)/2，全项目统一常量
GOLDEN_RATIO = (math.sqrt(5) - 1) / 2


def _generate_2d(x: int, y: int, ax: int, ay: int, bx: int, by: int, out: List[Tuple[int, int]]) -> None:
    """递归生成广义希尔伯特曲线，与 C++/Rust 的实现一一对应。"""
    w = abs(ax) + abs(ay)
    h = abs(bx) + abs(by)

    dax = 0 if ax == 0 else (1 if ax > 0 else -1)
    day = 0 if ay == 0 else (1 if ay > 0 else -1)
    dbx = 0 if bx == 0 else (1 if bx > 0 else -1)
    dby = 0 if by == 0 else (1 if by > 0 else -1)

    if h == 1:
        for _ in range(w):
            out.append((x, y))
            x += dax
            y += day
        return

    if w == 1:
        for _ in range(h):
            out.append((x, y))
            x += dbx
            y += dby
        return

    # 注意：C++/Rust 的整数除法是"向零取整"，Python 的 int() 同样向零取整
    ax2, ay2, bx2, by2 = int(ax / 2), int(ay / 2), int(bx / 2), int(by / 2)

    w2 = abs(ax2) + abs(ay2)
    h2 = abs(bx2) + abs(by2)

    if 2 * w > 3 * h:
        if (w2 % 2) and (w > 2):
            ax2 += dax
            ay2 += day
        _generate_2d(x, y, ax2, ay2, bx, by, out)
        _generate_2d(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by, out)
    else:
        if (h2 % 2) and (h > 2):
            bx2 += dbx
            by2 += dby
        _generate_2d(x, y, bx2, by2, ax2, ay2, out)
        _generate_2d(x + bx2, y + by2, ax, ay, bx - bx2, by - by2, out)
        _generate_2d(
            x + (ax - dax) + (bx2 - dbx),
            y + (ay - day) + (by2 - dby),
            -bx2,
            -by2,
            -(ax - ax2),
            -(ay - ay2),
            out,
        )


def _successor_offsets(coords: np.ndarray, width: int) -> np.ndarray:
    """由曲线坐标算出"曲线顺序 -> 线性像素索引"的映射表。

    即 ``offsets[k] = y * width + x``，等价于 WASM 的 ``get_offsets()``。
    """
    return coords[:, 1].astype(np.int64) * width + coords[:, 0].astype(np.int64)


def gilbert_curve_offsets(width: int, height: int) -> np.ndarray:
    """曲线顺序 -> 线性像素索引（长度 width*height 的 int64 数组）。

    与 C++/Rust 使用同一份递归算法，逐点对应。128 万像素的图大约 1.5 秒，
    相对整条处理链路（读图 + 重排 + 存图）占比很小，因此不做额外优化。

    注意：曾经尝试过"生成 2^n 方阵希尔伯特曲线再按宽高过滤"的向量化捷径，
    但那条曲线只是**方形特例**下与广义曲线相同，非方形上的点序并不一致
    （这正是旧版 Python 与 C++/Web 不能互通的原因）。已删除该捷径，
    正确性由 tests/test_algorithm.py 与 tests/cross_language.test.mjs 保证。
    """
    if width <= 0 or height <= 0:
        raise ValueError(f"Invalid dimensions: width={width}, height={height}")

    total = width * height
    out: List[Tuple[int, int]] = []
    if width >= height:
        _generate_2d(0, 0, width, 0, 0, height, out)
    else:
        _generate_2d(0, 0, 0, height, width, 0, out)
    if len(out) != total:
        raise ValueError(f"曲线长度 {len(out)} 与像素数 {total} 不符")
    coords = np.asarray(out, dtype=np.int64)
    return _successor_offsets(coords, width)


def default_offset(total_pixels: int) -> int:
    """黄金分割比默认偏移量（与 C++/Web 同公式）。"""
    return int(round(GOLDEN_RATIO * total_pixels))


class HilbertImageProcessor:
    """按曲线做像素重排的图像处理器。

    与旧版接口保持兼容：``process_image(input_path, output_path, mode)``。
    """

    def __init__(self, golden_ratio: float = GOLDEN_RATIO, offset: int | None = None):
        """
        :param golden_ratio: 偏移量比例，默认黄金分割率
        :param offset: 显式指定偏移量（像素数），优先于 golden_ratio
        """
        self.golden_ratio = golden_ratio
        self.offset = offset

    # ------------------------------------------------------------ 核心算法

    def resolve_offset(self, total_pixels: int) -> int:
        """计算本图实际使用的偏移量，并归一化到 [0, total)。"""
        if self.offset is not None:
            value = int(self.offset)
        else:
            value = int(round(self.golden_ratio * total_pixels))
        return value % total_pixels

    def permute(self, pixels: np.ndarray, mode: str) -> np.ndarray:
        """对 (H, W, C) 的 uint8 数组做像素重排。

        :param mode: 'encrypt' 或 'decrypt'
        """
        if mode not in ("encrypt", "decrypt"):
            raise ValueError(f"未知模式: {mode}")

        height, width = pixels.shape[:2]
        total = width * height
        curve = gilbert_curve_offsets(width, height)
        offset = self.resolve_offset(total)

        # 加密：dst[(i + offset) % total] = src[i]
        # 解密：dst[i] = src[(i + offset) % total]
        src_order = np.arange(total, dtype=np.int64)
        dst_order = (src_order + offset) % total
        if mode == "encrypt":
            src_index, dst_index = src_order, dst_order
        else:
            src_index, dst_index = dst_order, src_order

        flat = pixels.reshape(total, -1)
        out = np.empty_like(flat)
        out[curve[dst_index]] = flat[curve[src_index]]
        return out.reshape(pixels.shape)

    def permute_bytes(self, data: bytes, width: int, height: int, mode: str) -> bytes:
        """对原始 RGBA 字节流做重排（与 C++/WASM 的缓冲区语义一致）。"""
        expected = width * height * BYTES_PER_PIXEL
        if len(data) != expected:
            raise ValueError(f"缓冲区长度 {len(data)} 与 {width}x{height} 不符")
        arr = np.frombuffer(data, dtype=np.uint8).reshape(height, width, BYTES_PER_PIXEL)
        return self.permute(arr, mode).tobytes()

    # ------------------------------------------------------------ 文件流程

    def process_image(self, input_path: str, output_path: str, mode: str) -> None:
        """读取图片 -> 重排 -> 写回。统一按 RGBA 处理，保证跨语言兼容。"""
        from PIL import Image

        with Image.open(input_path) as img:
            rgba = img.convert("RGBA")
            pixels = np.array(rgba, dtype=np.uint8)

        processed = self.permute(pixels, mode)

        out_img = Image.fromarray(processed, mode="RGBA")
        if output_path.lower().endswith((".jpg", ".jpeg")):
            out_img = out_img.convert("RGB")
        out_img.save(output_path)


# ---------------------------------------------------------------- 工具函数

def curve_points(width: int, height: int) -> Sequence[Tuple[int, int]]:
    """返回曲线上每个点的 (x, y)，主要给测试用。"""
    offsets = gilbert_curve_offsets(width, height)
    return [(int(o % width), int(o // width)) for o in offsets]
