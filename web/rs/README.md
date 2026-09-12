# 构建 Web/WASM 核心

`web/src/wasm/lp_crypt_wasm_core.js` 与 `web/src/wasm/lp_crypt_wasm_core_bg.wasm`
由 `web/rs` 这个 Rust crate 生成。**不要手改这两个产物**，改 `web/rs/src/lib.rs` 后重新构建。

## 依赖

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| rustc / cargo | 1.86.0（任意 ≥1.70 的稳定版均可） | 需要 `wasm32-unknown-unknown` target |
| wasm-bindgen-cli | **0.2.100（必须与 `Cargo.toml` 中 `wasm-bindgen` 版本严格一致）** | 版本不匹配会导致 JS 胶水与 wasm 的 ABI 对不上 |

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.100 --locked
```

## 一键构建

```powershell
pwsh -File web/rs/build.ps1
```

脚本做的事：

1. `cargo build --release --target wasm32-unknown-unknown`
2. `wasm-bindgen --target web --reference-types --out-dir target/bindgen`
3. 把 `lp_crypt_wasm_core.js` 与 `lp_crypt_wasm_core_bg.wasm` 复制到 `web/src/wasm/`
4. 打印新产物的 SHA-256

## 手动构建

```bash
cd web/rs
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --reference-types \
  --out-dir target/bindgen --out-name lp_crypt_wasm_core \
  target/wasm32-unknown-unknown/release/lp_crypt_wasm_core.wasm
cp target/bindgen/lp_crypt_wasm_core.js target/bindgen/lp_crypt_wasm_core_bg.wasm ../../web/src/wasm/
```

## 验证

```bash
# 1. Rust 单元测试（曲线为双射、往返可逆、原地置换与直白写法等价……）
cd web/rs && cargo test --release

# 2. 与旧版二进制逐字节行为比对（导出表 / 曲线坐标 / 像素输出 / 边界行为）
node tests/wasm_parity.mjs <旧wasm> <新wasm>
```

关于 `--reference-types`：旧版 wasm 使用了带有 externref 表的 ABI（导出 `__wbindgen_export_0` 表），
不加该标志生成的胶水走的是另一套（无 externref 表）ABI。为保持与浏览器端行为一致，这里显式加上。

关于导出名：旧 blob 里分配器导出叫 `__wbindgen_malloc`，由本源码重建出的叫 `__wbindgen_export_1`。
两者都是 wasm-bindgen 的内部生成符号，不构成对外 API；**JS 胶水与 wasm 必须成对替换**，
`tests/wasm_parity.mjs` 会在归一化这些内部名之后逐项核对导出表。
