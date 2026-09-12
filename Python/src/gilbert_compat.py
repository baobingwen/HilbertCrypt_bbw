# Copyright [2025] <鲍炳文>
"""小土豆图片混淆 —— 跨语言等价测试的 Python 侧入口。

本文件只负责把 `gilbert_core`（生产实现）包装成"从 stdin 收任务、向 stdout 吐二进制"
的工具，供 `tests/cross_language.test.mjs` 调用。**算法本身全部在 gilbert_core 里**，
保证测试验证的就是线上代码。

任务格式（首行 JSON）：
    {"op":"curve","width":W,"height":H}
    {"op":"permute","width":W,"height":H,"offset":N,"encrypt":true}

permute 任务的像素数据紧跟在首行之后。
"""

from __future__ import annotations

import json
import os
import sys

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gilbert_core import (  # noqa: E402
    BYTES_PER_PIXEL,
    HilbertImageProcessor,
    gilbert_curve_offsets,
)

# 与 cli.py 同样的控制台编码兜底：非 UTF-8 控制台下输出中文/符号会抛 UnicodeEncodeError
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):  # pragma: no cover
        pass


def tool_main(argv) -> int:
    stdin = sys.stdin.buffer
    stdout = sys.stdout.buffer

    task = json.loads(stdin.readline().decode("utf-8"))
    op = task.get("op")
    width = int(task["width"])
    height = int(task["height"])

    if op == "curve":
        offsets = gilbert_curve_offsets(width, height)
        curve = [[int(o % width), int(o // width)] for o in offsets]
        stdout.write(json.dumps(curve, separators=(",", ":")).encode("utf-8"))
        return 0

    if op == "permute":
        expected = width * height * BYTES_PER_PIXEL
        data = stdin.read()
        if len(data) != expected:
            print(f"输入像素数据不足: 期望 {expected} 字节，收到 {len(data)} 字节", file=sys.stderr)
            return 2
        processor = HilbertImageProcessor(offset=int(task["offset"]))
        mode = "encrypt" if task["encrypt"] else "decrypt"
        stdout.write(processor.permute_bytes(data, width, height, mode))
        return 0

    print(f"未知操作: {op}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(tool_main(sys.argv[1:]))
