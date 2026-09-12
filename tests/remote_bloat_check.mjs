// tests/remote_bloat_check.mjs
// 推送前检查：远端历史里有没有大对象？
// 分别统计“本地将要推送的历史”与“远端已有历史”的对象体积，并列出各自 >= 阈值 的对象。
// 只读，不修改任何东西。
//
// 用法: node tests/remote_bloat_check.mjs [--min=1048576] [--top=20]
//   环境变量 REMOTE_REFS 可指定远端跟踪引用，默认 refs/remotes/origin/*

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MIN = Number(argv.find((a) => a.startsWith('--min='))?.slice(6) ?? 1 << 20);
const TOP = Number(argv.find((a) => a.startsWith('--top='))?.slice(6) ?? 20);
const REMOTE_NAME = process.env.REMOTE_NAME ?? 'origin';
const mb = (n) => (n / (1024 * 1024)).toFixed(1);

function git(args, opts = {}) {
    const res = spawnSync('git', args, {
        cwd: repoRoot,
        encoding: opts.binary ? 'buffer' : 'utf8',
        input: opts.input,
        maxBuffer: 1024 * 1024 * 512,
    });
    if (res.status !== 0) return null;
    return res.stdout;
}

/** 取某个引用集合下所有可达对象的大小信息 */
function collect(refArgs) {
    const listRaw = git(['rev-list', '--objects', ...refArgs]);
    if (listRaw === null) return null;

    const oidToPath = new Map();
    const oids = [];
    for (const line of listRaw.split('\n')) {
        if (!line) continue;
        const sp = line.indexOf(' ');
        const oid = sp === -1 ? line : line.slice(0, sp);
        const p = sp === -1 ? '' : line.slice(sp + 1);
        if (!oidToPath.has(oid)) {
            oidToPath.set(oid, p);
            oids.push(oid);
        }
    }
    if (!oids.length) return { count: 0, total: 0, large: [], oids: new Set() };

    const out = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
        input: oids.join('\n') + '\n',
    });
    const large = [];
    let total = 0;
    for (const line of out.split('\n')) {
        if (!line) continue;
        const [oid, type, sizeStr] = line.split(' ');
        const size = Number(sizeStr);
        if (!Number.isFinite(size)) continue;
        total += size;
        if (size >= MIN) large.push({ oid, type, size, path: oidToPath.get(oid) ?? '' });
    }
    large.sort((a, b) => b.size - a.size);
    return { count: oids.length, total, large, oids: new Set(oids) };
}

const localRefs = ['refs/heads/main', 'refs/heads/bugfix/fix-web-v2b'];
// 远端跟踪分支用 --remotes=<name> 取：refs/remotes/origin/* 这种写法在本机 git 上不会展开
const remoteRefs = [`--remotes=${REMOTE_NAME}`];

const local = collect(localRefs);
const remote = collect(remoteRefs);

const report = (label, r) => {
    if (!r) {
        console.log(`${label}: 取不到引用（可能尚未 fetch）\n`);
        return;
    }
    console.log(`${label}: ${r.count} 个对象，可达内容合计 ${mb(r.total)} MB`);
    if (!r.large.length) {
        console.log(`  没有 >= ${mb(MIN)} MB 的对象\n`);
        return;
    }
    console.log(`  >= ${mb(MIN)} MB 的对象 ${r.large.length} 个：`);
    console.log(`    ${'大小(MB)'.padStart(9)}  ${'类型'.padEnd(6)}  ${'对象'.padEnd(10)}  路径`);
    for (const o of r.large.slice(0, TOP)) {
        console.log(`    ${mb(o.size).padStart(9)}  ${o.type.padEnd(6)}  ${o.oid.slice(0, 9)}  ${o.path}`);
    }
    console.log('');
};

console.log('=== 推送前体积检查 ===\n');
report('本地历史 (main + bugfix/fix-web-v2b)', local);
report(`远端已有历史 (remotes/${REMOTE_NAME})`, remote);

if (local && remote) {
    const missing = [...local.oids].filter((o) => !remote.oids.has(o));
    let missingBytes = 0;
    if (missing.length) {
        const out = git(['cat-file', '--batch-check=%(objectname) %(objectsize)'], {
            input: missing.join('\n') + '\n',
        });
        for (const line of out.split('\n')) {
            const size = Number(line.split(' ')[1]);
            if (Number.isFinite(size)) missingBytes += size;
        }
    }
    const extra = [...remote.oids].filter((o) => !local.oids.has(o));
    console.log(`本地独有（需要上传）: ${missing.length} 个对象，原始 ${mb(missingBytes)} MB（实际传输会压缩）`);
    console.log(`远端独有（本地没有）: ${extra.length} 个对象`);

    const badIncoming = (local.large ?? []).filter((o) => missing.includes(o.oid));
    if (badIncoming.length) {
        console.log(`\n! 将要上传的大对象 ${badIncoming.length} 个：`);
        for (const o of badIncoming.slice(0, TOP)) console.log(`    ${mb(o.size).padStart(9)} MB  ${o.path}`);
    } else {
        console.log(`\nOK: 将要上传的对象里没有 >= ${mb(MIN)} MB 的文件`);
    }
}
