// tests/repo_bloat_identify.mjs
// 识别大体积不可达对象的"身份"：文件类型（魔数）、以及是否是当前工作区里某个文件的旧版本。
//
// 用法: node tests/repo_bloat_identify.mjs [--min=1048576] [--top=40]

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MIN = Number(argv.find((a) => a.startsWith('--min='))?.slice(6) ?? 1 << 20);
const TOP = Number(argv.find((a) => a.startsWith('--top='))?.slice(6) ?? 40);

const mb = (n) => (n / (1024 * 1024)).toFixed(1);
const git = (args, opts = {}) => {
    const res = spawnSync('git', args, {
        cwd: repoRoot,
        encoding: opts.binary ? 'buffer' : 'utf8',
        input: opts.input,
        maxBuffer: 1024 * 1024 * 512,
    });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${res.stderr?.toString().slice(0, 200)}`);
    return res.stdout;
};

// ---------------------------------------------------------------- 收集不可达的大对象

const reachable = new Set();
for (const line of git(['rev-list', '--objects', '--all']).split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    reachable.add(sp === -1 ? line : line.slice(0, sp));
}

const objectsDir = path.join(repoRoot, '.git', 'objects');
const candidates = [];
for (const d of readdirSync(objectsDir)) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    for (const f of readdirSync(path.join(objectsDir, d))) {
        if (!/^[0-9a-f]{38}$/.test(f)) continue;
        const oid = d + f;
        if (reachable.has(oid)) continue;
        const size = statSync(path.join(objectsDir, d, f)).size;
        if (size >= MIN) candidates.push({ oid, diskSize: size });
    }
}

// ---------------------------------------------------------------- 魔数识别

function sniff(buf) {
    const hex = buf.subarray(0, 16).toString('hex');
    if (hex.startsWith('89504e47')) return 'PNG';
    if (hex.startsWith('ffd8ff')) return 'JPEG';
    if (hex.startsWith('47494638')) return 'GIF';
    if (hex.startsWith('424d')) return 'BMP';
    if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) return 'TIFF';
    if (hex.startsWith('52494646') && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'WEBP';
    if (hex.startsWith('00010000') || hex.startsWith('74727565') || hex.startsWith('4f54544f')) return 'TTF/OTF';
    if (hex.startsWith('774f4632') || hex.startsWith('77414632')) return 'WOFF';
    if (hex.startsWith('25504446')) return 'PDF';
    if (hex.startsWith('504b0304')) return 'ZIP/docx';
    if (hex.startsWith('377abcaf')) return '7z';
    if (hex.startsWith('1f8b')) return 'gzip';
    if (hex.startsWith('4d5a')) return 'PE/exe';
    // 文本判断：前 512 字节是否全是可打印字符或常见空白
    const sample = buf.subarray(0, 512);
    let printable = 0;
    for (const b of sample) {
        if ((b >= 0x20 && b < 0x7f) || b === 9 || b === 10 || b === 13 || b >= 0x80) printable++;
    }
    return printable / sample.length > 0.95 ? 'text' : 'binary?';
}

for (const c of candidates) {
    const buf = git(['cat-file', 'blob', c.oid], { binary: true });
    c.type = sniff(buf);
    c.actualSize = buf.length;
    if (c.type === 'text') {
        c.head = buf.subarray(0, 160).toString('utf8').split('\n')[0];
    } else {
        c.head = '';
    }
    // 文本/二进制都给一段可见特征，便于人工认领
    if (!c.head) {
        const ascii = buf.subarray(0, 32).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
        c.head = ascii;
    }
}

// ---------------------------------------------------------------- 与工作区文件比对

console.log('正在给工作区里 >= 1MB 的文件算 git hash（用于认领旧版本）...\n');
const tracked = git(['ls-files']).split('\n').filter(Boolean);
const targets = new Map(candidates.map((c) => [c.oid, c]));

const DIRS = ['images', 'web', 'Cpp', 'Python', 'files', 'js', 'build', 'tests'];
const seen = new Set();
const matches = [];
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
        let st;
        try {
            st = statSync(full);
        } catch {
            continue;
        }
        if (st.size < MIN) continue;
        const rel = path.relative(repoRoot, full).replace(/\\/g, '/');
        if (seen.has(rel)) continue;
        seen.add(rel);
        const oid = spawnSync('git', ['hash-object', full], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
        const hit = targets.get(oid);
        if (hit) {
            hit.claimedBy = rel;
            matches.push({ oid, rel, size: st.size });
        }
    }
};
for (const d of DIRS) {
    const full = path.join(repoRoot, d);
    try {
        if (statSync(full).isDirectory()) walk(full);
    } catch {
        /* 目录不存在 */
    }
}
// 已跟踪文件也一并算一遍（防止素材被移走）
for (const t of tracked.slice(0, 200)) {
    const full = path.join(repoRoot, t);
    try {
        const st = statSync(full);
        if (st.size < MIN || seen.has(t)) continue;
        seen.add(t);
        const oid = spawnSync('git', ['hash-object', full], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
        const hit = targets.get(oid);
        if (hit) hit.claimedBy = t;
    } catch {
        /* 文件不在工作区 */
    }
}

// ---------------------------------------------------------------- 输出

const sorted = candidates.sort((a, b) => b.diskSize - a.diskSize);
console.log(`不可达且 >= ${mb(MIN)} MB 的对象共 ${sorted.length} 个：\n`);
console.log(`  ${'磁盘(MB)'.padStart(9)}  ${'类型'.padEnd(9)}  ${'对象'.padEnd(10)}  认领到的文件 / 内容开头`);
for (const c of sorted.slice(0, TOP)) {
    const claim = c.claimedBy ? c.claimedBy : `(${c.head.slice(0, 60)})`;
    console.log(`  ${mb(c.diskSize).padStart(9)}  ${c.type.padEnd(9)}  ${c.oid.slice(0, 9)}  ${claim}`);
}

const byType = new Map();
for (const c of candidates) byType.set(c.type, (byType.get(c.type) ?? 0) + c.diskSize);
console.log('\n按类型汇总（不可达）:');
for (const [t, bytes] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${mb(bytes).padStart(9)} MB  ${t}`);
}

const claimed = sorted.filter((c) => c.claimedBy);
console.log(`\n其中 ${claimed.length} 个能在当前工作区找到同名同内容文件（说明只是旧版本残留）：`);
for (const c of claimed.slice(0, 20)) console.log(`  ${mb(c.diskSize).padStart(9)} MB  ${c.claimedBy}`);

const outFile = path.join(repoRoot, 'tests', 'out', 'repo_bloat_identify.txt');
mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(
    outFile,
    sorted
        .map((c) => `${mb(c.diskSize)}\t${c.type}\t${c.oid}\t${c.claimedBy ?? ''}\t${c.head.slice(0, 80)}`)
        .join('\n'),
    'utf8',
);
console.log(`\n完整清单已写入 ${path.relative(repoRoot, outFile)}`);
