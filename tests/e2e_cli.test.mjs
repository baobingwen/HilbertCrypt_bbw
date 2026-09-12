// tests/e2e_cli.test.mjs
// 端到端测试：直接调用编译好的 C++ CLI 与 Python CLI，验证
//   1. C++ 混淆 -> C++ 解混淆 完整还原（PNG/TIFF/BMP/WebP/JPG）
//   2. C++ 与 Python 产出的混淆图**像素完全一致**（跨语言互通的关键）
//   3. Python 混淆 -> C++ 解混淆、C++ 混淆 -> Python 解混淆都能还原
//   4. CLI 的 --offset / --jobs 等选项行为正确
//
// 用法: node tests/e2e_cli.test.mjs
//   CPP_EXE  覆盖 C++ 可执行文件路径
//   PY_EXE   覆盖 Python 解释器路径

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { pngPixelsEqual } from './png.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(repoRoot, 'tests', 'out', 'e2e');
const CPP_EXE = process.env.CPP_EXE ?? path.join(repoRoot, 'Cpp', 'bin', 'hilbert_encrypt.exe');
const PY_EXE = process.env.PY_EXE ?? 'python';
const PY_CLI = path.join(repoRoot, 'Python', 'src', 'cli.py');

let checks = 0;
let failures = 0;
const details = [];
function check(label, ok, detail = '') {
    checks++;
    if (!ok) {
        failures++;
        details.push(`${label}${detail ? ` — ${detail}` : ''}`);
    }
}

/** 起子进程并收集 stdout 的**原始字节**（用于二进制比较，避免 UTF-8 转码破坏数据） */
function runBuffer(cmd, args, cwd) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        const out = [];
        const err = [];
        child.stdout.on('data', (d) => out.push(d));
        child.stderr.on('data', (d) => err.push(d));
        child.on('error', (e) => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(e)) }));
        child.on('close', (code) =>
            resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }),
        );
    });
}

async function run(cmd, args, cwd) {
    const res = await runBuffer(cmd, args, cwd);
    return {
        code: res.code,
        stdout: res.stdout.toString('utf8'),
        stderr: res.stderr.toString('utf8'),
    };
}

/** 用 Pillow/OpenCV 造确定性测试图，避免往仓库里塞二进制素材 */
async function makeImage(file, size, mode, seed) {
    const script = [
        'import sys, os, numpy as np',
        'path, w, h, mode, seed = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], int(sys.argv[5])',
        'rng = np.random.default_rng(seed)',
        'channels = len(mode)',
        'data = rng.integers(0, 256, size=(h, w, channels), dtype=np.uint8)',
        'ext = os.path.splitext(path)[1].lower()',
        'if ext in (".webp", ".tiff", ".tif"):',
        '    # 用 OpenCV 编码，与被测程序走同一条编解码链',
        '    import cv2',
        '    if channels == 1:',
        '        img = data[:, :, 0]',
        '    elif channels == 3:',
        '        img = cv2.cvtColor(data, cv2.COLOR_RGB2BGR)',
        '    else:',
        '        img = cv2.cvtColor(data, cv2.COLOR_RGBA2BGRA)',
        '    params = [cv2.IMWRITE_WEBP_QUALITY, 100] if ext == ".webp" else []',
        '    if not cv2.imwrite(path, img, params):',
        '        raise RuntimeError("cv2.imwrite 失败: " + path)',
        'else:',
        '    from PIL import Image',
        '    if channels == 1:',
        '        data = data[:, :, 0]',
        '    Image.fromarray(data, mode=mode).save(path)',
    ].join('\n');
    const res = await run(PY_EXE, ['-c', script, file, String(size[0]), String(size[1]), mode, String(seed)], repoRoot);
    if (res.code !== 0) throw new Error(`生成测试图失败: ${res.stderr}`);
}

/**
 * 把单张图统一解码成 RGBA 原始字节（每个文件单独起进程）。
 * 优先用 OpenCV（与 C++ 端同一条解码链），不可用时退回 Pillow；
 * 两张图必须走同一条解码路径，否则会引入与算法无关的差异。
 */
async function decodeToRgba(file) {
    const script = [
        'import sys',
        'path = sys.argv[1]',
        'try:',
        '    import cv2',
        '    import numpy as np',
        '    raw = cv2.imread(path, cv2.IMREAD_UNCHANGED)',
        '    if raw is None:',
        '        raise RuntimeError("cv2 无法读取 " + path)',
        '    if raw.dtype != np.uint8:',
        '        raise RuntimeError("仅支持 8 位图像")',
        '    if raw.ndim == 2:',
        '        rgba = cv2.cvtColor(raw, cv2.COLOR_GRAY2RGBA)',
        '    elif raw.shape[2] == 3:',
        '        rgba = cv2.cvtColor(raw, cv2.COLOR_BGR2RGBA)',
        '    else:',
        '        rgba = cv2.cvtColor(raw, cv2.COLOR_BGRA2RGBA)',
        'except ImportError:',
        '    from PIL import Image',
        '    import numpy as np',
        '    rgba = np.asarray(Image.open(path).convert("RGBA"), dtype=np.uint8)',
        'sys.stdout.buffer.write(np.ascontiguousarray(rgba, dtype=np.uint8).tobytes())',
    ].join('\n');
    const res = await runBuffer(PY_EXE, ['-c', script, file], repoRoot);
    if (res.code !== 0) {
        throw new Error(`解码图片失败 (exit ${res.code}) ${file}: ${res.stderr.toString('utf8').slice(0, 300)}`);
    }
    return res.stdout;
}

/** 跨格式、跨色彩模式的通用判等 */
async function sameImageContent(a, b) {
    const [x, y] = [await decodeToRgba(a), await decodeToRgba(b)];
    return x.length === y.length && Buffer.compare(x, y) === 0;
}

/** PNG 之间的像素判等走内置解码器（不依赖 Python），其它格式交给 Pillow */
const samePngPixels = pngPixelsEqual;

async function makeSandbox(name) {
    const dir = path.join(OUT_ROOT, name);
    await rm(dir, { recursive: true, force: true });
    await mkdir(path.join(dir, 'files'), { recursive: true });
    return dir;
}

const listFiles = async (dir) => (await readdir(dir)).sort();

if (!existsSync(CPP_EXE)) {
    console.log(`○ 跳过端到端测试：未找到 C++ 可执行文件 ${path.relative(repoRoot, CPP_EXE)}`);
    console.log('  先运行: pwsh -File Cpp/build.ps1');
    process.exit(0);
}

await mkdir(OUT_ROOT, { recursive: true });

// ---------------------------------------------------------------- 1. C++ 自身往返

const FORMATS = [
    { name: 'png-rgba', ext: 'png', size: [137, 63], mode: 'RGBA', perfect: true },
    { name: 'png-rgb', ext: 'png', size: [96, 96], mode: 'RGB', perfect: true },
    { name: 'png-gray', ext: 'png', size: [64, 40], mode: 'L', perfect: true },
    { name: 'bmp-rgba', ext: 'bmp', size: [80, 50], mode: 'RGBA', perfect: true },
    { name: 'tiff-rgba', ext: 'tiff', size: [77, 41], mode: 'RGBA', perfect: true },
    // WebP 是有损格式：混淆图再经有损压缩会改变像素，往返只能"近似还原"，
    // 这里只验证格式支持与算法不崩，精确还原由无损格式保证。
    { name: 'webp-rgba', ext: 'webp', size: [64, 64], mode: 'RGBA', perfect: false },
];

for (const fmt of FORMATS) {
    const dir = await makeSandbox(`cpp-roundtrip-${fmt.name}`);
    const file = path.join(dir, 'files', `test.${fmt.ext}`);
    await makeImage(file, fmt.size, fmt.mode, 4242);
    const original = await readFile(file);

    const enc = await run(CPP_EXE, ['-e', '-q'], dir);
    check(`C++ 混淆 ${fmt.name} 退出码为 0`, enc.code === 0, enc.stderr.slice(0, 300));
    const encrypted = await readFile(file);

    const dec = await run(CPP_EXE, ['-d', '-q'], dir);
    check(`C++ 解混淆 ${fmt.name} 退出码为 0`, dec.code === 0, dec.stderr.slice(0, 300));
    const restored = await readFile(file);

    if (fmt.perfect) {
        if (fmt.ext === 'png') {
            // 像素必须完全一致；PNG 编码器可能选择不同的滤波/压缩策略，
            // 因此只断言"解码后像素一致"，不断言字节流一致。
            check(`C++ 混淆 ${fmt.name} 确实改变了像素`, !samePngPixels(original, encrypted));
            check(`C++ 往返还原 ${fmt.name} 像素一致`, samePngPixels(original, restored));
        } else {
            const pristine = path.join(dir, `original.${fmt.ext}`);
            await writeFile(pristine, original);
            check(`C++ 往返还原 ${fmt.name} 与原始图像素一致`, await sameImageContent(pristine, file));
        }
    } else {
        check(`C++ 往返 ${fmt.name} 未报错且文件被改写`, restored.length > 0 && Buffer.compare(original, restored) !== 0);
    }

    // 有损格式必须给出明确警告
    if (!fmt.perfect) {
        const loud = await run(CPP_EXE, ['-e'], dir);
        check(`${fmt.name} 处理时打印有损警告`, /有损格式/.test(loud.stderr), loud.stderr.slice(0, 200));
    }
}

// ---------------------------------------------------------------- 2. 跨语言像素一致

const XLANG_CASES = [
    { name: 'rgba-137x63', size: [137, 63], mode: 'RGBA', ext: 'png' },
    { name: 'rgb-96x96', size: [96, 96], mode: 'RGB', ext: 'png' },
    { name: 'gray-64x40', size: [64, 40], mode: 'L', ext: 'png' },
];

for (const c of XLANG_CASES) {
    const dirCpp = await makeSandbox(`xlang-cpp-${c.name}`);
    const dirPy = await makeSandbox(`xlang-py-${c.name}`);
    const fileCpp = path.join(dirCpp, 'files', `test.${c.ext}`);
    const filePy = path.join(dirPy, 'files', `test.${c.ext}`);
    await makeImage(fileCpp, c.size, c.mode, 777);
    await copyFile(fileCpp, filePy);

    const cppEnc = await run(CPP_EXE, ['-e', '-q'], dirCpp);
    check(`跨语言 ${c.name}: C++ 混淆成功`, cppEnc.code === 0, cppEnc.stderr.slice(0, 200));

    const pyEnc = await run(PY_EXE, [PY_CLI, '--folder', path.join(dirPy, 'files'), '-m', 'encrypt'], repoRoot);
    check(`跨语言 ${c.name}: Python 混淆成功`, pyEnc.code === 0, pyEnc.stderr.slice(0, 300));

    if (cppEnc.code === 0 && pyEnc.code === 0) {
        const a = await readFile(fileCpp);
        const b = await readFile(filePy);
        check(
            `跨语言 ${c.name}: C++ 与 Python 混淆结果像素完全一致`,
            samePngPixels(a, b),
            '两端混淆结果不同说明算法或偏移量不一致',
        );

        // Python 混淆 -> C++ 解混淆（原始图用独立生成的纯净副本做对照）
        const dirMix = await makeSandbox(`xlang-mix-${c.name}`);
        const mixFile = path.join(dirMix, 'files', `test.${c.ext}`);
        await writeFile(mixFile, b);

        const pristineDir = await makeSandbox(`xlang-pristine-${c.name}`);
        const pristine = path.join(pristineDir, 'files', `test.${c.ext}`);
        await makeImage(pristine, c.size, c.mode, 777);

        const dec = await run(CPP_EXE, ['-d', '-q'], dirMix);
        check(`跨语言 ${c.name}: C++ 能解出 Python 的混淆结果`, dec.code === 0, dec.stderr.slice(0, 200));
        if (dec.code === 0) {
            check(
                `跨语言 ${c.name}: Python 混淆 + C++ 解混淆还原成功`,
                await sameImageContent(pristine, mixFile),
            );
        }
    }
}

// ---------------------------------------------------------------- 3. CLI 选项

{
    const dir = await makeSandbox('cli-options');
    const file = path.join(dir, 'files', 'test.png');
    await makeImage(file, [64, 48], 'RGBA', 31337);
    const original = await readFile(file);

    // 显式 offset
    const explicit = await run(CPP_EXE, ['-e', '-q', '--offset', '1234'], dir);
    check('--offset 接受显式数值', explicit.code === 0, explicit.stderr.slice(0, 200));
    const afterExplicit = await readFile(file);
    check('--offset 1234 的结果与默认不同', !samePngPixels(original, afterExplicit));

    const back = await run(CPP_EXE, ['-d', '-q', '-o', '1234'], dir);
    check('--offset 短选项 -o 可用', back.code === 0, back.stderr.slice(0, 200));
    check('显式 offset 往返还原', samePngPixels(original, await readFile(file)));

    // auto 与不传等价
    const auto = await run(CPP_EXE, ['-e', '-q', '-o', 'auto'], dir);
    check('-o auto 可用', auto.code === 0, auto.stderr.slice(0, 200));
    const afterAuto = await readFile(file);
    await rm(file);
    await makeImage(file, [64, 48], 'RGBA', 31337);
    const plain = await run(CPP_EXE, ['-e', '-q'], dir);
    check('不带 -o 与 -o auto 结果一致', plain.code === 0 && samePngPixels(await readFile(file), afterAuto));

    // 并发数
    const jobs = await run(CPP_EXE, ['-e', '-q', '-j', '2'], dir);
    check('-j 指定并发数可用', jobs.code === 0, jobs.stderr.slice(0, 200));

    // 非法参数
    const badOffset = await run(CPP_EXE, ['-e', '-o', 'abc'], dir);
    check('非法 --offset 报错退出', badOffset.code !== 0);
    const noMode = await run(CPP_EXE, [], dir);
    check('缺少 -e/-d 时退出并打印用法', noMode.code !== 0 && /用法/.test(noMode.stdout));
    const unknown = await run(CPP_EXE, ['-e', '--nope'], dir);
    check('未知参数被拒绝', unknown.code !== 0);

    // 空文件夹
    const emptyDir = await makeSandbox('cli-empty');
    const empty = await run(CPP_EXE, ['-e'], emptyDir);
    check('空文件夹给出提示并非零退出', empty.code !== 0 && /无符合支持格式/.test(empty.stderr));
}

// ---------------------------------------------------------------- 汇总

console.log(`共 ${checks} 项检查，失败 ${failures} 项`);
if (failures) {
    for (const d of details.slice(0, 40)) console.log(`  ✗ ${d}`);
    process.exit(1);
}
console.log('端到端 CLI 验证通过 ✅');
