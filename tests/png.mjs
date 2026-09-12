// tests/png.mjs
// 极简 PNG 解码器（仅用于测试断言）：支持 8 位灰度/RGB/RGBA/调色板非隔行 PNG，
// 返回真正的**像素数组**，从而不受不同编码器滤波策略的影响。

import zlib from 'node:zlib';

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

/**
 * 解码 PNG，返回 { width, height, channels, data }，data 为逐像素原始字节。
 * 不支持的格式（16 位、隔行、未知色彩类型）会抛错，由调用方决定如何处理。
 */
export function decodePng(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');

    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idat = [];
    let palette = null;
    let transparency = null;

    while (offset + 8 <= buf.length) {
        const length = buf.readUInt32BE(offset);
        const type = buf.toString('ascii', offset + 4, offset + 8);
        const data = buf.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'PLTE') {
            palette = Buffer.from(data);
        } else if (type === 'tRNS') {
            transparency = Buffer.from(data);
        } else if (type === 'IDAT') {
            idat.push(Buffer.from(data));
        } else if (type === 'IEND') {
            break;
        }
        offset += 12 + length;
    }

    if (bitDepth !== 8) throw new Error(`仅支持 8 位 PNG，实际 ${bitDepth} 位`);
    if (interlace !== 0) throw new Error('不支持隔行 PNG');

    const channels = CHANNELS_BY_COLOR_TYPE[colorType];
    if (!channels) throw new Error(`不支持的色彩类型 ${colorType}`);

    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const pixels = Buffer.alloc(height * stride);

    let pos = 0;
    for (let y = 0; y < height; y++) {
        const filter = raw[pos++];
        const rowStart = y * stride;
        const prevStart = (y - 1) * stride;
        for (let i = 0; i < stride; i++) {
            const x = raw[pos + i];
            const a = i >= channels ? pixels[rowStart + i - channels] : 0;
            const b = y > 0 ? pixels[prevStart + i] : 0;
            const c = y > 0 && i >= channels ? pixels[prevStart + i - channels] : 0;
            let value;
            switch (filter) {
                case 0:
                    value = x;
                    break;
                case 1:
                    value = x + a;
                    break;
                case 2:
                    value = x + b;
                    break;
                case 3:
                    value = x + ((a + b) >> 1);
                    break;
                case 4:
                    value = x + paeth(a, b, c);
                    break;
                default:
                    throw new Error(`未知的 PNG 滤波器 ${filter}`);
            }
            pixels[rowStart + i] = value & 0xff;
        }
        pos += stride;
    }

    // 统一展开成 RGBA，方便跨色彩模式比较
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0, n = width * height; i < n; i++) {
        let r;
        let g;
        let b;
        let a = 255;
        if (colorType === 0) {
            r = g = b = pixels[i];
        } else if (colorType === 4) {
            r = g = b = pixels[i * 2];
            a = pixels[i * 2 + 1];
        } else if (colorType === 2) {
            r = pixels[i * 3];
            g = pixels[i * 3 + 1];
            b = pixels[i * 3 + 2];
        } else if (colorType === 6) {
            r = pixels[i * 4];
            g = pixels[i * 4 + 1];
            b = pixels[i * 4 + 2];
            a = pixels[i * 4 + 3];
        } else if (colorType === 3) {
            if (!palette) throw new Error('调色板 PNG 缺少 PLTE');
            const idx = pixels[i];
            r = palette[idx * 3];
            g = palette[idx * 3 + 1];
            b = palette[idx * 3 + 2];
            if (transparency && idx < transparency.length) a = transparency[idx];
        }
        rgba[i * 4] = r;
        rgba[i * 4 + 1] = g;
        rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = a;
    }

    return { width, height, channels, data: rgba };
}

/** 比较两个 PNG 的像素（忽略编码差异与色彩模式差异） */
export function pngPixelsEqual(a, b) {
    try {
        const pa = decodePng(a);
        const pb = decodePng(b);
        return (
            pa.width === pb.width &&
            pa.height === pb.height &&
            Buffer.compare(pa.data, pb.data) === 0
        );
    } catch {
        return false;
    }
}
