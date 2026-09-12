# Copyright [2025] <鲍炳文>
"""Python 端单元测试。

运行（pytest 可选，未安装时也能直接执行）：
    python tests/test_algorithm.py          # 内置执行器
    python -m pytest tests -q               # 装了 pytest 就用 pytest
"""

from __future__ import annotations

import os
import sys
import traceback

import numpy as np

# Windows 控制台默认可能是 GBK，先切到 UTF-8 再输出 ✓/✗，避免 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, OSError):  # pragma: no cover - 老版本解释器/受限环境
    pass

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

import gilbert_core  # noqa: E402
from gilbert_core import (  # noqa: E402
    GOLDEN_RATIO,
    HilbertImageProcessor,
    default_offset,
    gilbert_curve_offsets,
)


class raises:
    """最小的 pytest.raises 替身，避免为了跑单测强依赖 pytest"""

    def __init__(self, exc_type):
        self.exc_type = exc_type

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            raise AssertionError(f"期望抛出 {self.exc_type.__name__}，但没有异常")
        return issubclass(exc_type, self.exc_type)


def test_curve_is_permutation():
    """曲线必须覆盖矩形里每个像素恰好一次。"""
    for width, height in [(1, 1), (1, 9), (9, 1), (3, 5), (5, 3), (16, 16), (37, 100), (100, 37)]:
        offsets = gilbert_curve_offsets(width, height)
        assert offsets.size == width * height
        assert sorted(int(o) for o in offsets) == list(range(width * height))


def test_curve_matches_cpp_reference_vectors():
    """与 C++/Rust 的已知结果对齐（2x2 曲线顺序为 (0,0)->(0,1)->(1,1)->(1,0)）。"""
    assert [int(o) for o in gilbert_curve_offsets(2, 2)] == [0, 2, 3, 1]
    assert [int(o) for o in gilbert_curve_offsets(1, 1)] == [0]
    assert [int(o) for o in gilbert_curve_offsets(1, 3)] == [0, 1, 2]


def test_curve_non_square_order():
    """非方形矩形的点序必须与广义曲线一致（不能退化成"方阵曲线+过滤"）。

    100x37 与 37x100 互为转置，是旧实现与 C++ 分道扬镳的典型尺寸：
    把 2^n 方阵希尔伯特曲线按宽高过滤后取前 w*h 个点，得到的顺序与广义
    希尔伯特曲线不同，这正是旧版 Python 无法与 C++/Web 互通的原因。
    这里用从 C++/WASM 交叉验证过的具体点序把它钉住。
    """
    assert [int(o) for o in gilbert_curve_offsets(100, 37)][:6] == [0, 100, 101, 1, 2, 102]
    assert [int(o) for o in gilbert_curve_offsets(37, 100)][:6] == [0, 1, 38, 37, 74, 75]
    assert [int(o) for o in gilbert_curve_offsets(3, 5)][:4] == [0, 1, 2, 5]
    assert [int(o) for o in gilbert_curve_offsets(5, 3)][:4] == [0, 5, 10, 11]


def test_curve_is_bijection_large():
    """大尺寸矩形也必须每个像素恰好覆盖一次。"""
    for width, height in [(100, 37), (37, 100), (320, 200)]:
        offsets = gilbert_curve_offsets(width, height)
        assert offsets.size == width * height
        assert len(np.unique(offsets)) == width * height
        assert offsets.min() == 0 and offsets.max() == width * height - 1


def test_round_trip():
    for width, height in [(1, 1), (1, 9), (3, 5), (16, 16), (37, 100)]:
        rng = np.random.default_rng(width * 31 + height)
        pixels = rng.integers(0, 256, (height, width, 4), dtype=np.uint8)
        processor = HilbertImageProcessor()

        encrypted = processor.permute(pixels, "encrypt")
        if processor.resolve_offset(width * height) != 0:
            assert not np.array_equal(encrypted, pixels), "非零偏移下混淆结果不应等于原图"

        decrypted = processor.permute(encrypted, "decrypt")
        assert np.array_equal(decrypted, pixels)


def test_default_offset_matches_other_languages():
    """偏移量公式：round(黄金分割比 x 总像素数)。"""
    assert default_offset(1382 * 924) == round(GOLDEN_RATIO * 1382 * 924)
    assert default_offset(1) == round(GOLDEN_RATIO)


def test_explicit_offset_and_zero():
    """显式偏移量优先于比例；偏移量为 0 时是恒等变换。"""
    rng = np.random.default_rng(7)
    pixels = rng.integers(0, 256, (5, 7, 4), dtype=np.uint8)

    identity = HilbertImageProcessor(offset=0)
    assert np.array_equal(identity.permute(pixels, "encrypt"), pixels)

    # 负偏移量按模处理，等价于对应正偏移量
    a = HilbertImageProcessor(offset=-3).permute(pixels, "encrypt")
    b = HilbertImageProcessor(offset=5 * 7 - 3).permute(pixels, "encrypt")
    assert np.array_equal(a, b)


def test_offset_normalized_modulo_total():
    total = 5 * 7
    processor = HilbertImageProcessor(offset=total + 2)
    assert processor.resolve_offset(total) == 2


def test_invalid_mode_raises():
    pixels = np.zeros((2, 2, 4), dtype=np.uint8)
    with raises(ValueError):
        HilbertImageProcessor().permute(pixels, "nope")


def test_permute_bytes_rejects_wrong_length():
    with raises(ValueError):
        HilbertImageProcessor().permute_bytes(b"\x00" * 10, 2, 2, "encrypt")


def main() -> int:
    tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith("test_") and callable(fn)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
        except Exception:  # noqa: BLE001 - 测试执行器需要把任何失败都记为失败
            failed += 1
            print(f"✗ {name}")
            traceback.print_exc()
        else:
            print(f"✓ {name}")
    print(f"\n共 {len(tests)} 项，失败 {failed} 项")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
