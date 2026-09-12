// tests/repo_bloat_unreachable.mjs
// 盘点 .git/objects 里**所有**对象（含已不可达的历史残留），找出真正的体积来源。
//
// 用法: node tests/repo_bloat_unreachable.mjs [--min=1048576] [--top=40] [--json]

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MIN = Number(argv.find((a) => a.startsWith('--min='))?.slice(6) ?? 1 << 20);
const TOP = Number(argv.find((a) => a.startsWith('--top='))?.slice(6) ?? 40);
const AS_JSON = argv.includes('--json');

const mb = (n) => (n / (1024 * 1024)).toFixed(1);
const git = (args, opts = {}) => {
    const res = spawnSync('git', args, {
        cwd: repoRoot,
        encoding: opts.binary ? 'buffer' : 'utf8',
        input: opts.input,
        maxBuffer: 1024 * 1024 * 512,
    });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${res.stderr?.toString().slice(0, 300)}`);
    return res.stdout;
};

const gitDir = path.join(repoRoot, '.git');
const objectsDir = path.join(gitDir, 'objects');

// ---------------------------------------------------------------- 1. 可达对象

const reachable = new Set();
for (const line of git(['rev-list', '--objects', '--all']).split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    reachable.add(sp === -1 ? line : line.slice(0, sp));
}

// ---------------------------------------------------------------- 2. 松散对象

const loose = [];
for (const d of readdirSync(objectsDir)) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    const sub = path.join(objectsDir, d);
    for (const f of readdirSync(sub)) {
        if (!/^[0-9a-f]{38}$/.test(f)) continue;
        loose.push({ oid: d + f, path: path.join(sub, f), disk: statSync(path.join(sub, f)).size });
    }
}

// ---------------------------------------------------------------- 3. pack 里的对象

const packDir = path.join(objectsDir, 'pack');
const packFiles = readdirSync(packDir).filter((f) => f.endsWith('.idx'));
const packed = new Map(); // oid -> { size, pack }
for (const idx of packFiles) {
    const out = git(['verify-pack', '-v', path.join(packDir, idx)]);
    for (const line of out.split('\n')) {
        // 形如 "ab12... blob 12345 6789 1234"（非 delta 项才带 size）
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const [oid, type, size] = parts;
        if (!/^[0-9a-f]{40}$/.test(oid)) continue;
        const bytes = Number(size);
        if (!Number.isFinite(bytes)) continue;
        if (!packed.has(oid) || packed.get(oid).size < bytes) {
            packed.set(oid, { size: bytes, type, pack: idx.replace('.idx', '.pack') });
        }
    }
}

// ---------------------------------------------------------------- 4. 组装

const all = new Map();
for (const [oid, info] of packed) all.set(oid, { oid, size: info.size, type: info.type, where: info.pack });
for (const o of loose) {
    const res = spawnSync('git', ['cat-file', '-s', o.oid], { cwd: repoRoot, encoding: 'utf8' });
    if (res.status !== 0) continue;
    all.set(o.oid, { oid: o.oid, size: Number(res.stdout.trim()), type: 'loose', where: o.path, disk: o.disk });
}

const list = [...all.values()];
const unreachableList = list.filter((o) => !reachable.has(o.oid));
const large = list.filter((o) => o.size >= MIN).sort((a, b) => b.size - a.size);
const largeUnreachable = unreachableList.filter((o) => o.size >= MIN).sort((a, b) => b.size - a.size);

const sum = (arr) => arr.reduce((s, o) => s + o.size, 0);
const diskTotal = (() => {
    const res = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-ChildItem -Recurse -File -Force '${objectsDir}' | Measure-Object -Property Length -Sum).Sum`], { encoding: 'utf8' });
    return Number(res.stdout.trim()) || 0;
})();

const report = {
    objectsDirBytes: diskTotal,
    allCount: list.length,
    allBytes: sum(list),
    reachableBytes: sum(list.filter((o) => reachable.has(o.oid))),
    unreachableCount: unreachableList.length,
    unreachableBytes: sum(unreachableList),
    looseCount: loose.length,
    looseDiskBytes: loose.reduce((s, o) => s + o.disk, 0),
    packCount: packFiles.length,
    largeUnreachable: largeUnreachable.slice(0, TOP),
};

if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
}

console.log(`.git/objects 实际占用: ${mb(diskTotal)} MB`);
console.log(`对象总数: ${list.length}（pack 文件 ${packFiles.length} 个 + 松散对象 ${loose.length} 个，松散对象实占 ${mb(report.looseDiskBytes)} MB）`);
console.log(`  可达:   ${mb(report.reachableBytes)} MB`);
console.log(`  不可达: ${mb(report.unreachableBytes)} MB  (${unreachableList.length} 个对象)\n`);

console.log(`不可达对象里 >= ${mb(MIN)} MB 的，共 ${largeUnreachable.length} 个：`);
console.log(`  ${'大小(MB)'.padStart(8)}  ${'类型'.padEnd(6)}  ${'对象'.padEnd(10)}  所在`);
for (const o of largeUnreachable.slice(0, TOP)) {
    console.log(`  ${mb(o.size).padStart(8)}  ${(o.type ?? '').padEnd(6)}  ${o.oid.slice(0, 9)}  ${path.relative(repoRoot, o.where ?? '')}`);
}

const byExtLike = new Map();
for (const o of largeUnreachable) {
    // 松散对象没有路径信息，只能给出类型；pack 里的同理
    byExtLike.set(o.type, (byExtLike.get(o.type) ?? 0) + o.size);
}
console.log('\n按对象类型分布（不可达）:');
for (const [t, bytes] of [...byExtLike.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${mb(bytes).padStart(8)} MB  ${t}`);
}

const outFile = path.join(repoRoot, 'tests', 'out', 'repo_bloat_unreachable.txt');
mkdirSync(path.dirname(outFile), { recursive: true });
let text = `objects dir: ${mb(diskTotal)} MB\nall=${list.length} reachable=${mb(report.reachableBytes)} unreachable=${mb(report.unreachableBytes)}\n\n`;
text += `size(MB)\ttype\toid\twhere\n`;
for (const o of large) {
    text += `${mb(o.size)}\t${o.type}\t${o.oid}\t${o.where}\t${reachable.has(o.oid) ? 'reachable' : 'UNREACHABLE'}\n`;
}
writeFileSync(outFile, text, 'utf8');
console.log(`\n完整清单已写入 ${path.relative(repoRoot, outFile)}`);
