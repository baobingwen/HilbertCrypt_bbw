cmake_minimum_required(VERSION 3.21)
project(HilbertEncrypt LANGUAGES CXX)

# 设置C++标准
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# 设置输出目录到源代码目录下的bin文件夹
set(OUTPUT_DIR ${CMAKE_SOURCE_DIR}/bin)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${OUTPUT_DIR})
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${OUTPUT_DIR})

# 指定OpenCV配置路径
set(OpenCV_DIR "D:/msys64/mingw64/lib/cmake/opencv4")
find_package(OpenCV REQUIRED COMPONENTS core imgproc highgui imgcodecs)

# 添加可执行文件
add_executable(hilbert_encrypt
    hilbert_encrypt.cpp
)

# 包含目录
target_include_directories(hilbert_encrypt PRIVATE
    ${OpenCV_INCLUDE_DIRS}
)

# 链接库
target_link_libraries(hilbert_encrypt PRIVATE
    ${OpenCV_LIBS}
    psapi
)

# Windows/MinGW特定设置
if(WIN32)
    # 创建目标bin目录
    add_custom_command(TARGET hilbert_encrypt PRE_BUILD
        COMMAND ${CMAKE_COMMAND} -E make_directory ${OUTPUT_DIR}
    )

    # 复制运行时依赖 DLL（MSYS2 路径格式）
    # 不写死具体版本号：OpenCV 的 DLL 名带 ABI 版本（如 libopencv_core-412.dll），
    # 写死会在升级 OpenCV 后直接 FATAL_ERROR（历史上就因此踩过坑）。
    set(MSYS2_BIN_DIR "D:/msys64/mingw64/bin")
    set(RUNTIME_DLL_NAMES
        "libgcc_s_seh-1.dll"
        "libstdc++-6.dll"
        "libwinpthread-1.dll"
        "libtbb12.dll"
        "libopenblas.dll"
        "libjpeg-8.dll"
        "libjbig-0.dll"
        "libOpenEXR-3_3.dll"
        "libOpenEXRCore-3_3.dll"
        "libopenjp2-7.dll"
        "libpng16-16.dll"
        "libtiff-6.dll"
        "libwebp-7.dll"
        "libwebpdemux-2.dll"
        "libwebpmux-3.dll"
        "libImath-3_1.dll"
        "libIlmThread-3_3.dll"
        "libIex-3_3.dll"
        "libdeflate.dll"
        "libLerc.dll"
        "libsharpyuv-0.dll"
    )

    set(DLLS_TO_COPY "")
    foreach(name ${RUNTIME_DLL_NAMES})
        if(EXISTS "${MSYS2_BIN_DIR}/${name}")
            list(APPEND DLLS_TO_COPY "${MSYS2_BIN_DIR}/${name}")
        endif()
    endforeach()

    # OpenCV 核心库：按实际安装的 ABI 版本通配匹配
    file(GLOB OPENCV_DLLS "${MSYS2_BIN_DIR}/libopencv_core-*.dll"
                          "${MSYS2_BIN_DIR}/libopencv_imgproc-*.dll"
                          "${MSYS2_BIN_DIR}/libopencv_imgcodecs-*.dll"
                          "${MSYS2_BIN_DIR}/libopencv_highgui-*.dll")
    if(NOT OPENCV_DLLS)
        message(WARNING "在 ${MSYS2_BIN_DIR} 下没找到 OpenCV 运行时 DLL，"
                        "编译产物需要手动保证 DLL 可被找到（PATH 或复制到 bin/）")
    endif()

    foreach(dll ${DLLS_TO_COPY} ${OPENCV_DLLS})
        add_custom_command(TARGET hilbert_encrypt POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${dll}"
            ${OUTPUT_DIR}
            COMMENT "Copying ${dll}"
        )
    endforeach()
endif()