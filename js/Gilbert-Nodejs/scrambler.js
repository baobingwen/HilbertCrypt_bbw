const { createCanvas, loadImage } = require('canvas');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { program } = require('commander');

// Gilbert 曲线生成算法
function gilbert2d(width, height) {
    const coordinates = [];
    if (width >= height) {
        generate2d(0, 0, width, 0, 0, height, coordinates);
    } else {
        generate2d(0, 0, 0, height, width, 0, coordinates);
    }
    return coordinates;
}

// 递归生成gilbert2D坐标
function generate2d(x, y, ax, ay, bx, by, coordinates) {
    const w = Math.abs(ax + ay);
    const h = Math.abs(bx + by);

    const dax = Math.sign(ax), day = Math.sign(ay); // unit major direction
    const dbx = Math.sign(bx), dby = Math.sign(by); // unit orthogonal direction

    if (h === 1) {
        // trivial row fill
        for (let i = 0; i < w; i++) {
            coordinates.push([x, y]);
            x += dax;
            y += day;
        }
        return;
    }

    if (w === 1) {
        // trivial column fill
        for (let i = 0; i < h; i++) {
            coordinates.push([x, y]);
            x += dbx;
            y += dby;
        }
        return;
    }

    let ax2 = Math.floor(ax / 2), ay2 = Math.floor(ay / 2);
    let bx2 = Math.floor(bx / 2), by2 = Math.floor(by / 2);

    const w2 = Math.abs(ax2 + ay2);
    const h2 = Math.abs(bx2 + by2);

    if (2 * w > 3 * h) {
        if ((w2 % 2) && (w > 2)) {
            // prefer even steps
            ax2 += dax;
            ay2 += day;
        }

        // long case: split in two parts only
        generate2d(x, y, ax2, ay2, bx, by, coordinates);
        generate2d(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by, coordinates);

    } else {
        if ((h2 % 2) && (h > 2)) {
            // prefer even steps
            bx2 += dbx;
            by2 += dby;
        }

        // standard case: one step up, one long horizontal, one step down
        generate2d(x, y, bx2, by2, ax2, ay2, coordinates);
        generate2d(x + bx2, y + by2, ax, ay, bx - bx2, by - by2, coordinates);
        generate2d(x + (ax - dax) + (bx2 - dbx), y + (ay - day) + (by2 - dby),
            -bx2, -by2, -(ax - ax2), -(ay - ay2), coordinates);
    }
}

// 加密函数（兼容Node.js）
async function encryptImage(inputPath, outputPath) {
    try {
    // 使用sharp读取图片并转换为RGBA缓冲区
    const { data, info } = await sharp(inputPath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const width = info.width;
    const height = info.height;
    const curve = gilbert2d(width, height);
    const totalPixels = width * height;
    const offset = Math.round((Math.sqrt(5) - 1) / 2 * totalPixels);

    // 创建新像素缓冲区
    const newData = Buffer.alloc(data.length);
    
    // 执行像素置换
    for (let i = 0; i < totalPixels; i++) {
        const oldPos = curve[i];
        const newPos = curve[(i + offset) % totalPixels];
        
      // 计算缓冲区位置（4通道RGBA）
      const oldIndex = (oldPos[0] + oldPos[1] * width) * 4;
      const newIndex = (newPos[0] + newPos[1] * width) * 4;
        
        data.copy(newData, newIndex, oldIndex, oldIndex + 4);
    }

    // 保存结果
    await sharp(newData, { raw: info })
        .toFile(outputPath);
    console.log(`加密完成: ${outputPath}`);

    } catch (err) {
    console.error('处理失败:', err);
    }
}

// 解密函数（兼容Node.js）
async function decryptImage(inputPath, outputPath) {
    console.log(`解密开始: ${inputPath}`);
    console.log(`输出路径: ${outputPath}`);

    try {
        const { data, info } = await sharp(inputPath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

        const width = info.width;
        const height = info.height;
        const curve = gilbert2d(width, height);
        const totalPixels = width * height;
        const offset = Math.round((Math.sqrt(5) - 1) / 2 * totalPixels);
        
        const newData = Buffer.alloc(data.length);
        
        // 逆向置换逻辑
        for (let i = 0; i < totalPixels; i++) {
            const encryptedPos = curve[i];
            const originalPos = curve[(i - offset + totalPixels) % totalPixels]; // 反向计算
    
            const encryptedIndex = (encryptedPos[0] + encryptedPos[1] * width) * 4;
            const originalIndex = (originalPos[0] + originalPos[1] * width) * 4;
            
            data.copy(newData, originalIndex, encryptedIndex, encryptedIndex + 4);
        }

        await sharp(newData, { raw: info })
            .toFile(outputPath);
        console.log(`解密完成: ${outputPath}`);

    } catch (err) {
        console.error('解密失败:', err);
    }
}

// 命令行配置
program
    .command('encrypt <input> <output>')
    .description('加密图片')
    .action(encryptImage);

program
    .command('decrypt <input> <output>')
    .description('解密图片')
    .action(decryptImage);

// 批量处理支持
program
    .command('batch <folder> <mode>')
    .description('批量处理文件夹（encrypt/decrypt）')
    .action(async (folder, mode) => {
        const validModes = ['encrypt', 'decrypt'];
        if (!validModes.includes(mode)) {
            console.error('模式错误，请使用 encrypt 或 decrypt');
            return;
        }

        const files = fs.readdirSync(folder).filter(f => 
            /\.(png|jpe?g)$/i.test(f)
        );

        for (const file of files) {
            const input = path.join(folder, file);
            const prefix = mode === 'encrypt' ? 'encrypted_' : 'decrypted_';
            const output = path.join(folder, `${prefix}${file}`);
            
            if (mode === 'encrypt') {
                await encryptImage(input, output);
            } else {
                await decryptImage(input, output);
            }
        }
    });

// 命令行解析
program.parse(process.argv);