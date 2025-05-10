# cli.py
import argparse
from algorithm import HilbertImageProcessor

def main():
    parser = argparse.ArgumentParser(
        description="基于希尔伯特曲线的图像加解密工具",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    
    parser.add_argument(
        "-i", "--input",
        required=True,
        help="输入图像路径（支持PNG/JPG格式）"
    )
    parser.add_argument(
        "-o", "--output",
        required=True,
        help="输出图像路径（支持PNG/JPG格式）"
    )
    parser.add_argument(
        "-m", "--mode",
        required=True,
        choices=["encrypt", "decrypt"],
        help="操作模式：encrypt（加密）或 decrypt（解密）"
    )
    parser.add_argument(
        "-g", "--golden-ratio",
        type=float,
        default=(5**0.5 - 1)/2,
        help="黄金分割比例参数（默认：0.618...）"
    )

    args = parser.parse_args()

    try:
        processor = HilbertImageProcessor(golden_ratio=args.golden_ratio)
        processor.process_image(args.input, args.output, args.mode)
        print(f"图片处理完成！输出文件已保存至：{args.output}")
    except Exception as e:
        print(f"处理过程中发生错误：{str(e)}")
        exit(1)

if __name__ == "__main__":
    main()