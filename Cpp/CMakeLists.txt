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

    # 复制OpenCV DLL（MSYS2路径格式）
    # 直接指定MSYS2的DLL路径并验证文件存在性
    set(MSYS2_BIN_DIR "D:/msys64/mingw64/bin")
    set(OPENCV_DLLS
        "${MSYS2_BIN_DIR}/libgcc_s_seh-1.dll"
        "${MSYS2_BIN_DIR}/libstdc++-6.dll"
        "${MSYS2_BIN_DIR}/libwinpthread-1.dll"
        "${MSYS2_BIN_DIR}/libopencv_core-411.dll"
        "${MSYS2_BIN_DIR}/libopencv_imgproc-411.dll"
        "${MSYS2_BIN_DIR}/libopencv_highgui-411.dll"
        "${MSYS2_BIN_DIR}/libopencv_imgcodecs-411.dll"
        "${MSYS2_BIN_DIR}/libtbb12.dll"
        "${MSYS2_BIN_DIR}/libopenblas.dll"
        "${MSYS2_BIN_DIR}/libjpeg-8.dll"
        "${MSYS2_BIN_DIR}/libjbig-0.dll"
        "${MSYS2_BIN_DIR}/libOpenEXR-3_3.dll"
        "${MSYS2_BIN_DIR}/libOpenEXRCore-3_3.dll"
        "${MSYS2_BIN_DIR}/libopenjp2-7.dll"
        "${MSYS2_BIN_DIR}/libpng16-16.dll"
        "${MSYS2_BIN_DIR}/libtiff-6.dll"
        "${MSYS2_BIN_DIR}/libwebp-7.dll"
        "${MSYS2_BIN_DIR}/libwebpdemux-2.dll"
        "${MSYS2_BIN_DIR}/libwebpmux-3.dll"
        "${MSYS2_BIN_DIR}/libImath-3_1.dll"
        "${MSYS2_BIN_DIR}/libIlmThread-3_3.dll"
        "${MSYS2_BIN_DIR}/libIex-3_3.dll"
        "${MSYS2_BIN_DIR}/libdeflate.dll"
        "${MSYS2_BIN_DIR}/libLerc.dll"
        "${MSYS2_BIN_DIR}/libsharpyuv-0.dll"
    )

    # 逐个复制DLL文件并添加验证
    foreach(dll ${OPENCV_DLLS})
        if(EXISTS ${dll})
            add_custom_command(TARGET hilbert_encrypt POST_BUILD
                COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${dll}"
                ${OUTPUT_DIR}
                COMMENT "Copying ${dll}"
            )
        else()
            message(FATAL_ERROR "DLL文件不存在: ${dll}")
        endif()
    endforeach()
endif()