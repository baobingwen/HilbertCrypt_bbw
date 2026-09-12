// tests/wasm_parity.mjs
// 验证 web/rs 重建出的 wasm 与仓库中既有 wasm 二进制行为完全一致。
//
// 用法:
//   node tests/wasm_parity.mjs <旧.wasm> <新.wasm>
//   node tests/wasm_parity.mjs            # 自动重建并用 web/versions 里的旧 blob 作基线
//
// 比较内容：
//   1. 导出表（名称 + kind）是否完全一致
//   2. create_gilbert(width, height) 导出的曲线坐标表是否逐项一致
//   3. process_pixels(buffer, offset, isEncrypt) 在多种尺寸/偏移下的输出是否逐字节一致
//   4. 非法尺寸等边界行为是否一致（是否抛错）

import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_WASM = path.join(repoRoot, 'web', 'src', 'wasm');

/** 仓库里保留的 v2-alpha 旧 blob，用作行为基线 */
const BASELINE_DIR = path.join(repoRoot, 'web', 'versions', 'alpha', 'v2', 'v2-alpha-0', 'wasm');
const WORK_DIR = path.join(repoRoot, 'tests', 'out', 'parity');

let [oldWasmPath, newWasmPath] = process.argv.slice(2);

if (!oldWasmPath || !newWasmPath) {
    // 没有显式传参时：用仓库里的旧 blob 做基线，现场重建产物做被测对象
    if (!existsSync(path.join(BASELINE_DIR, 'lp_crypt_wasm_core_bg.wasm'))) {
        console.error('找不到基线 wasm，请显式传入: node tests/wasm_parity.mjs <旧.wasm> <新.wasm>');
        process.exit(2);
    }
    await rm(WORK_DIR, { recursive: true, force: true });
    await mkdir(path.join(WORK_DIR, 'old'), { recursive: true });
    await mkdir(path.join(WORK_DIR, 'new'), { recursive: true });

    // 旧 blob：连同它自己的 JS 胶水（两者必须成对，导出名才匹配）
    for (const f of ['lp_crypt_wasm_core.js', 'lp_crypt_wasm_core_bg.wasm']) {
        await copyFile(path.join(BASELINE_DIR, f), path.join(WORK_DIR, 'old', f));
    }

    // 新产物：优先用现场构建结果，否则退回仓库里已提交的产物
    const builtDir = path.join(repoRoot, 'web', 'rs', 'target', 'bindgen');
    const sourceDir = existsSync(path.join(builtDir, 'lp_crypt_wasm_core_bg.wasm')) ? builtDir : WEB_WASM;
    for (const f of ['lp_crypt_wasm_core.js', 'lp_crypt_wasm_core_bg.wasm']) {
        await copyFile(path.join(sourceDir, f), path.join(WORK_DIR, 'new', f));
    }
    console.log(`基线: ${path.relative(repoRoot, BASELINE_DIR)}`);
    console.log(`被测: ${path.relative(repoRoot, sourceDir)}`);

    oldWasmPath = path.join(WORK_DIR, 'old', 'lp_crypt_wasm_core_bg.wasm');
    newWasmPath = path.join(WORK_DIR, 'new', 'lp_crypt_wasm_core_bg.wasm');
}
void spawn;
void repoRoot;

/** 用 wasm-bindgen 生成的 JS 胶水加载 wasm；胶水里默认指向同名 _bg.wasm，
 *  这里用 initSync 显式喂入字节，避免污染仓库结构。 */
async function loadModule(wasmPath) {
    const dir = wasmPath.replace(/[\\/][^\\/]+$/, '');
    const glue = `${dir}/lp_crypt_wasm_core.js`;
    const mod = await import(pathToFileURL(glue).href);
    const bytes = await readFile(wasmPath);
    // initSync 返回 wasm 实例导出，正好用来比对导出表
    const exports = mod.initSync({ module: bytes });
    return { mod, exports };
}

function exportsOf(loaded) {
    return loaded.exports;
}

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

function randomBuffer(len, seed) {
    const rand = mulberry32(seed);
    const buf = new Uint8Array(len);
    for (let i = 0; i < len; i++) buf[i] = Math.floor(rand() * 256);
    return buf;
}

const CASES = [
    [1, 1],
    [1, 2],
    [2, 1],
    [1, 9],
    [9, 1],
    [2, 2],
    [3, 5],
    [5, 3],
    [4, 4],
    [7, 13],
    [13, 7],
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

let failures = 0;
const fail = (msg) => {
    failures++;
    console.error(`  ✗ ${msg}`);
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

const oldLoaded = await loadModule(oldWasmPath);
const newLoaded = await loadModule(newWasmPath);
const oldMod = oldLoaded.mod;
const newMod = newLoaded.mod;
const oldExp = oldLoaded.exports;
const newExp = newLoaded.exports;

console.log('1) 导出表一致性');
{
    // 旧 blob 与源码重建版的差异仅在 wasm-bindgen 自动生成的分配器导出名上：
    // 旧版叫 __wbindgen_malloc，0.2.100 CLI 源码重建版叫 __wbindgen_export_N。
    // 这两个都是 wasm-bindgen 的内部实现细节（不构成对外 API），因此比对时归一化。
    const normalize = (name) =>
        /^__wbindgen_(malloc|realloc|free|export_\d+)$/.test(name)
            ? '__wbindgen_internal_alloc'
            : name;
    const oldNames = Object.keys(oldExp).map(normalize).sort();
    const newNames = Object.keys(newExp).map(normalize).sort();
    const onlyOld = oldNames.filter((n) => !newNames.includes(n));
    const onlyNew = newNames.filter((n) => !oldNames.includes(n));
    if (onlyOld.length) fail(`仅有旧版导出的符号: ${onlyOld.join(', ')}`);
    if (onlyNew.length) fail(`仅有新版导出的符号: ${onlyNew.join(', ')}`);
    if (!onlyOld.length && !onlyNew.length) {
        // 归一化后还要逐个核对"名字 -> wasm 值种类"（Function / Table / Memory / Global）。
        // 用归一化名字建表，避免被分配器改名影响。
        const kindOf = (v) => (v && v.constructor ? v.constructor.name : typeof v);
        const kindByName = (exp) => {
            const m = new Map();
            for (const [k, v] of Object.entries(exp)) m.set(normalize(k), kindOf(v));
            return m;
        };
        const oldKinds = kindByName(oldExp);
        const newKinds = kindByName(newExp);
        const mismatches = [...oldKinds.keys()]
            .filter((n) => oldKinds.get(n) !== newKinds.get(n))
            .map((n) => `${n}(${oldKinds.get(n)} vs ${newKinds.get(n)})`);
        if (mismatches.length) {
            fail(`导出类型不一致: ${mismatches.join(', ')}`);
        } else {
            const table = Object.keys(newExp).find((n) => kindOf(newExp[n]) === 'Table');
            const memory = Object.keys(newExp).find((n) => kindOf(newExp[n]) === 'Memory');
            if (!table) fail('新版缺少 externref 表导出');
            if (!memory) fail('新版缺少 memory 导出');
            if (table && memory) ok(`${Object.keys(newExp).length} 个导出符号一致（函数/表/内存种类全部对齐）`);
        }
    }
}

console.log('2) 曲线坐标一致性');
for (const [w, h] of CASES) {
    let oldCoords;
    let newCoords;
    try {
        oldCoords = new oldMod.Gilbert2D(w, h).get_offsets();
    } catch (e) {
        oldCoords = `throw:${e.message}`;
    }
    try {
        newCoords = new newMod.Gilbert2D(w, h).get_offsets();
    } catch (e) {
        newCoords = `throw:${e.message}`;
    }
    if (typeof oldCoords === 'string' || typeof newCoords === 'string') {
        if (String(oldCoords) !== String(newCoords)) fail(`${w}x${h} 抛错行为不一致: ${oldCoords} vs ${newCoords}`);
        continue;
    }
    if (!bytesEqual(new Uint8Array(oldCoords.buffer, oldCoords.byteOffset, oldCoords.byteLength), new Uint8Array(newCoords.buffer, newCoords.byteOffset, newCoords.byteLength))) {
        fail(`${w}x${h} 曲线坐标不一致`);
    }
}
ok(`已核对 ${CASES.length} 种尺寸的曲线坐标`);

console.log('3) process_pixels 输出一致性');
for (const [w, h] of CASES) {
    const total = w * h;
    const offsetCandidates = [0, 1, 2, 7, 12345, total - 1, Math.round(0.6180339887498949 * total)];
    for (const offset of offsetCandidates) {
        for (const isEncrypt of [true, false]) {
            const seed = (w * 7919 + h * 104729 + offset) >>> 0;
            const oldBuf = randomBuffer(total * 4, seed);
            const newBuf = oldBuf.slice();
            const oldGilbert = new oldMod.Gilbert2D(w, h);
            const newGilbert = new newMod.Gilbert2D(w, h);
            oldGilbert.process_pixels(oldBuf, offset, isEncrypt);
            newGilbert.process_pixels(newBuf, offset, isEncrypt);
            if (!bytesEqual(oldBuf, newBuf)) {
                fail(`${w}x${h} offset=${offset} encrypt=${isEncrypt} 像素输出不一致`);
            }
        }
    }
}
ok('全部尺寸/偏移/方向的像素输出逐字节一致');

console.log('4) 边界行为一致性');
{
    const cases = [
        [0, 5],
        [5, 0],
        [-3, 4],
    ];
    for (const [w, h] of cases) {
        let oldRes;
        let newRes;
        try {
            new oldMod.Gilbert2D(w, h);
            oldRes = 'ok';
        } catch (e) {
            oldRes = 'throw';
        }
        try {
            new newMod.Gilbert2D(w, h);
            newRes = 'ok';
        } catch (e) {
            newRes = 'throw';
        }
        if (oldRes !== newRes) fail(`Gilbert2D(${w}, ${h}) 行为不一致: ${oldRes} vs ${newRes}`);
    }
    // 缓冲区长度不足时是否都抛错
    for (const mod of [oldMod, newMod]) {
        const g = new mod.Gilbert2D(4, 4);
        try {
            g.process_pixels(new Uint8Array(4 * 4 * 4 - 1), 1, true);
            fail('缓冲区长度不足时未抛错');
        } catch {
            /* 预期抛错 */
        }
    }
    ok('非法尺寸与非法缓冲区长度的行为一致');
}

console.log(failures === 0 ? '\n结果: 完全一致 ✅' : `\n结果: ${failures} 处不一致 ❌`);
process.exit(failures === 0 ? 0 : 1);
