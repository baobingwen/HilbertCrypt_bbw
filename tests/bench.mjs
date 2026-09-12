// tests/bench.mjs
// 性能基线：对同一批图片分别用 C++（原地 / 另开缓冲区）、Rust(WASM)、Python 跑混淆，
// 记录耗时，用来回答"原地置换到底省不省事"以及"各端差距多大"。
//
// 用法: node tests/bench.mjs [--cpp-only] [--json]

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(repoRoot, 'tests', 'out', 'bench');
const CPP_EXE = process.env.CPP_EXE ?? path.join(repoRoot, 'Cpp', 'bin', 'hilbert_encrypt.exe');
const PY_EXE = process.env.PY_EXE ?? 'python';
const PY_CLI = path.join(repoRoot, 'Python', 'src', 'cli.py');
const WASM_GLUE = path.join(repoRoot, 'web', 'src', 'wasm', 'lp_crypt_wasm_core.js');
const WASM_BIN = path.join(repoRoot, 'web', 'src', 'wasm', 'lp_crypt_wasm_core_bg.wasm');

const SIZES = [
    [1024, 768],
    [1382, 924],
    [1920, 1080],
    [4000, 3000],
];

const json = process.argv.includes('--json');
const cppOnly = process.argv.includes('--cpp-only');

function run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd: opts.cwd ?? repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
        child.on('close', (code) => resolve({ code, out, err }));
    });
}

async function makeImage(file, width, height) {
    const script = [
        'import sys, numpy as np',
        'from PIL import Image',
        'w, h, path = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]',
        'rng = np.random.default_rng(4)',
        'Image.fromarray(rng.integers(0, 256, (h, w, 4), dtype=np.uint8), "RGBA").save(path)',
    ].join('\n');
    const res = await run(PY_EXE, ['-c', script, String(width), String(height), file]);
    if (res.code !== 0) throw new Error(`生成测试图失败: ${res.err}`);
}

/** 在 worker 里加载 wasm 并计时，避免多个 wasm 实例互相污染（glue 是模块级单例） */
function benchWasm(width, height) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(
            `
            import { parentPort, workerData } from 'node:worker_threads';
            import { readFile } from 'node:fs/promises';
            const mod = await import(workerData.glue);
            const bytes = await readFile(workerData.bin);
            const t0 = performance.now();
            mod.initSync({ module: bytes });
            const t1 = performance.now();
            const g = new mod.Gilbert2D(workerData.width, workerData.height);
            const t2 = performance.now();
            const buf = new Uint8Array(workerData.width * workerData.height * 4);
            g.process_pixels(buf, workerData.offset, true);
            const t3 = performance.now();
            g.free();
            parentPort.postMessage({ init: t1 - t0, curve: t2 - t1, permute: t3 - t2 });
            `,
            {
                eval: true,
                type: 'module',
                workerData: {
                    glue: pathToFileURL(WASM_GLUE).href,
                    bin: WASM_BIN,
                    width,
                    height,
                    offset: Math.round(0.6180339887498949 * width * height),
                },
            },
        );
        worker.on('message', (m) => {
            worker.terminate();
            resolve(m);
        });
        worker.on('error', reject);
    });
}

await mkdir(OUT, { recursive: true });
const rows = [];

for (const [width, height] of SIZES) {
    const megapixels = (width * height) / 1e6;
    const row = { size: `${width}x${height}`, megapixels: Number(megapixels.toFixed(2)) };

    // ---- C++ ----
    if (existsSync(CPP_EXE)) {
        for (const mode of ['in-place', 'out-of-place']) {
            const dir = path.join(OUT, `${width}x${height}-${mode}`);
            await rm(dir, { recursive: true, force: true });
            await mkdir(path.join(dir, 'files'), { recursive: true });
            const file = path.join(dir, 'files', 'bench.png');
            await makeImage(file, width, height);

            const t0 = performance.now();
            const enc = await run(CPP_EXE, ['-e', '-q', `--${mode}`], dir);
            const elapsed = performance.now() - t0;
            if (enc.code !== 0) {
                row[`cpp_${mode}`] = null;
                continue;
            }
            // 整体墙钟时间（含读盘与写盘），同一进程模型下两种实现可直接比较
            row[`cpp_${mode}`] = Number((elapsed / 1000).toFixed(3));
            row[`cpp_${mode}_mb`] = Number(((await readFile(file)).length / 1e6).toFixed(2));
        }
    }

    // ---- Rust/WASM ----
    if (!cppOnly && existsSync(WASM_GLUE)) {
        const r = await benchWasm(width, height);
        row.wasm_init = Number(r.init.toFixed(1));
        row.wasm_curve = Number(r.curve.toFixed(1));
        row.wasm_permute = Number(r.permute.toFixed(1));
    }

    // ---- Python（只跑中小尺寸）----
    if (!cppOnly && megapixels <= 1.3) {
        const dir = path.join(OUT, `${width}x${height}-python`);
        await rm(dir, { recursive: true, force: true });
        await mkdir(path.join(dir, 'files'), { recursive: true });
        await makeImage(path.join(dir, 'files', 'bench.png'), width, height);
        const t0 = performance.now();
        const enc = await run(PY_EXE, [PY_CLI, '--folder', path.join(dir, 'files'), '-m', 'encrypt']);
        row.python = enc.code === 0 ? Number(((performance.now() - t0) / 1000).toFixed(3)) : null;
    }

    rows.push(row);
}

if (json) {
    console.log(JSON.stringify(rows, null, 2));
} else {
    console.log('\n说明：C++ 为整体墙钟时间（含读盘/写盘），WASM 为进程内毫秒，Python 为整体墙钟时间。\n');
    for (const r of rows) {
        console.log(`■ ${r.size}  (${r.megapixels} MP)`);
        if (r.cpp_in_place != null) console.log(`    C++ 原地      ${r.cpp_in_place}s`);
        if (r.cpp_out_of_place != null) console.log(`    C++ 另开缓冲  ${r.cpp_out_of_place}s`);
        if (r.wasm_permute != null) {
            console.log(`    WASM 初始化   ${r.wasm_init} ms`);
            console.log(`    WASM 建曲线   ${r.wasm_curve} ms`);
            console.log(`    WASM 置换     ${r.wasm_permute} ms`);
        }
        if (r.python != null) console.log(`    Python        ${r.python}s`);
        console.log('');
    }
}
