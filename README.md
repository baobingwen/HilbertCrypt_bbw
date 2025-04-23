# 小土豆图片混淆工具 / Potato Image Obfuscator

<!-- 顶部语言切换提示 -->
<details>
<summary>🌐 语言切换 / Language Switch</summary>

- [中文](#中文) | [English](#english)
</details>

---

<a id="中文"></a>

## 🇨🇳 中文文档

### 项目概述

一个基于希尔伯特曲线和黄金分割比优化的图片混淆工具，支持命令行（Python）和Web端（HTML/JS）两种使用方式。通过像素位移算法实现加密与解密，保障图像内容的安全性。

### 功能特性

#### 核心算法

- **希尔伯特曲线映射**：将图像像素按空间填充曲线重新排列
- **黄金分割比优化**：自动计算最佳位移参数，增强混淆强度
- **抗压缩处理**：默认输出PNG格式，保留图像质量

#### 双端支持

- **命令行工具**：批量处理`files`文件夹内的图片
- **Web界面**：支持拖放操作，实时预览处理结果

### 安装与配置

#### 命令行工具

```bash
conda create -n hilbert python=3.10 -c conda-forge
conda activate hilbert
pip install pillow==11.1.0 numpy==2.2.4
```

#### Web界面

直接浏览器打开 `index.html`（需与 `worker.js` 同目录）

### 使用示例

```bash
# 加密所有图片
python bbw_tphx_NumPy.py --encrypt

# 解密示例截图
![](docs/demo.gif)
```

---

<a id="english"></a>

## 🇺🇸 English Documentation

### Project Overview

An image obfuscation tool based on Hilbert curve and golden ratio optimization, supporting both CLI (Python) and Web (HTML/JS) interfaces. Implements pixel displacement algorithm for secure encryption/decryption.

### Key Features

#### Core Algorithm

- **Hilbert Curve Mapping**: Rearrange pixels via space-filling curve
- **Golden Ratio Optimization**: Auto-calculate optimal displacement
- **Compression Resistance**: PNG format output by default

#### Cross-Platform Support

- **CLI Tool**: Batch process images in `files` folder
- **Web UI**: Drag-and-drop operation with real-time preview

### Installation

#### CLI Tool

```bash
conda create -n hilbert python=3.10 -c conda-forge
conda activate hilbert
pip install pillow==11.1.0 numpy==2.2.4
```

#### Web Interface

Open `index.html` directly in browser (require `worker.js` in same folder)

### Usage Example

```bash
# Encrypt all images
python bbw_tphx_NumPy.py --encrypt

# Demo screenshot
![](docs/demo.gif)
```

---

## 通用内容 / Common Sections

### 项目结构 / Project Structure

```
.
├── bbw_tphx_NumPy.py        # CLI core
├── index.html               # Web UI
├── worker.js                # Web Worker
└── files/                   # Processing folder (auto-created)
```

### 注意事项 / Notes

- 🔸 Web版建议处理小于2000x2000像素的图片  
  *Web version recommended for images <2000x2000px*
- 🔸 命令行工具会覆盖原文件  
  *CLI tool will overwrite original files*
- 🔸 加密结果不跨平台兼容  
  *Encryption results are not cross-platform compatible*