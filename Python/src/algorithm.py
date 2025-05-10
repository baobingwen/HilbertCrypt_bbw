# algorithm.py
import math
import numpy as np
from PIL import Image

class HilbertImageProcessor:
    """
    独立可调用的图像处理器
    功能：通过希尔伯特曲线实现像素位置加解密
    """

    def __init__(self, golden_ratio: float = (math.sqrt(5)-1)/2):
        """
        初始化配置
        
        :param golden_ratio: 偏移量计算比例，默认黄金分割率
        """
        self.golden_ratio = golden_ratio

    def process_image(self, input_path: str, output_path: str, mode: str) -> None:
        """
        完整处理流程入口
        
        :param input_path: 输入文件路径
        :param output_path: 输出文件路径
        :param mode: 操作模式 'encrypt' 或 'decrypt'
        """
        # 加载图像
        img = Image.open(input_path).convert("RGBA")
        pixels = np.array(img)

        # 执行核心处理
        processed_pixels = self._process_pixels(pixels, mode)

        # 保存结果
        self._save_image(processed_pixels, output_path)

    def _generate_hilbert_curve(self, width: int, height: int) -> np.ndarray:
        """生成适配图像尺寸的希尔伯特映射表"""
        max_dim = max(width, height)
        n = math.ceil(math.log2(max_dim)) if max_dim > 0 else 1
        size = 1 << n
        
        # 生成基础曲线
        D = np.arange(size*size, dtype=np.uint32)
        X, Y = np.zeros_like(D), np.zeros_like(D)

        for sPow in range(n):
            s = 1 << sPow
            rx = (D >> 1) & 1
            ry = (D ^ rx) & 1

            # 坐标变换
            mask_flip = (rx == 1) & (ry == 0)
            X[mask_flip] = s - 1 - X[mask_flip]
            Y[mask_flip] = s - 1 - Y[mask_flip]

            idx_swap = np.where(ry == 0)[0]
            X[idx_swap], Y[idx_swap] = Y[idx_swap], X[idx_swap].copy()

            X += s * rx
            Y += s * ry
            D >>= 2

        # 筛选有效坐标
        curve = np.column_stack((X, Y))
        mask = (curve[:, 0] < width) & (curve[:, 1] < height)
        return curve[mask][:width*height]

    def _process_pixels(self, pixels: np.ndarray, mode: str) -> np.ndarray:
        """核心像素处理逻辑"""
        height, width = pixels.shape[:2]
        curve = self._generate_hilbert_curve(width, height)
        total = width * height
        offset = round(self.golden_ratio * total)

        # 生成索引
        old_inds = np.arange(total)
        new_inds = (old_inds + offset) % total

        # 坐标映射
        if mode == "encrypt":
            src_coords = curve[old_inds]
            dst_coords = curve[new_inds]
        else:
            src_coords = curve[new_inds]
            dst_coords = curve[old_inds]

        # 执行像素重排
        new_pixels = np.zeros_like(pixels)
        new_pixels[dst_coords[:, 1], dst_coords[:, 0]] = pixels[src_coords[:, 1], src_coords[:, 0]]
        return new_pixels

    def _save_image(self, pixels: np.ndarray, output_path: str) -> None:
        """智能保存图像"""
        img = Image.fromarray(pixels)
        if output_path.lower().endswith(('.jpg', '.jpeg')) and img.mode == 'RGBA':
            img = img.convert('RGB')
        img.save(output_path)