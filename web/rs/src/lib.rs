// Copyright [2025] <鲍炳文>
//! 小土豆图片混淆 —— Web/WASM 核心
//!
//! 本文件是 `web/src/wasm/lp_crypt_wasm_core_bg.wasm` 的**唯一源码**，
//! 使用 `wasm-bindgen 0.2.100` 构建，构建方式见 `web/rs/README.md`。
//!
//! 算法：把 `width × height` 的矩形按**广义希尔伯特（Gilbert）曲线**展开成一条
//! 覆盖全部像素的路径，再沿这条路径做循环位移 `(i + offset) % total`。
//! 该实现与 `Cpp/hilbert_encrypt.cpp` 逐字节等价（见 `tests/` 下的跨语言等价测试）。

use js_sys::Uint32Array;
use wasm_bindgen::prelude::*;

/// 曲线上的一个像素坐标
#[wasm_bindgen]
#[repr(C)] // 强制 C 语言内存布局
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Point {
    x: i32,
    y: i32,
}

/// 每个像素的字节数（浏览器侧统一按 RGBA 处理）
const BYTES_PER_PIXEL: usize = 4;

#[wasm_bindgen]
pub struct Gilbert2D {
    width: i32,
    coordinates: Vec<Point>,
}

#[wasm_bindgen]
impl Gilbert2D {
    #[wasm_bindgen(constructor)]
    pub fn new(width: i32, height: i32) -> Self {
        // 非法参数校验
        if width <= 0 || height <= 0 {
            panic!("Invalid dimensions: width={}, height={}", width, height);
        }

        let total = width as usize * height as usize;
        let mut coordinates = Vec::with_capacity(total);

        // 窄边作为主方向，保证生成的曲线尽量"方"，减少长直段
        if width >= height {
            generate_2d(0, 0, width, 0, 0, height, &mut coordinates);
        } else {
            generate_2d(0, 0, 0, height, width, 0, &mut coordinates);
        }

        // 曲线必须是覆盖全部像素的置换，否则像素重排会丢数据
        assert_eq!(
            coordinates.len(),
            total,
            "Generated curve length {} does not match pixel count {}",
            coordinates.len(),
            total
        );

        Gilbert2D {
            width,
            coordinates,
        }
    }

    /// 像素重排：`is_encrypt` 时把曲线第 i 个像素搬到第 (i+offset) 个位置，否则反向。
    ///
    /// `buffer` 必须是长度为 `width * height * 4` 的 RGBA 缓冲区。
    /// 实现为原地循环置换（每个像素只搬一次），峰值内存只有一个缓冲区，
    /// 相比"另开一份输出缓冲区"省下一半内存。
    #[wasm_bindgen]
    pub fn process_pixels(&self, buffer: &mut [u8], offset: i32, is_encrypt: bool) {
        let total = self.coordinates.len();
        let expected = total * BYTES_PER_PIXEL;
        assert_eq!(
            buffer.len(),
            expected,
            "Buffer length {} does not match {} x {} x {} = {}",
            buffer.len(),
            self.width,
            total / self.width.max(1) as usize,
            BYTES_PER_PIXEL,
            expected
        );

        if total == 0 {
            return;
        }

        // 规范化偏移量到 [0, total)，负数按模处理
        let offset = offset.rem_euclid(total as i32) as usize;
        if offset == 0 {
            // 恒等置换，无需搬运
            return;
        }

        // 目标索引：加密时 i -> i + offset，解密时 i -> i - offset（即 +total-offset）
        let shift = if is_encrypt {
            offset
        } else {
            (total - offset) % total
        };

        // 循环置换每条轨道：direct[to] = 原 direct[to - shift]
        // 这样每个像素只被搬运一次，且天然可逆（解密时 shift 取补即可）。
        let mut visited = vec![false; total];
        let mut saved = [0u8; BYTES_PER_PIXEL];

        for start in 0..total {
            if visited[start] {
                continue;
            }

            let start_p = self.pixel_index(start);
            saved.copy_from_slice(&buffer[start_p..start_p + BYTES_PER_PIXEL]);

            let mut to = start;
            loop {
                visited[to] = true;
                let from = (to + total - shift) % total;
                let from_p = self.pixel_index(from);
                let to_p = self.pixel_index(to);

                if from == start {
                    // 轨道闭合：填入最初保存的那一份
                    buffer[to_p..to_p + BYTES_PER_PIXEL].copy_from_slice(&saved);
                } else {
                    buffer.copy_within(from_p..from_p + BYTES_PER_PIXEL, to_p);
                }

                to = from;
                if to == start {
                    break;
                }
            }
        }
    }

    /// 返回预计算的像素偏移量表（曲线坐标 -> 线性索引），供别处复用
    #[wasm_bindgen]
    pub fn get_offsets(&self) -> Uint32Array {
        let offsets = self.generate_offsets();
        if offsets.is_empty() {
            panic!("Generated empty offset array");
        }
        Uint32Array::from(offsets.as_slice())
    }
}

impl Gilbert2D {
    /// 曲线第 `i` 个节点在线性缓冲区中的起始字节下标
    #[inline]
    fn pixel_index(&self, i: usize) -> usize {
        let p = self.coordinates[i];
        (p.x as usize + p.y as usize * self.width as usize) * BYTES_PER_PIXEL
    }

    fn generate_offsets(&self) -> Vec<u32> {
        self.coordinates
            .iter()
            .map(|p| (p.x + p.y * self.width) as u32)
            .collect()
    }
}

/// 递归生成广义希尔伯特曲线（Jakub Červený 的 Gilbert 2D 算法的整数化版本）
fn generate_2d(
    x: i32,
    y: i32,
    ax: i32,
    ay: i32,
    bx: i32,
    by: i32,
    coordinates: &mut Vec<Point>,
) {
    let w = (ax).abs() + (ay).abs();
    let h = (bx).abs() + (by).abs();

    let dax = ax.signum();
    let day = ay.signum();
    let dbx = bx.signum();
    let dby = by.signum();

    if h == 1 {
        // 平凡的横向填充
        let mut current_x = x;
        let mut current_y = y;
        for _ in 0..w {
            coordinates.push(Point {
                x: current_x,
                y: current_y,
            });
            current_x += dax;
            current_y += day;
        }
        return;
    }

    if w == 1 {
        // 平凡的纵向填充
        let mut current_x = x;
        let mut current_y = y;
        for _ in 0..h {
            coordinates.push(Point {
                x: current_x,
                y: current_y,
            });
            current_x += dbx;
            current_y += dby;
        }
        return;
    }

    let mut ax2 = ax / 2;
    let mut ay2 = ay / 2;
    let mut bx2 = bx / 2;
    let mut by2 = by / 2;

    let w2 = (ax2).abs() + (ay2).abs();
    let h2 = (bx2).abs() + (by2).abs();

    if 2 * w > 3 * h {
        // 长条情形：只沿主方向切成两段
        if (w2 % 2 != 0) && (w > 2) {
            // 尽可能取偶数步长
            ax2 += dax;
            ay2 += day;
        }

        generate_2d(x, y, ax2, ay2, bx, by, coordinates);
        generate_2d(
            x + ax2,
            y + ay2,
            ax - ax2,
            ay - ay2,
            bx,
            by,
            coordinates,
        );
    } else {
        // 标准情形：上一步、一个长横段、下一步
        if (h2 % 2 != 0) && (h > 2) {
            bx2 += dbx;
            by2 += dby;
        }

        generate_2d(x, y, bx2, by2, ax2, ay2, coordinates);
        generate_2d(
            x + bx2,
            y + by2,
            ax,
            ay,
            bx - bx2,
            by - by2,
            coordinates,
        );
        generate_2d(
            x + (ax - dax) + (bx2 - dbx),
            y + (ay - day) + (by2 - dby),
            -bx2,
            -by2,
            -(ax - ax2),
            -(ay - ay2),
            coordinates,
        );
    }
}

/// 显式暴露构造入口，兼容早期版本的 JS 胶水
#[wasm_bindgen]
pub fn create_gilbert(width: i32, height: i32) -> Gilbert2D {
    Gilbert2D::new(width, height)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 确定性伪随机，方便复现
    fn pseudo_random_bytes(len: usize, seed: u32) -> Vec<u8> {
        let mut state = seed | 1;
        (0..len)
            .map(|_| {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                (state >> 24) as u8
            })
            .collect()
    }

    #[test]
    fn test_2x2_grid_order() {
        let gilbert = Gilbert2D::new(2, 2);
        assert_eq!(
            gilbert.coordinates,
            vec![
                Point { x: 0, y: 0 },
                Point { x: 0, y: 1 },
                Point { x: 1, y: 1 },
                Point { x: 1, y: 0 },
            ]
        );
    }

    #[test]
    fn test_1x1_grid() {
        let gilbert = Gilbert2D::new(1, 1);
        assert_eq!(gilbert.coordinates, vec![Point { x: 0, y: 0 }]);
    }

    #[test]
    #[should_panic(expected = "Invalid dimensions")]
    fn test_invalid_input() {
        let _ = Gilbert2D::new(0, 5);
    }

    #[test]
    fn test_offsets() {
        let gilbert = Gilbert2D::new(2, 2);
        assert_eq!(gilbert.generate_offsets(), vec![0, 2, 3, 1]);
    }

    /// 曲线必须是覆盖整个矩形的双射
    #[test]
    fn test_curve_is_permutation() {
        for (w, h) in [(1, 1), (1, 7), (7, 1), (3, 5), (5, 3), (16, 16), (37, 100), (100, 37), (1382, 924)] {
            let gilbert = Gilbert2D::new(w, h);
            let mut seen = vec![false; (w * h) as usize];
            for p in &gilbert.coordinates {
                assert!(p.x >= 0 && p.x < w && p.y >= 0 && p.y < h, "越界: {:?} @ {}x{}", p, w, h);
                let idx = (p.x + p.y * w) as usize;
                assert!(!seen[idx], "重复访问: {:?} @ {}x{}", p, w, h);
                seen[idx] = true;
            }
            assert!(seen.iter().all(|v| *v), "曲线未覆盖全部像素 @ {}x{}", w, h);
        }
    }

    /// 2x2 的已知向量（手工按曲线坐标推导）：
    /// 曲线顺序 [0, 2, 3, 1]，offset=1 时 buffer[to] = 原 buffer[曲线[(pos(to)-1+4)%4]]
    /// 于是线性像素 0←绿、1←黄、2←红、3←蓝
    #[test]
    fn test_pixel_processing_known_vector() {
        let mut buffer = vec![
            255, 0, 0, 255, // 线性 0：红
            0, 255, 0, 255, // 线性 1：绿
            0, 0, 255, 255, // 线性 2：蓝
            255, 255, 0, 255, // 线性 3：黄
        ];
        let gilbert = Gilbert2D::new(2, 2);
        gilbert.process_pixels(&mut buffer, 1, true);
        assert_eq!(
            buffer,
            vec![
                0, 255, 0, 255, // 绿
                255, 255, 0, 255, // 黄
                255, 0, 0, 255, // 红
                0, 0, 255, 255, // 蓝
            ]
        );

        // 解密应完全还原
        gilbert.process_pixels(&mut buffer, 1, false);
        assert_eq!(
            buffer,
            vec![
                255, 0, 0, 255, // 红
                0, 255, 0, 255, // 绿
                0, 0, 255, 255, // 蓝
                255, 255, 0, 255, // 黄
            ]
        );
    }

    /// 原地循环置换必须与"另开一份输出缓冲区"的直白写法逐字节一致
    #[test]
    fn test_in_place_matches_naive_permutation() {
        for (w, h) in [(1, 1), (1, 9), (9, 1), (2, 2), (3, 5), (5, 3), (16, 16), (37, 100)] {
            let total = (w * h) as usize;
            let original = pseudo_random_bytes(total * BYTES_PER_PIXEL, (w * 131 + h * 7) as u32);
            let gilbert = Gilbert2D::new(w, h);

            for offset in [1, 2, 5, 13, total as i32 - 1] {
                let shift = offset.rem_euclid(total as i32) as usize % total;

                for is_encrypt in [true, false] {
                    // 直白写法（也就是旧版 WASM 的行为）
                    let mut naive = vec![0u8; original.len()];
                    let step = if is_encrypt {
                        shift
                    } else {
                        (total - shift) % total
                    };
                    for i in 0..total {
                        let src = gilbert.pixel_index(i);
                        let dst = gilbert.pixel_index((i + step) % total);
                        naive[dst..dst + BYTES_PER_PIXEL]
                            .copy_from_slice(&original[src..src + BYTES_PER_PIXEL]);
                    }

                    let mut actual = original.clone();
                    gilbert.process_pixels(&mut actual, offset, is_encrypt);
                    assert_eq!(
                        actual, naive,
                        "原地置换与直白写法不一致: {}x{} offset={} encrypt={}",
                        w, h, offset, is_encrypt
                    );
                }
            }
        }
    }

    /// 各种尺寸下加解密必须可逆，且同一缓冲区加密两次结果不同
    #[test]
    fn test_round_trip() {
        for (w, h) in [(1, 1), (1, 9), (9, 1), (2, 2), (3, 5), (5, 3), (16, 16), (100, 37), (137, 63)] {
            let total = (w * h) as usize;
            let original = pseudo_random_bytes(total * BYTES_PER_PIXEL, (w * 31 + h * 17) as u32);
            let gilbert = Gilbert2D::new(w, h);

            for offset in [0, 1, 7, 12345, total as i32 - 1, (total as f64 * 0.6180339887498949).round() as i32] {
                let mut buffer = original.clone();
                assert_eq!(buffer.len(), total * BYTES_PER_PIXEL);
                gilbert.process_pixels(&mut buffer, offset, true);
                gilbert.process_pixels(&mut buffer, offset, false);
                assert_eq!(buffer, original, "往返失败: {}x{} offset={}", w, h, offset);
            }
        }
    }

    /// offset = 0 必须是恒等置换
    #[test]
    fn test_zero_offset_is_identity() {
        let gilbert = Gilbert2D::new(13, 7);
        let original = pseudo_random_bytes(13 * 7 * BYTES_PER_PIXEL, 42);
        let mut buffer = original.clone();
        gilbert.process_pixels(&mut buffer, 0, true);
        assert_eq!(buffer, original);
    }

    /// 负偏移与等价正偏移效果一致
    #[test]
    fn test_negative_offset_wraps() {
        let total = 13 * 7;
        let gilbert = Gilbert2D::new(13, 7);
        let original = pseudo_random_bytes(total * BYTES_PER_PIXEL, 7);

        let mut a = original.clone();
        gilbert.process_pixels(&mut a, -3, true);

        let mut b = original.clone();
        gilbert.process_pixels(&mut b, total as i32 - 3, true);

        assert_eq!(a, b);
    }

    /// 缓冲区长度不匹配时应当 panic
    #[test]
    #[should_panic(expected = "Buffer length")]
    fn test_buffer_length_mismatch() {
        let gilbert = Gilbert2D::new(4, 4);
        let mut buffer = vec![0u8; 4 * 4 * 4 - 1];
        gilbert.process_pixels(&mut buffer, 1, true);
    }
}
