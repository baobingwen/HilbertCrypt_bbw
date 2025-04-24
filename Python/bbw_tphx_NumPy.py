# python
import argparse
import os
import math
import time
import numpy as np
from PIL import Image

def hilbert_curve_generator(n):
    """
    使用 NumPy 向量化加速生成 n 阶希尔伯特曲线，每个 d ∈ [0, 2^(2n)-1] 转换到 (x, y)。
    返回形如 (2^(2n), 2) 的数组，每行代表一个 (x, y) 坐标。
    """
    size = 1 << n            # 2^n
    total = size * size      # 2^(2n)
    D = np.arange(total, dtype=np.uint32)
    X = np.zeros_like(D)
    Y = np.zeros_like(D)

    # 每次处理 2 个 bit，逐层生成
    for sPow in range(n):
        s = 1 << sPow
        # 取出当前位平面的 rx, ry
        rx = (D >> 1) & 1
        ry = (D ^ rx) & 1

        mask_ry_zero = (ry == 0)
        mask_flip = (rx == 1) & mask_ry_zero

        # 在需要翻转的像素上执行翻转 (x, y) = (s-1-x, s-1-y)
        X[mask_flip] = s - 1 - X[mask_flip]
        Y[mask_flip] = s - 1 - Y[mask_flip]

        # 在 ry=0 的像素上执行 (x, y) 交换
        idx_swap = np.where(mask_ry_zero)[0]
        X[idx_swap], Y[idx_swap] = Y[idx_swap], X[idx_swap].copy()

        # 最后按 (rx, ry) 进行坐标平移
        X += s * rx
        Y += s * ry

        # 处理完这两位，右移 2，为下一层做准备
        D >>= 2

    # 返回 shape=(total,2) 的坐标数组
    return np.column_stack((X, Y))

def generate_mapping(width, height):
    """
    生成与给定 (width, height) 相匹配的希尔伯特映射表。
    返回长度为 width*height 的 (x, y) 列表或数组。
    """
    max_dim = max(width, height)
    n = math.ceil(math.log2(max_dim)) if max_dim > 0 else 1

    print("开始生成希尔伯特曲线...")
    start_time = time.time()
    curve = hilbert_curve_generator(n)  # shape=(2^(2n), 2)
    end_time = time.time()
    print(f"生成希尔伯特曲线耗时: {end_time - start_time:.2f}秒")

    print("开始筛选映射表...")
    start_time = time.time()
    # 用布尔掩码一键筛选 (x < width, y < height)
    mask = (curve[:, 0] < width) & (curve[:, 1] < height)
    filtered = curve[mask]
    # 截取前 width*height 个坐标
    valid_curve = filtered[: (width * height)]
    end_time = time.time()
    print(f"筛选映射表耗时: {end_time - start_time:.2f}秒")

    # 若后面要用 NumPy 索引，可直接 return valid_curve
    # 若喜欢 Python 列表，可用 valid_curve.tolist()
    return valid_curve

def save_image_auto_mode(pixels, output_path):
    """
    根据文件后缀判断是否需要将 RGBA 转换为 RGB，然后保存图像
    """
    img = Image.fromarray(pixels)
    ext = os.path.splitext(output_path)[1].lower()
    if ext in [".jpg", ".jpeg"]:
        if img.mode == "RGBA":
            img = img.convert("RGB")
    img.save(output_path)
    print(f"图像已保存至: {output_path}")

def encrypt_image(input_path, output_path):
    """
    使用 NumPy 高级索引，对图像执行希尔伯特混淆加密
    """
    try:
        img = Image.open(input_path).convert("RGBA")
    except FileNotFoundError:
        print("输入文件不存在:", input_path)
        return

    width, height = img.size
    pixels = np.array(img)  # shape=[height, width, 4]

    curve = generate_mapping(width, height)  # shape=(width*height, 2)
    curve_array = np.array(curve, dtype=np.int32)

    total = width * height
    golden_ratio = (math.sqrt(5) - 1) / 2
    offset = round(golden_ratio * total)

    old_inds = np.arange(total)
    new_inds = (old_inds + offset) % total

    # old_coords[i] = (old_x, old_y)
    # new_coords[i] = (new_x, new_y)
    old_coords = curve_array[old_inds]
    new_coords = curve_array[new_inds]

    new_pixels = np.zeros_like(pixels)
    # 注意: 数组访问顺序 new_pixels[y, x]
    new_pixels[new_coords[:, 1], new_coords[:, 0]] = pixels[old_coords[:, 1], old_coords[:, 0]]

    save_image_auto_mode(new_pixels, output_path)
    print(f"加密完成: {output_path}")

def decrypt_image(input_path, output_path):
    """
    使用 NumPy 高级索引，对图像执行希尔伯特混淆解密
    """
    try:
        img = Image.open(input_path).convert("RGBA")
    except FileNotFoundError:
        print("输入文件不存在:", input_path)
        return

    width, height = img.size
    pixels = np.array(img)  # shape=[height, width, 4]

    curve = generate_mapping(width, height)
    curve_array = np.array(curve, dtype=np.int32)

    total = width * height
    golden_ratio = (math.sqrt(5) - 1) / 2
    offset = round(golden_ratio * total)

    old_inds = np.arange(total)
    encrypted_inds = (old_inds + offset) % total

    encrypted_coords = curve_array[encrypted_inds]
    decrypted_coords = curve_array[old_inds]

    new_pixels = np.zeros_like(pixels)
    new_pixels[decrypted_coords[:, 1], decrypted_coords[:, 0]] = \
        pixels[encrypted_coords[:, 1], encrypted_coords[:, 0]]

    save_image_auto_mode(new_pixels, output_path)
    print(f"解密完成: {output_path}")

def main():
    """
    主函数：解析命令行参数、对目标文件夹下图像执行加密/解密，并覆盖原文件
    """
    print("程序启动... (注意：本程序将直接覆盖原文件)")
    parser = argparse.ArgumentParser(description="希尔伯特混淆/解混淆 CLI (覆盖原图)")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("-e", "--encrypt", action="store_true", help="加密文件夹内图像")
    group.add_argument("-d", "--decrypt", action="store_true", help="解密文件夹内图像")

    args = parser.parse_args()

    target_folder = "files"
    if not os.path.exists(target_folder):
        os.makedirs(target_folder, exist_ok=True)
        print(f"处理文件夹不存在，已创建: {os.path.abspath(target_folder)}")

    start_time = time.time()
    files = [f for f in os.listdir(target_folder) if f.lower().endswith((".png", ".jpg", ".jpeg"))]

    if not files:
        print(f"文件夹内没有图像文件，请放入 {os.path.abspath(target_folder)} 文件夹后重试")
        return

    print(f"开始处理 {len(files)} 个文件...")

    if args.encrypt:
        for i, f in enumerate(files, start=1):
            path = os.path.join(target_folder, f)
            print(f"[{i}/{len(files)}] 加密 -> {f}")
            encrypt_image(path, path)
    else:
        for i, f in enumerate(files, start=1):
            path = os.path.join(target_folder, f)
            print(f"[{i}/{len(files)}] 解密 -> {f}")
            decrypt_image(path, path)

    end_time = time.time()
    print(f"全部处理完成，耗时: {end_time - start_time:.2f}秒")

if __name__ == "__main__":
    main()