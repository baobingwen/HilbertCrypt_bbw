# -*- mode: python ; coding: utf-8 -*-
# PyInstaller 打包配置（Python 版 CLI）。
#
# 入口是 Python/src/cli.py，算法在 Python/src/gilbert_core.py。
# 构建：
#     pyinstaller --onefile --add-data "src/gilbert_core.py;src" \
#         --hidden-import=numpy --hidden-import=PIL Python/src/cli.py
# 说明：历史上这里指向 bbw_tphx_NumPy.py（旧曲线算法，与 C++/Web 不兼容），
#       现已归档到 Python/legacy/。

a = Analysis(
    ['..\\src\\cli.py'],
    pathex=['..\\src'],
    binaries=[],
    datas=[],
    hiddenimports=['numpy', 'PIL', 'gilbert_core'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='hilbert_crypt',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
