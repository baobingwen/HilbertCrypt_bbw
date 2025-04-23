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

### 使用方法

#### Py版本

##### 配置环境

```bash
conda create -n hilbertCrypt python=3.10 -c conda-forge
conda activate hilbertCrypt
pip install pillow==11.1.0 numpy==2.2.4
```

##### 运行方法

1. 将图片放入`./files`文件夹里
2. 加密：命令行界面输入`python bbw_tphx_NumPy.py -d/--decrypt`
3. 解密：命令行界面输入`python bbw_tphx_NumPy.py -d/--decrypt`

#### Web界面

[稳定版本](https://baobingwen.github.io/tools/GilbertCrypt/test/)

[最新开发测试版本](https://baobingwen.github.io/tools/GilbertCrypt/test/)

<a id="english"></a>

暂无英文版说明，等待大版本再更新

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
- 🔸 命令行工具会覆盖原文件
- 🔸 加密结果暂不跨平台兼容