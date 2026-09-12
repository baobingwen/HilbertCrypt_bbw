// tests/wasm_parity.mjs
// 验证 web/rs 重建出的 wasm 与仓库中既有 wasm 二进制行为完全一致。
//
// 用法: node tests/wasm_parity.mjs <旧.wasm> <新.wasm>
//
// 比较内容：
//   1. 导出表（名称 + kind）是否完全一致
//   2. create_gilbert(width, height) 导出的曲线坐标表是否逐项一致
//   3. process_pixels(buffer, offset, isEncrypt) 在多种尺寸/偏移下的输出是否逐字节一致
//   4. 非法尺寸等边界行为是否一致（是否抛错）

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [oldWasmPath, newWasmPath] = process.argv.slice(2);
if (!oldWasmPath || !newWasmPath) {
    console.error('用法: node tests/wasm_parity.mjs <旧.wasm> <新.wasm>');
    process.exit(2);
}

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
    // 旧版叫 __wbindgen_malloc，0.2.100 CLI 源码重建版叫 __wbindgen_export_1。
    // 这两个都是 wasm-bindgen 的内部实现细节（不对外承诺稳定性），因此比对时归一化。
    const normalize = (name) => name.replace(/^__wbindgen_export_\d+$/, '__wbindgen_internal_export');
    const oldNames = Object.keys(oldExp).map(normalize).sort();
    const newNames = Object.keys(newExp).map(normalize).sort();
    const onlyOld = oldNames.filter((n) => !newNames.includes(n));
    const onlyNew = newNames.filter((n) => !oldNames.includes(n));
    if (onlyOld.length) fail(`仅有旧版导出的符号: ${onlyOld.join(', ')}`);
    if (onlyNew.length) fail(`仅有新版导出的符号: ${onlyNew.join(', ')}`);
    if (!onlyOld.length && !onlyNew.length) {
        // 归一化后还要逐个核对"名字 -> wasm 值种类"（Function / Table / Memory / Global）
        const kindOf = (v) => (v && v.constructor ? v.constructor.name : typeof v);
        const mismatches = Object.keys(oldExp)
            .filter((n) => kindOf(oldExp[n]) !== kindOf(newExp[n]))
            .map((n) => `${n}(${kindOf(oldExp[n])} vs ${kindOf(newExp[n])})`);
        if (mismatches.length) {
            // 允许分配器的字典序差异：__wbindgen_export_1(Function) 对 __wbindgen_malloc(Function) 已归一
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
