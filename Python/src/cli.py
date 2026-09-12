# Copyright [2025] <鲍炳文>
"""小土豆图片混淆 —— Python 命令行入口。

用法：
    python -m src.cli -i <输入> -o <输出> -m encrypt|decrypt [-g 0.618...] [--offset N]
    python src/cli.py --folder <文件夹> -m encrypt      # 批量原地覆盖
"""

from __future__ import annotations

import argparse
import os
import sys
import time

if __package__ in (None, ""):
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gilbert_core import GOLDEN_RATIO, HilbertImageProcessor  # noqa: E402

# 控制台编码兜底：Windows 上 Python 默认按本地代码页输出（runner 是 cp1252，中文系统是 cp936），
# 这些编码表示不了本程序的输出字符，会直接抛 UnicodeEncodeError 把 CLI 打断。
# 之前只在中文 Windows 上开发，GBK 恰好能编中文，问题一直没暴露，直到在 CI 上炸掉。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):  # pragma: no cover - 老解释器或被重定向的特殊流
        pass

SUPPORTED_EXTS = (".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff", ".tif")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="小土豆图片混淆（Python 版，与 C++/Web 端互通）",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("-i", "--input", help="输入图像路径")
    parser.add_argument("-o", "--output", help="输出图像路径（--folder 模式下可省略）")
    parser.add_argument(
        "-m",
        "--mode",
        required=True,
        choices=["encrypt", "decrypt"],
        help="encrypt（混淆）或 decrypt（解混淆）",
    )
    parser.add_argument(
        "-g",
        "--golden-ratio",
        type=float,
        default=GOLDEN_RATIO,
        help="偏移量比例（默认黄金分割率）",
    )
    parser.add_argument(
        "--offset",
        type=int,
        default=None,
        help="显式指定偏移量（像素数）；指定后忽略 --golden-ratio",
    )
    parser.add_argument(
        "--folder",
        metavar="目录",
        help="批量处理目录内所有图片（原地覆盖，请先备份）",
    )
    return parser


def process_one(processor: HilbertImageProcessor, src: str, dst: str, mode: str) -> bool:
    start = time.time()
    try:
        processor.process_image(src, dst, mode)
    except Exception as exc:  # noqa: BLE001 - CLI 需要把任何失败都反馈给用户
        print(f"处理失败 {src}: {exc}", file=sys.stderr)
        return False
    label = "混淆" if mode == "encrypt" else "解混淆"
    print(f"[{label}] {src} -> {dst} ({time.time() - start:.2f}秒)")
    return True


def run_folder(processor: HilbertImageProcessor, folder: str, mode: str) -> int:
    if not os.path.isdir(folder):
        print(f"不是文件夹: {folder}", file=sys.stderr)
        return 2
    files = sorted(f for f in os.listdir(folder) if f.lower().endswith(SUPPORTED_EXTS))
    if not files:
        print(f"文件夹内没有支持的图片: {os.path.abspath(folder)}", file=sys.stderr)
        return 2

    print(f"开始处理 {len(files)} 个文件...（原地覆盖，请先备份）")
    start = time.time()
    ok = 0
    for i, name in enumerate(files, start=1):
        path = os.path.join(folder, name)
        print(f"[{i}/{len(files)}] {name}")
        if process_one(processor, path, path, mode):
            ok += 1
    print(f"完成：成功 {ok}/{len(files)}，总耗时 {time.time() - start:.2f}秒")
    return 0 if ok == len(files) else 1


def main() -> int:
    args = build_parser().parse_args()
    processor = HilbertImageProcessor(golden_ratio=args.golden_ratio, offset=args.offset)

    if args.folder:
        return run_folder(processor, args.folder, args.mode)

    if not args.input or not args.output:
        print("错误：需要同时指定 -i/--input 与 -o/--output（或使用 --folder）", file=sys.stderr)
        return 2
    return 0 if process_one(processor, args.input, args.output, args.mode) else 1


if __name__ == "__main__":
    sys.exit(main())
