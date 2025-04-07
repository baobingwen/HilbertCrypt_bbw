#

## 小土豆图片混淆

本程序使用python对小番茄混淆进行模仿（非完全模仿，目前无法混用）

## env

使用conda配置

-c conda-forge

- python==3.10.0
- pillow==11.1.0
- numpy==2.2.4
- opencv==4.11.0

## Notice

1. pyinstaller构建指令:
   
   pyinstaller --onefile --add-binary="D:\Bingwen_Bao\Anaconda3\envs\HilbertCrypt_Env\Library\bin\mkl_intel_thread.2.dll;." --hidden-import=numpy --hidden-import=PIL your_file.py
2. 打包好的程序由一个exe和一个处理文件夹组成

## Version

### v1.0

bbw_tphx.py

### v1.1

bbw_tphx_with_opencv.py