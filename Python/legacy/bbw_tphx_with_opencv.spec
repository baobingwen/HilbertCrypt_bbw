# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['bbw_tphx_with_opencv.py'],
    pathex=[],
    binaries=[('D:\\Bingwen_Bao\\Anaconda3\\envs\\HilbertCrypt_Env\\Library\\bin\\mkl_intel_thread.2.dll', '.')],
    datas=[],
    hiddenimports=['numpy', 'PIL'],
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
    name='bbw_tphx_with_opencv',
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
