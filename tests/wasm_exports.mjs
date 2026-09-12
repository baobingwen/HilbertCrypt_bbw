// tests/wasm_exports.mjs — 打印一个 wasm 模块的全部导出
import { readFile } from 'node:fs/promises';

for (const p of process.argv.slice(2)) {
    const bytes = await readFile(p);
    const { instance } = await WebAssembly.instantiate(bytes, {
        wbg: new Proxy({}, { get: () => () => 0 }),
    }).catch(async (e) => {
        // 有导入时需要提供真实导入，这里退化为只解析导出段
        const mod = await WebAssembly.compile(bytes);
        return { instance: { exports: WebAssembly.Module.exports(mod).reduce((a, d) => ({ ...a, [d.name]: d.kind }), {}) } };
    });
    const names = Object.keys(instance.exports).sort();
    console.log(`\n=== ${p} (${bytes.length} bytes, ${names.length} exports) ===`);
    for (const n of names) {
        const v = instance.exports[n];
        console.log(`  ${n} :: ${v && v.constructor ? v.constructor.name : typeof v}`);
    }
}
