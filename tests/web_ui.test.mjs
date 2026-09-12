// tests/web_ui.test.mjs
// Web 端的静态契约与端到端像素通路测试。
//
// 覆盖两类问题：
//   1. worker.js 与 index.html 的**协议一致性**：
//      - worker 真的会 import 并调用 WASM
//      - index.html 的偏移量公式与命令行一致（round(φ × 总像素数)）
//      - 已删除的分块进度协议（retry）不会残留在 index.html 里
//      - 所有 worker 可能发出的消息类型在主线程都有分支处理
//      - worker.js 里不存在"内层 const 遮蔽外层 let"导致的 finally 死代码
//   2. 用真实的 worker.js 跑一遍完整的请求-响应（含真实尺寸的 1382×924），
//      验证像素数据经 worker 往返后与参考实现逐字节一致。

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { defaultOffset, gilbert2d, permutationSourceIndices } from './gilbert_reference.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WEB_SRC = path.join(repoRoot, 'web', 'src');
const WORKER = path.join(WEB_SRC, 'worker.js');
const INDEX = path.join(WEB_SRC, 'index.html');
const WASM_GLUE = path.join(WEB_SRC, 'wasm', 'lp_crypt_wasm_core.js');
const WASM_BIN = path.join(WEB_SRC, 'wasm', 'lp_crypt_wasm_core_bg.wasm');

let checks = 0;
let failures = 0;
const details = [];
function check(label, ok, detail = '') {
    checks++;
    if (ok) return;
    failures++;
    details.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

const workerSrc = await readFile(WORKER, 'utf8');
const indexSrc = await readFile(INDEX, 'utf8');

// ---------------------------------------------------------------- 1. 静态契约

// 1.1 worker 必须真正调用 WASM 核心
check('worker.js 引入 WASM 核心', /from\s+['"]\.\/wasm\/lp_crypt_wasm_core\.js['"]/.test(workerSrc));
check('worker.js 调用 process_pixels', /\.process_pixels\s*\(/.test(workerSrc));
check('worker.js 释放 WASM 内存', /\.free\s*\(\s*\)/.test(workerSrc));

// 1.2 反例守护：曾经出现过 `const gilbert` 遮蔽外层 `let gilbert`，
//     导致 finally 里的兜底释放永远不执行。显式断言不再出现内层 const 声明。
check(
    'worker.js 不存在遮蔽外层 gilbert 的内层声明',
    !/const\s+gilbert\s*=/.test(workerSrc),
    '在 try 里用 const 重新声明会遮蔽外层的 let',
);

// 1.3 index.html 的偏移量公式必须与命令行一致
const fnMatch = indexSrc.match(/function calculateOffset\(width, height\) \{[\s\S]*?\n {8}\}/);
check('index.html 中能定位到 calculateOffset', Boolean(fnMatch));
if (fnMatch) {
    const body = fnMatch[0];
    // 用最小的 DOM 替身直接执行这段函数
    const fakeInput = { value: '' };
    const document = { getElementById: () => fakeInput };
    const calculateOffset = new Function('document', `${body}; return calculateOffset;`)(document);

    check(
        '空输入默认偏移量 = round(φ × 总像素数)',
        calculateOffset(1382, 924) === defaultOffset(1382 * 924),
        `得到 ${calculateOffset(1382, 924)}，期望 ${defaultOffset(1382 * 924)}`,
    );
    check(
        '显式输入 auto 使用同一公式',
        (() => {
            fakeInput.value = 'auto';
            return calculateOffset(100, 37) === defaultOffset(3700);
        })(),
    );
    check(
        '超范围输入被夹到 total-1',
        (() => {
            fakeInput.value = '99999999';
            return calculateOffset(100, 37) === 100 * 37 - 1;
        })(),
    );
    check(
        '范围内的大数字被原样采用',
        (() => {
            fakeInput.value = '1234';
            return calculateOffset(100, 37) === 1234;
        })(),
    );
    check(
        '非法输入退化为 0',
        (() => {
            fakeInput.value = 'abc';
            return calculateOffset(100, 37) === 0;
        })(),
    );
    check(
        '负偏移量取绝对值',
        (() => {
            fakeInput.value = '-5';
            return calculateOffset(100, 37) === 5;
        })(),
    );
    fakeInput.value = '';
}

// 1.4 旧协议残留检查
check('index.html 不再有 retry 分块协议分支', !/type === 'retry'/.test(indexSrc));
check('index.html 处理 worker 的 error 消息', /type === 'error'/.test(indexSrc));

// 1.5 主线程必须覆盖 worker 可能发出的每一种消息
const workerMessageTypes = [...workerSrc.matchAll(/type:\s*'([a-z]+)'/g)].map((m) => m[1]);
const missing = [...new Set(workerMessageTypes)].filter(
    (t) => !new RegExp(`type === '${t}'`).test(indexSrc),
);
check(
    `主线程覆盖 worker 的全部消息类型 (${[...new Set(workerMessageTypes)].join(', ')})`,
    missing.length === 0,
    missing.length ? `未处理: ${missing.join(', ')}` : '',
);

// 1.6 出错后必须恢复 UI 状态
check('index.html 定义了 resetProcessingState', /function resetProcessingState\(\)/.test(indexSrc));
const resetCalls = (indexSrc.match(/resetProcessingState\(\)/g) ?? []).length;
check('错误路径调用了 resetProcessingState', resetCalls >= 3, `仅 ${resetCalls} 处`);

// ---------------------------------------------------------------- 2. 端到端 worker 往返

if (!existsSync(WASM_GLUE) || !existsSync(WASM_BIN)) {
    check('wasm 产物存在', false, '缺少 web/src/wasm 产物');
} else {
    const wasmMod = await import(pathToFileURL(WASM_GLUE).href);
    wasmMod.initSync({ module: await readFile(WASM_BIN) }); // 预初始化，worker 里的 init() 会直接复用

    // worker.js 是 ES module，且在模块顶层读 `self`；Node 没有 self，这里装一个替身，
    // 这样测试跑的就是**未改动的** worker.js 源码本身。
    const replies = [];
    globalThis.self = {
        onmessage: null,
        postMessage(payload) {
            replies.push(payload);
        },
    };
    globalThis.postMessage = globalThis.self.postMessage;
    await import(pathToFileURL(WORKER).href);

    check('worker.js 在预初始化 WASM 后加载成功', typeof globalThis.self.onmessage === 'function');

    const callWorker = async (data) => {
        replies.length = 0;
        await globalThis.self.onmessage({ data });
        return replies[0];
    };

    // 2.1 正常往返（真实尺寸，WASM 侧 1.27M 像素）
    const width = 1382;
    const height = 924;
    const total = width * height;
    const plain = Buffer.alloc(total * 4);
    let state = 20250514;
    for (let i = 0; i < plain.length; i++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        plain[i] = (state >> 16) & 0xff;
    }
    const offset = defaultOffset(total);
    check('测试尺寸的默认偏移量不为 0（避免恒等置换导致假通过）', offset % total !== 0, `offset=${offset}`);

    // 参考实现：dst[(i + offset) % total] = src[i]
    const expected = Buffer.alloc(plain.length);
    {
        const curve = gilbert2d(width, height);
        for (let i = 0; i < total; i++) {
            const [sx, sy] = curve[i];
            const [dx, dy] = curve[(i + offset) % total];
            const s = (sy * width + sx) * 4;
            const d = (dy * width + dx) * 4;
            expected[d] = plain[s];
            expected[d + 1] = plain[s + 1];
            expected[d + 2] = plain[s + 2];
            expected[d + 3] = plain[s + 3];
        }
    }

    // 传给 worker 的是可转移的 ArrayBuffer（浏览器语义），这里用副本模拟
    const imgData = { data: new Uint8ClampedArray(plain) };
    const reply = await callWorker({ imgData, width, height, offset, isEncrypt: true });
    check('worker 返回 result 消息', reply && reply.type === 'result', JSON.stringify(reply));
    if (reply && reply.type === 'result') {
        check(`worker ${width}x${height} 加密输出与参考实现逐字节一致`,
            Buffer.compare(Buffer.from(reply.buffer), expected) === 0);
    }

    // 2.2 解密往返
    const back = await callWorker({
        imgData: { data: new Uint8ClampedArray(reply.buffer.slice(0)) },
        width,
        height,
        offset,
        isEncrypt: false,
    });
    check('worker 解密返回 result', back && back.type === 'result');
    if (back && back.type === 'result') {
        check('解密结果与原始像素逐字节一致',
            Buffer.compare(Buffer.from(back.buffer), plain) === 0);
    }

    // 2.3 非法入参必须走 error 分支且不抛异常
    const bad1 = await callWorker({ imgData: null, width: 10, height: 10, offset: 1, isEncrypt: true });
    check('缺少图像数据时报 error', bad1 && bad1.type === 'error');

    const bad2 = await callWorker({
        imgData: { data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 },
        width: 0,
        height: 4,
        offset: 1,
        isEncrypt: true,
    });
    check('尺寸非法时报 error', bad2 && bad2.type === 'error');

    const tooBig = await callWorker({
        imgData: { data: new Uint8ClampedArray(4) },
        width: 5000,
        height: 5000,
        offset: 1,
        isEncrypt: true,
    });
    check('超大图片给出可读的 error 而不是崩溃', tooBig && tooBig.type === 'error' && /过大/.test(tooBig.message));

    const badLen = await callWorker({
        imgData: { data: new Uint8ClampedArray(4 * 4 * 4 - 1), width: 4, height: 4 },
        width: 4,
        height: 4,
        offset: 1,
        isEncrypt: true,
    });
    check('缓冲区长度不符时报 error', badLen && badLen.type === 'error');
}

// ---------------------------------------------------------------- 汇总

console.log(`共 ${checks} 项检查，失败 ${failures} 项`);
if (failures) {
    for (const d of details) console.log(`  ✗ ${d}`);
    process.exit(1);
}
console.log('Web 端契约与 worker 往返验证通过 ✅');
