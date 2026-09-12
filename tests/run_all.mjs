// tests/run_all.mjs
// 一键跑完所有测试。
//
// 用法: node tests/run_all.mjs [--quick]
//   --quick  跳过耗时的端到端大图用例

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quick = process.argv.includes('--quick');

const SUITES = [
    { name: 'Rust 核心单元测试', cmd: 'cargo', args: ['test', '--release', '--quiet'], cwd: path.join(repoRoot, 'web', 'rs') },
    { name: '跨语言等价性', cmd: process.execPath, args: ['tests/cross_language.test.mjs'], cwd: repoRoot },
    { name: 'Web 端契约 + worker 往返', cmd: process.execPath, args: ['tests/web_ui.test.mjs'], cwd: repoRoot },
];

if (!quick) {
    SUITES.push({ name: '端到端 CLI', cmd: process.execPath, args: ['tests/e2e_cli.test.mjs'], cwd: repoRoot });
}

function run(cmd, args, cwd) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
        child.on('error', (e) => resolve({ code: -1, error: e }));
        child.on('close', (code) => resolve({ code }));
    });
}

const results = [];
for (const suite of SUITES) {
    console.log(`\n${'='.repeat(60)}\n▶ ${suite.name}\n${'='.repeat(60)}`);
    const res = await run(suite.cmd, suite.args, suite.cwd);
    results.push({ ...suite, ...res });
    if (res.error && res.error.code === 'ENOENT') {
        console.log(`○ 跳过：找不到命令 ${suite.cmd}`);
        results[results.length - 1].skipped = true;
    }
}

console.log(`\n${'='.repeat(60)}\n汇总\n${'='.repeat(60)}`);
let failed = 0;
for (const r of results) {
    const status = r.skipped ? '○ 跳过' : r.code === 0 ? '✓ 通过' : '✗ 失败';
    if (!r.skipped && r.code !== 0) failed++;
    console.log(`  ${status}  ${r.name}`);
}
process.exit(failed === 0 ? 0 : 1);
