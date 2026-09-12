// tests/repo_bloat_dimensions.mjs
// 把没能按文件名认领的大 PNG/JPEG 按"图像尺寸"认领：
// 读 PNG 的 IHDR（宽高直接可读）与 JPEG 的 SOF 段，再与工作区图片比对。
//
// 用法: node tests/repo_bloat_dimensions.mjs [--min=1048576]

import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN = Number(process.argv.find((a) => a.startsWith('--min='))?.slice(6) ?? 1 << 20);
const mb = (n) => (n / (1024 * 1024)).toFixed(1);

/** 只读文件头部，避免把大图整个读进内存 */
function readHead(file, length = 65536) {
    const fd = openSync(file, 'r');
    try {
        const buf = Buffer.alloc(length);
        const n = readSync(fd, buf, 0, length, 0);
        return buf.subarray(0, n);
    } finally {
        closeSync(fd);
    }
}

const git = (args, opts = {}) => {
    const res = spawnSync('git', args, {
        cwd: repoRoot,
        encoding: opts.binary ? 'buffer' : 'utf8',
        maxBuffer: 1024 * 1024 * 512,
    });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} 失败`);
    return res.stdout;
};

function pngSize(buf) {
    if (buf.length < 33 || buf.subarray(1, 4).toString('ascii') !== 'PNG') return null;
    // 签名 8 字节 + 长度4 + "IHDR"4 + 宽4 + 高4
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
            i++;
            continue;
        }
        const marker = buf[i + 1];
        // SOF0..SOF15（跳过 DHT=C4, JPG=C8, DAC=CC）
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        const len = buf.readUInt16BE(i + 2);
        i += 2 + len;
    }
    return null;
}

function imageSize() {
    return null;
}

// ---------------------------------------------------------------- 不可达的大图

const reachable = new Set();
for (const line of git(['rev-list', '--objects', '--all']).split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    reachable.add(sp === -1 ? line : line.slice(0, sp));
}

const objectsDir = path.join(repoRoot, '.git', 'objects');
const targets = [];
for (const d of readdirSync(objectsDir)) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    for (const f of readdirSync(path.join(objectsDir, d))) {
        if (!/^[0-9a-f]{38}$/.test(f)) continue;
        const oid = d + f;
        if (reachable.has(oid)) continue;
        const size = statSync(path.join(objectsDir, d, f)).size;
        if (size < MIN) continue;
        // 只取头部就够判断尺寸
        const head = git(['cat-file', 'blob', oid], { binary: true }).subarray(0, 65536);
        const dim = pngSize(head) ?? jpegSize(head);
        if (!dim) continue;
        targets.push({ oid, diskSize: size, ...dim });
    }
}

// ---------------------------------------------------------------- 工作区图片

const images = [];
const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === '.git' || e.name === 'node_modules' || e.name === 'target') continue;
            walk(full, depth + 1);
            continue;
        }
        if (!/\.(png|jpe?g|bmp|tiff?|webp)$/i.test(e.name)) continue;
        const st = statSync(full);
        if (st.size < MIN) continue;
        const dim = pngSize(readHead(full)) ?? jpegSize(readHead(full));
        images.push({ file: path.relative(repoRoot, full).replace(/\\/g, '/'), size: st.size, dim });
    }
};
walk(repoRoot);

console.log(`不可达的大图中，可读出尺寸的 ${targets.length} 个；工作区候选图片 ${images.filter((i) => i.dim).length} 张\n`);
console.log(`  ${'磁盘(MB)'.padStart(9)}  ${'尺寸'.padEnd(13)}  ${'对象'.padEnd(10)}  工作区里同尺寸的图片`);
for (const t of targets.sort((a, b) => b.diskSize - a.diskSize)) {
    const same = images.filter((i) => i.dim && i.dim.width === t.width && i.dim.height === t.height);
    const label = same.length ? same.map((s) => `${s.file}(${mb(s.size)}MB)`).join(', ') : '(工作区已无同尺寸图片)';
    console.log(`  ${mb(t.diskSize).padStart(9)}  ${`${t.width}x${t.height}`.padEnd(13)}  ${t.oid.slice(0, 9)}  ${label}`);
}
