// tests/repo_bloat.mjs
// 盘点仓库历史里的大对象：谁、什么时候、以什么路径进来的。
// 只读，不会修改仓库（可选 --gc 会先跑一次 git gc 把松散对象合并）。
//
// 用法:
//   node tests/repo_bloat.mjs [--min=1048576] [--top=40] [--json] [--gc]

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MIN_BYTES = Number(argv.find((a) => a.startsWith('--min='))?.slice(6) ?? 1 << 20);
const TOP = Number(argv.find((a) => a.startsWith('--top='))?.slice(6) ?? 40);
const AS_JSON = argv.includes('--json');
const DO_GC = argv.includes('--gc');

function git(args, opts = {}) {
    const res = spawnSync('git', args, {
        cwd: repoRoot,
        encoding: opts.binary ? 'buffer' : 'utf8',
        maxBuffer: opts.maxBuffer ?? 1024 * 1024 * 512,
    });
    if (res.status !== 0) {
        throw new Error(`git ${args.join(' ')} 失败: ${res.stderr?.toString().slice(0, 500)}`);
    }
    return res.stdout;
}

const mb = (n) => (n / (1024 * 1024)).toFixed(1);
const dirSize = (p) => {
    const res = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-ChildItem -Recurse -File -Force '${p}' | Measure-Object -Property Length -Sum).Sum`], { encoding: 'utf8' });
    return Number(res.stdout.trim()) || 0;
};

const gitDir = path.join(repoRoot, '.git');
const before = dirSize(gitDir);
if (DO_GC) {
    console.log('执行 git gc --prune=now ...');
    git(['gc', '--prune=now', '--quiet']);
}
const after = dirSize(gitDir);

// ---------------------------------------------------------------- 1. 全部可达对象

// rev-list --objects 会列出每个可达对象及其路径（重复出现的对象会带多个路径，只留第一个）
const rawList = git(['rev-list', '--objects', '--all']).split('\n');
const oidToPath = new Map();
const oids = [];
for (const line of rawList) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const oid = sp === -1 ? line : line.slice(0, sp);
    const p = sp === -1 ? '' : line.slice(sp + 1);
    if (!oidToPath.has(oid)) {
        oidToPath.set(oid, p);
        oids.push(oid);
    }
}

// ---------------------------------------------------------------- 2. 批量取类型与大小

const input = oids.join('\n') + '\n';
const res = spawnSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    cwd: repoRoot,
    input,
    maxBuffer: 1024 * 1024 * 512,
    encoding: 'utf8',
});
if (res.status !== 0) throw new Error(res.stderr?.slice(0, 500));

const objects = [];
for (const line of res.stdout.split('\n')) {
    if (!line) continue;
    const [oid, type, size] = line.split(' ');
    objects.push({ oid, type, size: Number(size), path: oidToPath.get(oid) ?? '' });
}

const large = objects.filter((o) => o.size >= MIN_BYTES).sort((a, b) => b.size - a.size);
const totalReachable = objects.reduce((s, o) => s + o.size, 0);

// ---------------------------------------------------------------- 3. 谁把大对象带进来的

const largeSet = new Set(large.map((o) => o.oid));
const introducedBy = new Map(); // oid -> { commit, date, subject, path }

const logOut = git(['log', '--all', '--pretty=format:@@%H|%ad|%s', '--date=short', '--raw', '--no-renames']);
let current = null;
for (const line of logOut.split('\n')) {
    if (line.startsWith('@@')) {
        const [hash, date, subject] = line.slice(2).split('|');
        current = { hash, date, subject };
        continue;
    }
    if (!line.startsWith(':') || !current) continue;
    const oid = line.slice(-40);
    if (largeSet.has(oid) && !introducedBy.has(oid)) {
        // 格式: :mode mode sha sha STATUS\tpath
        const tabIdx = line.indexOf('\t');
        const p = tabIdx === -1 ? '' : line.slice(tabIdx + 1);
        introducedBy.set(oid, { ...current, path: p });
    }
}

// ---------------------------------------------------------------- 4. 汇总

const byExt = new Map();
const byDir = new Map();
for (const o of large) {
    const ext = (path.extname(o.path) || '(无扩展名)').toLowerCase();
    byExt.set(ext, (byExt.get(ext) ?? 0) + o.size);
    const top = o.path.split('/')[0] || '(根)';
    byDir.set(top, (byDir.get(top) ?? 0) + o.size);
}
const sortDesc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);

const report = {
    gitDirBeforeBytes: before,
    gitDirAfterBytes: after,
    reachableObjectCount: objects.length,
    reachableTotalBytes: totalReachable,
    minBytes: MIN_BYTES,
    largeCount: large.length,
    largeTotalBytes: large.reduce((s, o) => s + o.size, 0),
    byExt: sortDesc(byExt).map(([ext, bytes]) => ({ ext, bytes })),
    byDir: sortDesc(byDir).map(([dir, bytes]) => ({ dir, bytes })),
    objects: large.map((o) => ({
        oid: o.oid,
        size: o.size,
        path: o.path,
        commit: introducedBy.get(o.oid)?.hash ?? null,
        date: introducedBy.get(o.oid)?.date ?? null,
        subject: introducedBy.get(o.oid)?.subject ?? null,
    })),
};

if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
}

console.log(`.git 体积: ${mb(before)} MB${DO_GC ? ` -> ${mb(after)} MB（gc 后）` : ''}`);
console.log(`可达对象: ${objects.length} 个，合计 ${mb(totalReachable)} MB`);
console.log(`其中 >= ${mb(MIN_BYTES)} MB 的对象: ${large.length} 个，合计 ${mb(report.largeTotalBytes)} MB\n`);

console.log('按目录分布:');
for (const [dir, bytes] of sortDesc(byDir)) console.log(`  ${mb(bytes).padStart(8)} MB  ${dir}`);
console.log('\n按扩展名分布:');
for (const [ext, bytes] of sortDesc(byExt)) console.log(`  ${mb(bytes).padStart(8)} MB  ${ext}`);

console.log(`\n最大的 ${Math.min(TOP, large.length)} 个:`);
console.log(`  ${'大小(MB)'.padStart(8)}  ${'对象'.padEnd(10)}  ${'引入提交'.padEnd(10)}  ${'日期'.padEnd(10)}  路径`);
for (const o of report.objects.slice(0, TOP)) {
    const info = introducedBy.get(o.oid);
    console.log(
        `  ${mb(o.size).padStart(8)}  ${o.oid.slice(0, 9)}  ${(info?.hash.slice(0, 9) ?? '-').padEnd(10)}  ` +
            `${(info?.date ?? '-').padEnd(10)}  ${o.path}`,
    );
}

const outFile = path.join(repoRoot, 'tests', 'out', 'repo_bloat.txt');
mkdirSync(path.dirname(outFile), { recursive: true });
let text = `git dir: ${mb(before)} MB${DO_GC ? ` -> ${mb(after)} MB` : ''}\n`;
text += `big objects (>= ${MIN_BYTES} bytes): ${large.length}, total ${mb(report.largeTotalBytes)} MB\n\n`;
text += `size(MB)\toid\tcommit\tdate\tpath\n`;
for (const o of report.objects) {
    const info = introducedBy.get(o.oid);
    text += `${mb(o.size)}\t${o.oid}\t${info?.hash ?? '-'}\t${info?.date ?? '-'}\t${o.path}\n`;
}
writeFileSync(outFile, text, 'utf8');
console.log(`\n完整清单已写入 ${path.relative(repoRoot, outFile)}`);
