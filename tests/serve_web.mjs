// tests/serve_web.mjs
// 本地静态服务器，用于在浏览器里手工验证 web/src（正确设置 wasm 的 MIME 类型，
// 否则浏览器会退化成非流式的 WebAssembly.instantiate）。
//
// 用法: node tests/serve_web.mjs [端口]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(repoRoot, 'web', 'src');
const port = Number(process.argv[2] ?? 8080);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.wasm': 'application/wasm',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
    try {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

        // 防目录穿越
        if (!filePath.startsWith(ROOT)) {
            res.writeHead(403).end('forbidden');
            return;
        }

        const info = await stat(filePath).catch(() => null);
        if (info && info.isDirectory()) filePath = path.join(filePath, 'index.html');

        const data = await readFile(filePath);
        const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
        res.writeHead(200, {
            'Content-Type': type,
            'Cache-Control': 'no-store',
            // 让 SharedArrayBuffer 之类的实验特性也能用（当前未使用，留着方便后续多线程 wasm）
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        });
        res.end(data);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 not found');
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log(`web/src 已挂载: http://127.0.0.1:${port}/`);
    console.log('（Ctrl+C 停止）');
});
