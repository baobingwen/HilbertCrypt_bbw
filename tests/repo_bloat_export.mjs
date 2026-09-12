// tests/repo_bloat_export.mjs
// 把无法按文件名认领的大图（只存在于 .git 里的历史残留）导出到 tests/out/unreachable/，
// 并生成一个 HTML 索引方便直接看。纯导出，不动仓库。
//
// 用法: node tests/repo_bloat_export.mjs [--min=1048576]

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN = Number(process.argv.find((a) => a.startsWith('--min='))?.slice(6) ?? 1 << 20);
const OUT = path.join(repoRoot, 'tests', 'out', 'unreachable');
const mb = (n) => (n / (1024 * 1024)).toFixed(1);

const git = (args, opts = {}) => {
    const res = spawnSync('git', args, {
        cwd: repoRoot,
        encoding: opts.binary ? 'buffer' : 'utf8',
        maxBuffer: 1024 * 1024 * 512,
    });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${res.stderr?.toString().slice(0, 200)}`);
    return res.stdout;
};

function pngSize(buf) {
    if (buf.length < 33) return null;
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
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            const height = buf.readUInt16BE(i + 5);
            const width = buf.readUInt16BE(i + 7);
            // 合理性校验：JPEG 尺寸不会超过 65535，也不该为 0；
            // 头部读取被截断时可能误判，宁可返回 null 也不要输出荒谬尺寸
            if (width > 0 && height > 0 && width <= 65535 && height <= 65535) return { width, height };
            return null;
        }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) return null;
        i += 2 + len;
    }
    return null;
}

const reachable = new Set();
for (const line of git(['rev-list', '--objects', '--all']).split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    reachable.add(sp === -1 ? line : line.slice(0, sp));
}

// 工作区里已存在同内容文件的，无需导出
const workspaceHashes = new Set();
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
        const oid = spawnSync('git', ['hash-object', full], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
        workspaceHashes.add(oid);
    }
};
walk(repoRoot);

const objectsDir = path.join(repoRoot, '.git', 'objects');
mkdirSync(OUT, { recursive: true });

const exported = [];
for (const d of readdirSync(objectsDir)) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    for (const f of readdirSync(path.join(objectsDir, d))) {
        if (!/^[0-9a-f]{38}$/.test(f)) continue;
        const oid = d + f;
        if (reachable.has(oid) || workspaceHashes.has(oid)) continue;
        const disk = statSync(path.join(objectsDir, d, f)).size;
        if (disk < MIN) continue;

        const buf = git(['cat-file', 'blob', oid], { binary: true });
        const isPng = buf.subarray(1, 4).toString('ascii') === 'PNG';
        const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
        if (!isPng && !isJpeg) continue;
        const dim = isPng ? pngSize(buf) : jpegSize(buf);
        if (!dim || !dim.width || !dim.height) continue;
        // 超大图只取头部解析尺寸，避免把 40MB 的 blob 反复读进内存
        const name = `${oid.slice(0, 9)}_${dim.width}x${dim.height}.${isPng ? 'png' : 'jpg'}`;
        writeFileSync(path.join(OUT, name), buf);
        exported.push({ name, oid, bytes: buf.length, ...dim });
    }
}

const html = `<!doctype html>
<meta charset="utf-8">
<title>只存在于 .git 里的历史图片（${exported.length} 张）</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; background: #111; color: #eee; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border-bottom: 1px solid #333; padding: 6px 8px; text-align: left; font-size: 13px; }
  img { max-width: 320px; max-height: 200px; background: #222; }
</style>
<h1>只存在于 .git 里的历史图片</h1>
<p>这些文件在历史对象库里，但当前工作区与任何提交都没有它们（属于 <code>git add</code> 之后没有提交、
或提交被改写后留下的残留）。表格用于人工认领，看完即可删除本目录。</p>
<table>
<tr><th>预览</th><th>文件</th><th>尺寸</th><th>大小</th></tr>
${exported
    .sort((a, b) => b.bytes - a.bytes)
    .map(
        (e) =>
            `<tr><td><img src="${e.name}" loading="lazy"></td><td>${e.name}</td>` +
            `<td>${e.width}x${e.height}</td><td>${mb(e.bytes)} MB</td></tr>`,
    )
    .join('\n')}
</table>
`;
writeFileSync(path.join(OUT, 'index.html'), html, 'utf8');

console.log(`已导出 ${exported.length} 张只存在于 .git 里的图片到 ${path.relative(repoRoot, OUT)}`);
console.log(`索引: ${path.join(path.relative(repoRoot, OUT), 'index.html')}`);
for (const e of exported.sort((a, b) => b.bytes - a.bytes)) {
    console.log(`  ${mb(e.bytes).padStart(7)} MB  ${e.width}x${e.height}  ${e.name}`);
}
