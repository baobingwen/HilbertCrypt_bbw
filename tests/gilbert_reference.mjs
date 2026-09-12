// tests/gilbert_reference.mjs
// 广义希尔伯特（Gilbert）曲线的**参考实现**（与 C++/Rust 同一份算法）。
//
// 用途：在不加载任何 wasm、不依赖任何编译产物的前提下，为跨语言等价测试提供"标准答案"。
// 同时导出用于给定尺寸和偏移量的像素置换索引表，便于和 C++/Python 的结果逐字节比对。

/**
 * 生成覆盖 width×height 全部像素的广义希尔伯特曲线。
 * @param {number} width
 * @param {number} height
 * @returns {Array<[number, number]>} 长度为 width*height 的坐标序列
 */
export function gilbert2d(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new Error(`Invalid dimensions: width=${width}, height=${height}`);
    }
    const coordinates = [];
    coordinates.length = 0;
    if (width >= height) {
        generate2d(0, 0, width, 0, 0, height, coordinates);
    } else {
        generate2d(0, 0, 0, height, width, 0, coordinates);
    }
    if (coordinates.length !== width * height) {
        throw new Error(`曲线长度 ${coordinates.length} 与像素数 ${width * height} 不符`);
    }
    return coordinates;
}

function generate2d(x, y, ax, ay, bx, by, coordinates) {
    const w = Math.abs(ax) + Math.abs(ay);
    const h = Math.abs(bx) + Math.abs(by);

    const dax = Math.sign(ax);
    const day = Math.sign(ay);
    const dbx = Math.sign(bx);
    const dby = Math.sign(by);

    if (h === 1) {
        for (let i = 0; i < w; i++) {
            coordinates.push([x, y]);
            x += dax;
            y += day;
        }
        return;
    }

    if (w === 1) {
        for (let i = 0; i < h; i++) {
            coordinates.push([x, y]);
            x += dbx;
            y += dby;
        }
        return;
    }

    let ax2 = Math.trunc(ax / 2);
    let ay2 = Math.trunc(ay / 2);
    let bx2 = Math.trunc(bx / 2);
    let by2 = Math.trunc(by / 2);

    const w2 = Math.abs(ax2) + Math.abs(ay2);
    const h2 = Math.abs(bx2) + Math.abs(by2);

    if (2 * w > 3 * h) {
        if (w2 % 2 !== 0 && w > 2) {
            ax2 += dax;
            ay2 += day;
        }
        generate2d(x, y, ax2, ay2, bx, by, coordinates);
        generate2d(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by, coordinates);
    } else {
        if (h2 % 2 !== 0 && h > 2) {
            bx2 += dbx;
            by2 += dby;
        }
        generate2d(x, y, bx2, by2, ax2, ay2, coordinates);
        generate2d(x + bx2, y + by2, ax, ay, bx - bx2, by - by2, coordinates);
        generate2d(
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

/** 默认偏移量：黄金分割比 × 像素总数，四舍五入 */
export function defaultOffset(total) {
    return Math.round(((Math.sqrt(5) - 1) / 2) * total);
}

/**
 * 计算像素置换：dst[i] = src[(i + shift) % total]，shift 由加密/解密方向决定。
 * @returns {Int32Array} 长度 total 的源索引表
 */
export function permutationSourceIndices(total, offset, isEncrypt) {
    const shift = ((offset % total) + total) % total;
    const step = isEncrypt ? shift : (total - shift) % total;
    const src = new Int32Array(total);
    for (let i = 0; i < total; i++) src[i] = (i - step + total) % total;
    return src;
}
