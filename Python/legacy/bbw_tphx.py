# python
import argparse
import os
import math
import time
import numpy as np
from PIL import Image

def hilbert_curve_generator(n):
    '''
    生成希尔伯特曲线
    '''
    size = 2 ** n
    curve = []
    for d in range(size * size):
        x, y = 0, 0
        t = d
        s = 1
        while s < size:
            rx = (t // 2) & 1
            ry = (t ^ rx) & 1
            if ry == 0:
                if rx == 1:
                    x = s - 1 - x
                    y = s - 1 - y
                x, y = y, x
            x += s * rx
            y += s * ry
            t //= 4
            s *= 2
        curve.append((x, y))
    return curve

def generate_mapping(width, height):
    '''
    生成映射表
    '''
    max_dim = max(width, height)
    n = math.ceil(math.log2(max_dim)) if max_dim > 0 else 1
    
    start_time = time.time()
    curve = hilbert_curve_generator(n)
    end_time = time.time()
    print(f"生成希尔伯特曲线耗时: {end_time - start_time:.2f}秒")
    
    start_time = time.time()
    valid_curve = []
    for x, y in curve:
        if x < width and y < height:
            valid_curve.append((x, y))
            if len(valid_curve) == width * height:
                break
    end_time = time.time()
    print(f"生成映射表耗时: {end_time - start_time:.2f}秒")
    
    return valid_curve

def save_image_auto_mode(pixels, output_path):
    """
    根据文件后缀判断是否需要将RGBA转换成RGB,
    然后保存图像
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
    对图像执行希尔伯特混淆加密 - 使用 NumPy 高级索引
    """
    try:
        img = Image.open(input_path).convert("RGBA")
    except FileNotFoundError:
        print("输入文件不存在:", input_path)
        return

    width, height = img.size
    pixels = np.array(img)  # [height, width, 4]
    
    # 生成映射表
    curve = generate_mapping(width, height)
    # 将曲线坐标转换为 NumPy 数组，形状为 (total, 2)
    curve_array = np.array(curve, dtype=int)  # 每个坐标 (x, y)
    
    golden_ratio = (math.sqrt(5) - 1) / 2
    total = width * height
    offset = round(golden_ratio * total)
    
    # old_inds: 加密前 (遍历 0 ~ total-1)，长度为 total
    # new_inds: 加密后位置 = (old_inds + offset) % total
    old_inds = np.arange(total)
    new_inds = (old_inds + offset) % total
    
    # old_coords[i] = (old_x, old_y)
    # new_coords[i] = (new_x, new_y)
    old_coords = curve_array[old_inds]
    new_coords = curve_array[new_inds]
    
    # 创建空白像素数组
    new_pixels = np.zeros_like(pixels)
    
    # 利用高级索引，一次性完成映射
    # 注意: 数组像素访问顺序为 [row, col] = [y, x]，因此：
    # new_pixels[new_y, new_x] = pixels[old_y, old_x]
    new_pixels[new_coords[:, 1], new_coords[:, 0]] = pixels[old_coords[:, 1], old_coords[:, 0]]

    # 保存加密后图像
    save_image_auto_mode(new_pixels, output_path)
    print(f"加密完成: {output_path}")

def decrypt_image(input_path, output_path):
    """
    对图像执行希尔伯特混淆解密 - 使用 NumPy 高级索引
    """
    try:
        img = Image.open(input_path).convert("RGBA")
    except FileNotFoundError:
        print("输入文件不存在:", input_path)
        return

    width, height = img.size
    pixels = np.array(img)  # [height, width, 4]
    
    # 生成映射表
    curve = generate_mapping(width, height)
    curve_array = np.array(curve, dtype=int)  # (total, 2)
    
    golden_ratio = (math.sqrt(5) - 1) / 2
    total = width * height
    offset = round(golden_ratio * total)
    
    # 解密逻辑与加密相反：
    # 原循环形式： 
    #   encrypted_idx = (i + offset) % total
    #   ex, ey = curve[encrypted_idx]
    #   dx, dy = curve[i]
    #   decrypted_pixels[dy, dx] = pixels[ey, ex]
    # => 可转换为批量操作：
    old_inds = np.arange(total)
    encrypted_inds = (old_inds + offset) % total
    
    # 加密后像素对应的坐标
    encrypted_coords = curve_array[encrypted_inds]  # (ex, ey)
    # 解密后目标坐标
    decrypted_coords = curve_array[old_inds]        # (dx, dy)
    
    new_pixels = np.zeros_like(pixels)
    new_pixels[decrypted_coords[:, 1], decrypted_coords[:, 0]] = pixels[encrypted_coords[:, 1], encrypted_coords[:, 0]]
    
    save_image_auto_mode(new_pixels, output_path)
    print(f"解密完成: {output_path}")

def main():
    '''
    主函数，用于解析命令行参数，执行加密/解密操作
    '''
    print("程序启动... (注意：本程序将直接覆盖原文件)")
    parser = argparse.ArgumentParser(description="希尔伯特混淆/解混淆 CLI (覆盖原图)")
    group = parser.add_mutually_exclusive_group(required=True)  # 创建一个互斥选项组，必须选择其中一个(加密或解密)
    group.add_argument("-e", "--encrypt", action="store_true", help="加密文件夹内图像")  # 如果用户选择加密，则会将此标记设置为 True
    group.add_argument("-d", "--decrypt", action="store_true", help="解密文件夹内图像")  # 如果用户选择解密，则会将此标记设置为 True

    args = parser.parse_args()  # 解析命令行参数，得到用户的具体操作指令

    target_folder = "files"  # 设定处理文件夹路径，直接使用相同路径覆盖原图
    if not os.path.exists(target_folder):
        os.makedirs(target_folder, exist_ok=True)
        print(f"处理文件夹不存在，已自动创建: {os.path.abspath(target_folder)}")

    start_time = time.time()  # 记录程序开始时间，用于统计运行时长
    files = [f for f in os.listdir(target_folder) if f.lower().endswith((".png", ".jpg", ".jpeg"))]
    # 从处理文件夹中筛选出所有 png/jpg/jpeg 图像文件

    if not files:  # 如果文件列表为空，则打印提示后退出
        print(f"文件夹内没有文件，请放入文件至 {os.path.abspath(target_folder)} 文件夹内")
        return

    print(f"即将处理 {len(files)} 个文件...")  # 告知用户当前待处理的图像文件数量

    if args.encrypt:
        # 用户选择加密操作
        for i, f in enumerate(files, start=1):
            print(f"[{i}/{len(files)}] 正在加密 -> {f}")
            path = os.path.join(target_folder, f)
            encrypt_image(path, path)  # 加密图像后直接覆盖原文件
            print(f"[{i}/{len(files)}] 已完成加密: {f}")
    elif args.decrypt:
        # 用户选择解密操作
        for i, f in enumerate(files, start=1):
            print(f"[{i}/{len(files)}] 正在解密 -> {f}")
            path = os.path.join(target_folder, f)
            decrypt_image(path, path)  # 解密图像后直接覆盖原文件
            print(f"[{i}/{len(files)}] 已完成解密: {f}")

    end_time = time.time()
    print(f"全部处理完成，耗时：{end_time - start_time:.2f}秒")

if __name__ == "__main__":
    main()