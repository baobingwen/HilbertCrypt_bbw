// worker.js
function gilbert2d(width, height) {
    /**
     * Generalized Hilbert ('gilbert') space-filling curve for arbitrary-sized
     * 2D rectangular grids. Generates discrete 2D coordinates to fill a rectangle
     * of size (width x height).
     */
    const coordinates = [];

    if (width >= height) {
        generate2d(0, 0, width, 0, 0, height, coordinates);
    } else {
        generate2d(0, 0, 0, height, width, 0, coordinates);
    }

    return coordinates;
}

function generate2d(x, y, ax, ay, bx, by, coordinates) {
    const w = Math.abs(ax + ay);
    const h = Math.abs(bx + by);

    const dax = Math.sign(ax), day = Math.sign(ay); // unit major direction
    const dbx = Math.sign(bx), dby = Math.sign(by); // unit orthogonal direction

    if (h === 1) {
        // trivial row fill
        for (let i = 0; i < w; i++) {
            coordinates.push([x, y]);
            x += dax;
            y += day;
        }
        return;
    }

    if (w === 1) {
        // trivial column fill
        for (let i = 0; i < h; i++) {
            coordinates.push([x, y]);
            x += dbx;
            y += dby;
        }
        return;
    }

    let ax2 = Math.floor(ax / 2), ay2 = Math.floor(ay / 2);
    let bx2 = Math.floor(bx / 2), by2 = Math.floor(by / 2);

    const w2 = Math.abs(ax2 + ay2);
    const h2 = Math.abs(bx2 + by2);

    if (2 * w > 3 * h) {
        if ((w2 % 2) && (w > 2)) {
            // prefer even steps
            ax2 += dax;
            ay2 += day;
        }

        // long case: split in two parts only
        generate2d(x, y, ax2, ay2, bx, by, coordinates);
        generate2d(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by, coordinates);

    } else {
        if ((h2 % 2) && (h > 2)) {
            // prefer even steps
            bx2 += dbx;
            by2 += dby;
        }

        // standard case: one step up, one long horizontal, one step down
        generate2d(x, y, bx2, by2, ax2, ay2, coordinates);
        generate2d(x + bx2, y + by2, ax, ay, bx - bx2, by - by2, coordinates);
        generate2d(x + (ax - dax) + (bx2 - dbx), y + (ay - day) + (by2 - dby),
            -bx2, -by2, -(ax - ax2), -(ay - ay2), coordinates);
    }
}

self.onmessage = function (e) {
    const { imgData, width, height, offset, isEncrypt } = e.data;
    const curve = gilbert2d(width, height);
    const newData = new Uint8ClampedArray(imgData.data.length);
    const total = width * height;
    const batchSize = Math.max(1, Math.floor(total / 200)); // 共发送200次进度
    let lastProgress = -1;

    for (let i = 0; i < total; i++) {
        const old_pos = curve[i];
        const new_pos = curve[(i + offset) % total];
        const old_p = 4 * (old_pos[0] + old_pos[1] * width);
        const new_p = 4 * (new_pos[0] + new_pos[1] * width);
        if (isEncrypt) {
            // 加密：将旧位置像素复制到新位置
            newData.set(imgData.data.subarray(old_p, old_p + 4), new_p);
        } else {
            // 解密：将新位置像素还原到旧位置
            newData.set(imgData.data.subarray(new_p, new_p + 4), old_p);
        }
        // 分批发送进度，每处理 batchSize 个像素触发一次
        if (i % batchSize === 0 || i === total - 1) {
            const currentProgress = Math.min(Math.floor((i / total) * 100), 100);
            if (currentProgress > lastProgress || i === total - 1) {
                lastProgress = currentProgress;
                self.postMessage({ type: 'progress', progress: currentProgress });
            }
        }
    }
    // 处理完所有像素后发送最终结果
    self.postMessage({ type: 'progress', progress: 100 }); // 确保最终进度为100%

    self.postMessage({
        type: 'result',
        data: newData,
        finalProgress: 100 // 最终进度标记
    }, [newData.buffer]); // 使用 Transferable 提升性能
};