// tests/cross_language.test.mjs
// 跨语言等价性测试：Node 参考实现 / Rust(WASM) / C++ / Python 必须逐字节一致。
//
// 用法:
//   node tests/cross_language.test.mjs                 # 全部语言（缺失的自动跳过）
//   node tests/cross_language.test.mjs --no-cpp        # 跳过 C++
//   node tests/cross_language.test.mjs --langs=cpp,py  # 只跑指定语言
//
// 退出码非 0 表示存在不一致。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { gilbert2d, defaultOffset, permutationSourceIndices } from './gilbert_reference.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WASM_DIR = path.join(repoRoot, 'web', 'src', 'wasm');
const CPP_EXE = path.join(repoRoot, 'Cpp', 'bin', 'hilbert_encrypt.exe');
const PY_MODULE = path.join(repoRoot, 'Python', 'src', 'gilbert_compat.py');

const argv = process.argv.slice(2);
const onlyLangs = (argv.find((a) => a.startsWith('--langs='))?.slice('--langs='.length) ?? '')
    .split(',')
    .filter(Boolean);
const langEnabled = (name) => (onlyLangs.length ? onlyLangs.includes(name) : !argv.includes(`--no-${name}`));

// ---------------------------------------------------------------- 工具函数

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function payloadFor(width, height, seed) {
    const rand = mulberry32(seed >>> 0);
    const buf = Buffer.alloc(width * height * 4);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(rand() * 256);
    return buf;
}

function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/** 起一个子进程，把 payload 写到 stdin，收集 stdout 二进制 */
function runChild(cmd, args, payload) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            cwd: repoRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
        });
        const out = [];
        const err = [];
        child.stdout.on('data', (d) => out.push(d));
        child.stderr.on('data', (d) => err.push(d));
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`${cmd} 退出码 ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 500)}`));
                return;
            }
            resolve(Buffer.concat(out));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(payload);
    });
}

// ---------------------------------------------------------------- 各语言后端

/** Node 参考实现（纯 JS，无 wasm） */
const referenceBackend = {
    name: 'node-ref',
    available: true,
    curve(width, height) {
        return gilbert2d(width, height);
    },
    permute(payload, width, height, offset, encrypt) {
        const total = width * height;
        const src = permutationSourceIndices(total, offset, encrypt);
        const curve = gilbert2d(width, height);
        const out = Buffer.alloc(payload.length);
        for (let i = 0; i < total; i++) {
            const [sx, sy] = curve[src[i]];
            const [dx, dy] = curve[i];
            const s = (sy * width + sx) * 4;
            const d = (dy * width + dx) * 4;
            out[d] = payload[s];
            out[d + 1] = payload[s + 1];
            out[d + 2] = payload[s + 2];
            out[d + 3] = payload[s + 3];
        }
        return out;
    },
};

/** Rust/WASM（web/src/wasm 下的产物） */
async function makeWasmBackend() {
    const gluePath = path.join(WASM_DIR, 'lp_crypt_wasm_core.js');
    const wasmPath = path.join(WASM_DIR, 'lp_crypt_wasm_core_bg.wasm');
    if (!existsSync(gluePath) || !existsSync(wasmPath)) {
        return { name: 'rust-wasm', available: false, reason: '缺少 web/src/wasm 产物' };
    }
    const mod = await import(pathToFileURL(gluePath).href);
    mod.initSync({ module: await readFile(wasmPath) });
    return {
        name: 'rust-wasm',
        available: true,
        curve(width, height) {
            const g = new mod.Gilbert2D(width, height);
            const offsets = g.get_offsets(); // 曲线坐标 -> 线性像素索引
            const total = width * height;
            const curve = new Array(total);
            for (let i = 0; i < total; i++) {
                const idx = offsets[i];
                curve[i] = [idx % width, Math.floor(idx / width)];
            }
            g.free();
            return curve;
        },
        permute(payload, width, height, offset, encrypt) {
            const g = new mod.Gilbert2D(width, height);
            const buf = new Uint8Array(payload);
            g.process_pixels(buf, offset, encrypt);
            g.free();
            return Buffer.from(buf);
        },
    };
}

/** C++ CLI 的原始通路 */
function makeCppBackend() {
    if (!existsSync(CPP_EXE)) {
        return { name: 'cpp', available: false, reason: `未编译: ${path.relative(repoRoot, CPP_EXE)}` };
    }
    return {
        name: 'cpp',
        available: true,
        // C++ 通路只导出像素置换结果（曲线由 Rust/WASM、参考实现、Python 三方交叉覆盖）
        curve: null,
        permute(payload, width, height, offset, encrypt) {
            const op = encrypt ? '--stdin-encrypt' : '--stdin-decrypt';
            return runChild(
                CPP_EXE,
                [op, String(width), String(height), String(width * height), String(offset)],
                payload,
            );
        },
    };
}

/** Python */
function makePythonBackend() {
    return {
        name: 'python',
        available: true,
        async request(task, payload) {
            const header = Buffer.from(`${JSON.stringify(task)}\n`, 'utf8');
            return runChild('python', [PY_MODULE], Buffer.concat([header, payload]));
        },
        async curve(width, height) {
            const res = await this.request({ op: 'curve', width, height }, Buffer.alloc(0));
            return JSON.parse(res.toString('utf8'));
        },
        permute(payload, width, height, offset, encrypt) {
            return this.request({ op: 'permute', width, height, offset, encrypt }, payload);
        },
    };
}

// ---------------------------------------------------------------- 测试矩阵

// 曲线一致性：覆盖 1×1、单行单列、长条、素数尺寸、正方形、大图
const CURVE_CASES = [
    [1, 1],
    [1, 7],
    [7, 1],
    [2, 2],
    [3, 5],
    [5, 3],
    [4, 4],
    [13, 7],
    [7, 13],
    [16, 16],
    [31, 17],
    [64, 64],
    [100, 37],
    [37, 100],
    [137, 63],
    [256, 256],
    [320, 200],
    [1382, 924],
];
/** 纯 Python 版曲线生成 + JSON 序列化在超大尺寸上太慢，超过则跳过 */
const PYTHON_CURVE_LIMIT = 320 * 200;

// 像素置换一致性：Python/C++ 都是逐像素循环，大图全量跑太慢，因此分档
const PERMUTE_CASES_COMMON = [
    [1, 1],
    [1, 7],
    [2, 2],
    [3, 5],
    [5, 3],
    [13, 7],
    [31, 17],
    [64, 64],
    [100, 37],
];
const PERMUTE_CASES_LARGE = [
    [137, 63],
    [256, 256],
    [320, 200],
    [1382, 924],
];
// 这些尺寸只跑"默认偏移量"一档，避免把测试拖成分钟级
const LARGE_THRESHOLD = 64 * 64;
/** 纯 Python 逐像素循环，超过这个规模就跳过（曲线一致性仍然验证） */
const PYTHON_PIXEL_LIMIT = 64 * 64;

// ---------------------------------------------------------------- 执行

let checks = 0;
let failures = 0;
const failureDetails = [];

function check(label, ok, detail = '') {
    checks++;
    if (ok) return;
    failures++;
    failureDetails.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

function offsetList(total) {
    const list = [0, 1, 2, 7, defaultOffset(total)];
    if (total > 1) list.push(total - 1);
    return [...new Set(list)];
}

const backends = [referenceBackend, makeCppBackend(), makePythonBackend()];
if (langEnabled('wasm')) {
    backends.push(await makeWasmBackend());
}

console.log('语言可用性：');
for (const b of backends) {
    console.log(`  ${b.available ? '✓' : '○'} ${b.name}${b.available ? '' : `  (${b.reason})`}`);
}

// 1) 曲线一致性
console.log('\n[1] 曲线坐标一致性');
for (const backend of backends) {
    if (!backend.available || !backend.curve) continue;
    for (const [w, h] of CURVE_CASES) {
        if (backend.name === 'python' && w * h > PYTHON_CURVE_LIMIT) continue;
        let actual;
        try {
            actual = await backend.curve(w, h);
        } catch (e) {
            check(`${backend.name} ${w}x${h} 曲线`, false, e.message);
            continue;
        }
        if (!actual) continue;
        const expected = gilbert2d(w, h);
        if (actual.length !== expected.length) {
            check(`${backend.name} ${w}x${h} 曲线长度`, false, `${actual.length} != ${expected.length}`);
            continue;
        }
        let bad = -1;
        for (let i = 0; i < expected.length; i++) {
            if (actual[i][0] !== expected[i][0] || actual[i][1] !== expected[i][1]) {
                bad = i;
                break;
            }
        }
        check(`${backend.name} ${w}x${h} 曲线`, bad === -1, bad === -1 ? '' : `第 ${bad} 个点不同`);
    }
}
console.log(`  已核对 ${CURVE_CASES.length} 种尺寸 × ${backends.filter((b) => b.available && b.curve).length} 个后端`);

// 2) 像素置换一致性
console.log('\n[2] 像素置换一致性（加密 + 解密往返）');
const permuteBackends = backends.filter((b) => b.available && b.permute);
for (const [w, h] of [...PERMUTE_CASES_COMMON, ...PERMUTE_CASES_LARGE]) {
    const total = w * h;
    const large = total > LARGE_THRESHOLD;
    const seed = (w * 7919 + h * 104729) >>> 0;
    const payload = payloadFor(w, h, seed);
    const offsets = large ? [defaultOffset(total)] : offsetList(total);

    for (const offset of offsets) {
        // 参考实现同时给出"标准答案"，避免各后端互相比较而掩盖共同错误
        const expected = referenceBackend.permute(payload, w, h, offset, true);

        for (const backend of permuteBackends) {
            if (backend.name === 'python' && total > PYTHON_PIXEL_LIMIT) continue;

            let actual;
            try {
                actual = await backend.permute(payload, w, h, offset, true);
            } catch (e) {
                check(`${backend.name} ${w}x${h} offset=${offset} 加密`, false, e.message);
                continue;
            }
            check(
                `${backend.name} ${w}x${h} offset=${offset} 加密`,
                sameBytes(actual, expected),
                '与参考实现不一致',
            );

            // 解密必须还原
            let restored;
            try {
                restored = await backend.permute(actual, w, h, offset, false);
            } catch (e) {
                check(`${backend.name} ${w}x${h} offset=${offset} 解密`, false, e.message);
                continue;
            }
            check(
                `${backend.name} ${w}x${h} offset=${offset} 往返还原`,
                sameBytes(restored, payload),
                '解密结果与原始数据不符',
            );
        }
    }
}
console.log(`  已核对 ${PERMUTE_CASES_COMMON.length + PERMUTE_CASES_LARGE.length} 种尺寸 × ${permuteBackends.length} 个后端`);

// ---------------------------------------------------------------- 汇总

console.log(`\n共 ${checks} 项检查，失败 ${failures} 项`);
if (failures) {
    for (const d of failureDetails.slice(0, 40)) console.log(`  ✗ ${d}`);
    if (failureDetails.length > 40) console.log(`  ... 另有 ${failureDetails.length - 40} 项`);
    process.exit(1);
}
console.log('跨语言等价性验证通过 ✅');
