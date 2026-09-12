// tests/repo_bloat_archive.mjs
// 把 .git 里"不可达的历史残留对象"导出到忽略目录留档，可选随后执行 git gc 清理。
//
// 用法:
//   node tests/repo_bloat_archive.mjs                    # 只导出，并打印清理命令
//   node tests/repo_bloat_archive.mjs --gc               # 导出 + 校验 + 立即清理
//   node tests/repo_bloat_archive.mjs --out=archive/xxx  # 指定留档目录
//
// 安全保证：
//   1. 只导出，不修改仓库；导出后逐个用 git hash-object 复核，哈希不符即中止；
//   2. --gc 只在全部对象校验通过后才执行，且用 --prune=now 明确清理不可达对象；
//   3. 清理前会打印存档清单路径，便于回溯。

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const DO_GC = argv.includes('--gc');
const OUT = path.join(
    repoRoot,
    argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'archive/2026-09-12-orphaned-objects',
);
const mb = (n) => (n / (1024 * 1024)).toFixed(1);

const git = (args, opts = {}) => {
    const res = spawnSync('git', args, {
        cwd: repoRoot,
        encoding: opts.binary ? 'buffer' : 'utf8',
        maxBuffer: 1024 * 1024 * 512,
    });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${res.stderr?.toString().slice(0, 300)}`);
    return res.stdout;
};
/** 大对象直接流式写入磁盘，避免把 120MB 的 blob 塞进 Buffer */
function streamBlobToFile(oid, file, type = 'blob') {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['cat-file', type, oid], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
        const ws = createWriteStream(file);
        child.stdout.pipe(ws);
        ws.on('finish', () => resolve());
        ws.on('error', reject);
        child.on('error', reject);
    });
}

// ---------------------------------------------------------------- 1. 找出不可达对象

const reachable = new Set();
for (const line of git(['rev-list', '--objects', '--all']).split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    reachable.add(sp === -1 ? line : line.slice(0, sp));
}

const objectsDir = path.join(repoRoot, '.git', 'objects');
const all = [];
for (const d of readdirSync(objectsDir)) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    for (const f of readdirSync(path.join(objectsDir, d))) {
        if (!/^[0-9a-f]{38}$/.test(f)) continue;
        const oid = d + f;
        if (reachable.has(oid)) continue;
        const disk = statSync(path.join(objectsDir, d, f)).size;
        all.push({ oid, disk });
    }
}

if (!all.length) {
    console.log('没有不可达对象，无需留档。');
    process.exit(0);
}

// ---------------------------------------------------------------- 2. 识别身份

// 工作区（含未跟踪）里 >= MIN 的文件，用哈希反查"这个对象原来是哪个文件"。
// 刻意跳过 tests/out：里面可能有先前排查脚本导出的同一批对象，会把"无主"误判成"有主"。
const MIN = 1 << 20;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'archive', 'out']);
const workspaceByHash = new Map();
const walk = (dir, depth = 0) => {
    if (depth > 7) return;
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
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
        const oid = spawnSync('git', ['hash-object', full], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
        if (oid && !workspaceByHash.has(oid)) workspaceByHash.set(oid, path.relative(repoRoot, full).replace(/\\/g, '/'));
    }
};
walk(repoRoot);

function sniff(head) {
    const hex = head.subarray(0, 16).toString('hex');
    if (hex.startsWith('89504e47')) return 'png';
    if (hex.startsWith('ffd8ff')) return 'jpg';
    if (hex.startsWith('47494638')) return 'gif';
    if (hex.startsWith('424d')) return 'bmp';
    if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) return 'tiff';
    if (hex.startsWith('00010000') || hex.startsWith('4f54544f') || hex.startsWith('74727565')) return 'ttf';
    if (hex.startsWith('774f4632')) return 'woff2';
    if (hex.startsWith('377abcaf')) return '7z';
    if (hex.startsWith('504b0304')) return 'zip';
    if (hex.startsWith('4d5a')) return 'exe';
    if (head.length >= 4 && head.readUInt32LE(0) === 0x464c457f) return 'elf';
    let printable = 0;
    const sample = head.subarray(0, 512);
    for (const b of sample) if ((b >= 0x20 && b < 0x7f) || b === 9 || b === 10 || b === 13 || b >= 0x80) printable++;
    return printable / Math.max(1, sample.length) > 0.95 ? 'txt' : 'bin';
}

function pngSize(buf) {
    return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
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
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            const height = buf.readUInt16BE(i + 5);
            const width = buf.readUInt16BE(i + 7);
            return width > 0 && height > 0 && width <= 65535 && height <= 65535 ? { width, height } : null;
        }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) return null;
        i += 2 + len;
    }
    return null;
}

const entries = [];
for (const o of all.sort((a, b) => b.disk - a.disk)) {
    // 不可达对象里除了 blob 还可能有 tag/commit/tree（例如被改写掉的 tag 对象）
    const type = git(['cat-file', '-t', o.oid]).trim();
    o.type = type;
    const raw = git(['cat-file', type === 'blob' ? 'blob' : type, o.oid], { binary: true });
    const head = raw.subarray(0, 65536);
    const claimed = type === 'blob' ? workspaceByHash.get(o.oid) ?? null : null;
    const kind = claimed ? path.extname(claimed).slice(1).toLowerCase() || sniff(head) : sniff(head);
    const dim = kind === 'png' ? pngSize(head) : kind === 'jpg' ? jpegSize(head) : null;
    entries.push({ ...o, claimed, kind: kind || 'bin', dim, head: head.subarray(0, 64) });
}

// ---------------------------------------------------------------- 3. 导出

mkdirSync(OUT, { recursive: true });
const usedNames = new Map();
let seq = 0;
for (const e of entries) {
    seq++;
    let name;
    if (e.claimed) {
        // 认领到工作区同名文件：把哈希接在扩展名前，保留原始文件名以便对照
        const base = path.basename(e.claimed);
        const ext = path.extname(base);
        name = `${base.slice(0, base.length - ext.length)}@${e.oid.slice(0, 9)}${ext}`;
    } else if (e.dim) {
        name = `unclaimed-${String(seq).padStart(2, '0')}-${e.dim.width}x${e.dim.height}-${e.oid.slice(0, 9)}.${e.kind}`;
    } else {
        name = `unclaimed-${String(seq).padStart(2, '0')}-${e.oid.slice(0, 9)}.${e.kind}`;
    }
    if (e.type !== 'blob') name = `${e.type}-${name}`;
    // 防止重名（同一文件的不同版本哈希不同，一般不会撞，这里兜底）
    if (usedNames.has(name)) name = `${e.oid.slice(0, 9)}-${name}`;
    usedNames.set(name, true);
    e.name = name;

    const file = path.join(OUT, name);
    await streamBlobToFile(e.oid, file, e.type);

    // 校验：重新算哈希必须与对象 id 一致（tag 对象用 git hash-object -t tag 复核）
    const hashArgs = e.type === 'blob' ? ['hash-object', file] : ['hash-object', '-t', e.type, '--literally', file];
    const actual = spawnSync('git', hashArgs, { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
    e.verified = actual === e.oid;
    const size = statSync(file).size;
    e.exportedBytes = size;
    if (!e.verified) {
        console.error(`✗ 校验失败：${name} 的哈希 ${actual} != ${e.oid}，已中止清理`);
        process.exitCode = 1;
    }
}

const okCount = entries.filter((e) => e.verified).length;
const manifest = {
    generatedAt: new Date().toISOString(),
    note: '这些对象来自 .git 对象库中不可达的历史残留（git add 过但未进入任何提交），导出留档后已从仓库清理。',
    gitDirBeforeBytes: null,
    totalBytes: entries.reduce((s, e) => s + e.exportedBytes, 0),
    count: entries.length,
    entries: entries.map((e) => ({
        file: e.name,
        oid: e.oid,
        bytes: e.exportedBytes,
        kind: e.kind,
        dimensions: e.dim,
        claimedFromWorkingTree: e.claimed,
        sha256: null,
        verifiedByGitHashObject: e.verified,
    })),
};
writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8');

const lines = [
    `# 归档：.git 中不可达的历史残留对象`,
    ``,
    `导出时间: ${manifest.generatedAt}`,
    `对象数: ${entries.length}，合计 ${mb(manifest.totalBytes)} MB`,
    `全部对象导出后均用 \`git hash-object\` 复核，通过 ${okCount}/${entries.length}`,
    ``,
    `## 说明`,
    ``,
    ...manifest.note.split('。').filter(Boolean).map((s) => `- ${s}。`),
    ``,
    `## 清单`,
    ``,
    `| 文件 | 对象 | 大小(MB) | 类型 | 尺寸 | 来源（工作区同名文件） |`,
    `| --- | --- | --- | --- | --- | --- |`,
    ...entries.map(
        (e) =>
            `| ${e.name} | ${e.oid.slice(0, 9)} | ${mb(e.exportedBytes)} | ${e.kind} | ` +
            `${e.dim ? `${e.dim.width}x${e.dim.height}` : '-'} | ${e.claimed ?? '-'} |`,
    ),
];
writeFileSync(path.join(OUT, 'MANIFEST.md'), lines.join('\n') + '\n', 'utf8');

console.log(`已导出 ${entries.length} 个对象（${mb(manifest.totalBytes)} MB）到 ${path.relative(repoRoot, OUT)}`);
console.log(`校验通过 ${okCount}/${entries.length}${okCount === entries.length ? '' : '（存在失败，未清理）'}`);
console.log('\n最大的 10 个：');
for (const e of entries.slice(0, 10)) {
    console.log(`  ${mb(e.exportedBytes).padStart(7)} MB  ${e.name}`);
}

// ---------------------------------------------------------------- 4. 清理

const gitDirBytes = () => {
    const res = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-ChildItem -Recurse -File -Force '${path.join(repoRoot, '.git')}' | Measure-Object -Property Length -Sum).Sum`], { encoding: 'utf8' });
    return Number(res.stdout.trim()) || 0;
};

const before = gitDirBytes();
if (!DO_GC) {
    console.log(`\n当前 .git 占用 ${mb(before)} MB。确认存档无误后执行清理：`);
    console.log('  node tests/repo_bloat_archive.mjs --gc      # 或手动 git gc --prune=now');
    process.exit(process.exitCode ?? 0);
}

if (okCount !== entries.length) {
    console.error('\n有对象校验失败，出于安全考虑不执行清理。');
    process.exit(1);
}

console.log(`\n执行 git gc --prune=now（.git 当前 ${mb(before)} MB）...`);
const gc = spawnSync('git', ['gc', '--prune=now', '--quiet'], { cwd: repoRoot, stdio: 'inherit' });
if (gc.status !== 0) {
    console.error(`git gc 失败（exit ${gc.status}）`);
    process.exit(1);
}
const after = gitDirBytes();
console.log(`清理完成：.git ${mb(before)} MB -> ${mb(after)} MB（释放 ${mb(before - after)} MB）`);
manifest.gitDirBeforeBytes = before;
manifest.gitDirAfterBytes = after;
writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8');
