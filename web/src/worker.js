// worker.js
import init, { Gilbert2D } from './wasm/lp_crypt_wasm_core.js';

// 初始化WASM模块
const wasmInitPromise =  init().catch((error) => {
        console.error('Error initializing WASM module:', error);
        throw error;
    }
);

self.onmessage = async function (e) {
    console.log('[Worker] Received Message:', e.data);

    await wasmInitPromise; // 等待WASM模块初始化完成

    const { imgData, width, height, offset, isEncrypt } = e.data;
    console.log('[Worker] Data:', imgData, width, height, offset, isEncrypt);

    const gilbert = new Gilbert2D(width, height);
    if (!gilbert) {
        throw new Error("Gilbert2D 对象未正确初始化");
    }

    const buffer = new Uint8Array(imgData.data.buffer);
    gilbert.process_pixels(buffer, offset, isEncrypt);

    self.postMessage({
        type: 'result',
        buffer: buffer.buffer,
    }, [buffer.buffer]); // 使用 Transferable

    gilbert.free(); // 释放WASM内存
};