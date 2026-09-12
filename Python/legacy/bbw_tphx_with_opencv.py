import argparse
import os
import math
import time
import numpy as np
import cv2  # 使用OpenCV加速图像处理
from functools import lru_cache

# ---------- 全局常量 ----------
GOLDEN_RATIO = (math.sqrt(5) - 1) / 2

# ---------- 优化后的曲线生成函数 ----------
@lru_cache(maxsize=10)
def hilbert_curve_generator(n):
    """
    使用 NumPy 向量化加速生成 n 阶希尔伯特曲线，每个 d ∈ [0, 2^(2n)-1] 转换到 (x, y)。
    返回 shape=(size*size,2) 的数组，其中 size=2^n。
    """
    size = 1 << n              # 2^n
    total = size * size        # 2^(2n)
    # 创建一系列从 0 到 total-1 的整数，这些值将映射到希尔伯特曲线上的 (x,y)。
    D = np.arange(total, dtype=np.uint32)
    
    # 初始化 x, y 均为 0，稍后会逐步在每个位平面上进行旋转和偏移。
    X = np.zeros_like(D)
    Y = np.zeros_like(D)

    # 逐层（相当于 n 次迭代）解码，sPow 代表当前处理第几位平面
    for sPow in range(n):
        s = 1 << sPow           # 当前层对应的步长
        # 取出本层要处理的两位 (rx, ry)
        rx = (D >> 1) & 1
        ry = (D ^ rx) & 1

        # 对应标准 Hilbert 算法中的旋转/翻转操作：
        # 当 ry=0 时可能需要翻转并交换 X、Y
        mask_ry_zero = (ry == 0)
        # 当 (rx=1 且 ry=0) 时需要先翻转 (X, Y) -> (s-1-X, s-1-Y)
        mask_flip = (rx == 1) & mask_ry_zero

        # 在需要翻转的像素上执行翻转
        X[mask_flip] = s - 1 - X[mask_flip]
        Y[mask_flip] = s - 1 - Y[mask_flip]

        # 在 ry=0 的像素上执行 (X, Y) 交换
        idx_swap = np.where(mask_ry_zero)[0]
        X[idx_swap], Y[idx_swap] = Y[idx_swap], X[idx_swap].copy()

        # 最后按 (rx, ry) 进行坐标平移
        X += s * rx
        Y += s * ry

        # 当前层处理完后，我们要“丢弃”这两位信息，将 D 右移2位以处理下一位平面
        D >>= 2

    # 最终将 X, Y 堆叠为 shape=(total,2) 的二维数组返回
    return np.column_stack((X, Y))

def generate_mapping(width, height):
    """
    生成与给定图像宽高匹配的希尔伯特曲线映射表，
    并返回包含 (x, y) 坐标对的二维 NumPy 数组，长度为 width*height。
    """
    max_dim = max(width, height)
    n = math.ceil(math.log2(max_dim)) if max_dim > 0 else 1

    # 记录生成希尔伯特曲线的时间
    start_time = time.time()
    # hilbert_curve_generator(n) 返回的结果是 shape=(2^(2n), 2) 的 NumPy 数组
    curve = hilbert_curve_generator(n)
    end_time = time.time()
    print(f"生成希尔伯特曲线耗时: {end_time - start_time:.2f}秒")

    # 利用 NumPy 布尔索引加速，选取 (x < width, y < height) 的坐标
    start_time = time.time()
    mask = (curve[:, 0] < width) & (curve[:, 1] < height)
    # 生成符合条件的坐标
    filtered = curve[mask]
    # 截取前 width*height 个坐标点 (若 filtered 不足，会返回实际可用的坐标)
    valid_curve = filtered[: (width * height)]
    end_time = time.time()
    print(f"生成映射表耗时: {end_time - start_time:.2f}秒")

    # 返回 NumPy 数组，或者如需要 Python 列表，可再执行 valid_curve.tolist()
    return valid_curve

def encrypt_image(input_path, output_path):
    """使用OpenCV和内存视图加速 - 希尔伯特混淆加密"""
    try:
        img = cv2.imread(input_path, cv2.IMREAD_UNCHANGED)
        if img is None:
            raise FileNotFoundError("输入文件不存在或无法读取")

        # 转换为RGBA格式
        if img.shape[2] == 3:
            img = cv2.cvtColor(img, cv2.COLOR_BGR2RGBA)
        else:
            img = cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA)
            
        height, width = img.shape[:2]
        total = width * height
        
        # 生成映射表
        curve = generate_mapping(width, height)
        curve_array = np.array(curve, dtype=np.uint32).reshape(-1, 2)
        
        # 内存视图优化
        pixels = np.ascontiguousarray(img)
        new_pixels = np.zeros_like(pixels)
        
        # 向量化操作
        offset = int(GOLDEN_RATIO * total)
        new_inds = (np.arange(total) + offset) % total
        
        # 使用高级索引一次性完成映射
        new_pixels[curve_array[new_inds, 1], curve_array[new_inds, 0]] = \
            pixels[curve_array[:, 1], curve_array[:, 0]]
        
        # OpenCV保存
        if output_path.lower().endswith(('.jpg', '.jpeg')):
            cv2.imwrite(
                output_path,
                cv2.cvtColor(new_pixels, cv2.COLOR_RGBA2BGR),
                [cv2.IMWRITE_JPEG_QUALITY, 95]
            )
        else:
            cv2.imwrite(output_path, new_pixels)

    except Exception as e:
        print(f"加密出现错误: {input_path} - {str(e)}")

def decrypt_image(input_path, output_path):
    """使用OpenCV和内存视图+高级索引完成希尔伯特解密"""
    try:
        img = cv2.imread(input_path, cv2.IMREAD_UNCHANGED)
        if img is None:
            raise FileNotFoundError("图像文件未找到或无法读取")

        # 转为RGBA通道以统一处理
        if img.shape[2] == 3:
            img = cv2.cvtColor(img, cv2.COLOR_BGR2RGBA)
        else:
            img = cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA)

        height, width = img.shape[:2]
        total = width * height

        # 生成曲线映射表
        curve = generate_mapping(width, height)
        curve_array = np.array(curve, dtype=np.uint32).reshape(-1, 2)

        # 原图像像素
        pixels = np.ascontiguousarray(img)
        new_pixels = np.zeros_like(pixels)

        # 计算偏移
        offset = int(GOLDEN_RATIO * total)
        # old_inds: 解密后每个像素应放的索引
        old_inds = np.arange(total)
        # encrypted_inds: 实际在加密图中对应的索引
        encrypted_inds = (old_inds + offset) % total

        # 利用高级索引完成解密
        new_pixels[curve_array[old_inds, 1], curve_array[old_inds, 0]] = \
            pixels[curve_array[encrypted_inds, 1], curve_array[encrypted_inds, 0]]

        # 根据后缀判断是否要转换为BGR并设置JPEG质量
        if output_path.lower().endswith(('.jpg', '.jpeg')):
            out_bgr = cv2.cvtColor(new_pixels, cv2.COLOR_RGBA2BGR)
            cv2.imwrite(output_path, out_bgr, [cv2.IMWRITE_JPEG_QUALITY, 95])
        else:
            cv2.imwrite(output_path, new_pixels)

    except Exception as e:
        print(f"解密时出现错误: {input_path} - {str(e)}")

def main():
    """
    主函数，用于解析命令行参数，执行加密/解密操作(单线程循环处理)
    """
    print("程序启动... (注意：本程序将直接覆盖原文件)")
    parser = argparse.ArgumentParser(description="希尔伯特混淆/解混淆 CLI (覆盖原图, 单线程)")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("-e", "--encrypt", action="store_true", help="加密文件夹内图像")
    group.add_argument("-d", "--decrypt", action="store_true", help="解密文件夹内图像")
    args = parser.parse_args()

    target_folder = "files"
    if not os.path.exists(target_folder):
        os.makedirs(target_folder, exist_ok=True)
        print(f"处理文件夹不存在，已自动创建: {os.path.abspath(target_folder)}")

    start_time = time.time()
    files = [f for f in os.listdir(target_folder) if f.lower().endswith((".png", ".jpg", ".jpeg"))]

    if not files:
        print(f"文件夹内没有图像，请放入文件至 {os.path.abspath(target_folder)} 文件夹内")
        return

    print(f"即将处理 {len(files)} 个文件...")

    for i, f in enumerate(files, start=1):
        print(f"[{i}/{len(files)}] 正在处理 -> {f}")
        path = os.path.join(target_folder, f)
        if args.encrypt:
            encrypt_image(path, path)
            print(f"[{i}/{len(files)}] 已完成加密: {f}")
        else:
            decrypt_image(path, path)
            print(f"[{i}/{len(files)}] 已完成解密: {f}")

    end_time = time.time()
    print(f"全部处理完成，总耗时: {end_time - start_time:.2f}秒")

if __name__ == '__main__':
    main()