// worker.js —— WebAssembly 混淆核心的 Worker 外壳
//
// 职责：接收主线程传来的 ImageData 缓冲区，调用 WASM 做像素重排，再把结果传回去。
// 算法全部在 wasm（web/rs/src/lib.rs）里，本文件不实现任何置换逻辑。

import init, { Gilbert2D } from './wasm/lp_crypt_wasm_core.js';

// WASM 初始化只做一次，失败后缓存错误，避免后续消息反复抛异常
const wasmInitPromise = init().catch((error) => {
    console.error('[Worker] WASM 模块初始化失败:', error);
    throw error;
});

// 单张图片的像素上限：4 字节/像素 + wasm 侧同样大小的工作区，
// 超过这条线浏览器会直接抛内存分配错误，提前给出可读提示。
const MAX_PIXELS = 4096 * 4096;

self.onmessage = async function (e) {
    let gilbert = null;
    try {
        const { imgData, width, height, offset, isEncrypt } = e.data;

        if (!imgData || !imgData.data) {
            throw new Error('未收到有效的图像数据');
        }
        if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
            throw new Error(`图像尺寸不合法: ${width}x${height}`);
        }
        const total = width * height;
        if (total > MAX_PIXELS) {
            throw new Error(
                `图片过大（${width}x${height}）：WASM 核心单次最多处理 ${MAX_PIXELS} 像素，` +
                '请先缩小图片，或改用命令行版本',
            );
        }

        await wasmInitPromise;

        gilbert = new Gilbert2D(width, height);

        const buffer = new Uint8Array(imgData.data.buffer);
        if (buffer.length !== total * 4) {
            throw new Error(`像素缓冲区长度 ${buffer.length} 与 ${width}x${height} 不符`);
        }

        gilbert.process_pixels(buffer, offset, isEncrypt);

        self.postMessage({ type: 'result', buffer: buffer.buffer }, [buffer.buffer]);
    } catch (error) {
        console.error('[Worker] 处理图像出错:', error);
        self.postMessage({
            type: 'error',
            message: error && error.message ? error.message : String(error),
        });
    } finally {
        if (gilbert !== null) {
            gilbert.free(); // 释放 WASM 内存
        }
    }
};
