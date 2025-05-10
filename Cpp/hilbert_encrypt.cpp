// Copyright [2025] <鲍炳文>

#include <windows.h>
#include <psapi.h>  // Required for GetProcessMemoryInfo
#include <iostream>
#include <vector>
#include <cmath>
#include <cstdlib>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <algorithm>
#include <numeric>
#include <thread>
#include <mutex>

// OpenCV用于图像读写和像素操作
#include <opencv2/opencv.hpp>

namespace fs = std::filesystem;
using std::cerr;
using std::cout;
using std::endl;
using std::lock_guard;
using std::mutex;
using std::string;
using std::to_string;
using std::thread;
using std::vector;
using cv::Mat;
using cv::Point;
using cv::Scalar;
using cv::Vec4b;
using cv::imread;
using cv::imwrite;
using cv::IMREAD_UNCHANGED;
using cv::IMREAD_ANYDEPTH;
using cv::IMWRITE_PNG_COMPRESSION;

// 图像格式和保存参数
struct ImageFormat {
    string extension;
    vector<int> write_params;  // 图像保存参数，如压缩级别、质量等
};

// 支持的图像格式和参数
const vector<ImageFormat> SUPPORTED_FORMATS = {
    // PNG 压缩级别，0 表示无压缩，9 表示最大压缩，数字越大，压缩率越高，速度越慢
    {".png", {cv::IMWRITE_PNG_COMPRESSION, 3}},
    {".jpg", {cv::IMWRITE_JPEG_QUALITY, 95}},  // JPEG 质量，范围 0-100，数字越大，质量越高，文件越大
    {".jpeg", {cv::IMWRITE_JPEG_QUALITY, 95}},
    {".bmp", {}},
    {".webp", {cv::IMWRITE_WEBP_QUALITY, 80}},
    {".tiff", {}},
    {".tif", {}}
};

mutex cout_mutex;  // 控制台输出锁

// 定义线程局部存储的上下文
struct ThreadContext {
    int file_index;     // 当前文件序号
    int total_files;    // 文件总数
    string filename;    // 当前处理的文件名（短名称）
};

// 声明为 thread_local，确保每个线程独立副本
thread_local ThreadContext current_ctx;

// 生成广义希尔伯特曲线的递归函数
void generate2d(int x, int y, int ax, int ay, int bx, int by, vector<Point>* coordinates) {
    int w = abs(ax + ay);  // 主方向上的宽度
    int h = abs(bx + by);  // 正交方向上的高度

    int dax = (ax == 0 ? 0 : ax > 0 ? 1 : -1);  // 主方向单位步长 (x)
    int day = (ay == 0 ? 0 : ay > 0 ? 1 : -1);  // 主方向单位步长 (y)
    int dbx = (bx == 0 ? 0 : bx > 0 ? 1 : -1);  // 正交方向单位步长 (x)
    int dby = (by == 0 ? 0 : by > 0 ? 1 : -1);  // 正交方向单位步长 (y)

    if (h == 1) {
        // 特殊情况：高度为1，沿主方向填充一行
        for (int i = 0; i < w; ++i) {
            coordinates->emplace_back(x, y);
            x += dax;
            y += day;
        }
        return;
    }

    if (w == 1) {
        // 特殊情况：宽度为1，沿正交方向填充一列
        for (int i = 0; i < h; ++i) {
            coordinates->emplace_back(x, y);
            x += dbx;
            y += dby;
        }
        return;
    }

    int ax2 = ax / 2, ay2 = ay / 2;  // 主方向分割
    int bx2 = bx / 2, by2 = by / 2;  // 正交方向分割

    int w2 = abs(ax2 + ay2);
    int h2 = abs(bx2 + by2);

    if (2 * w > 3 * h) {
        // 长矩形情况：仅沿主方向分割为两部分
        if ((w2 % 2) && (w > 2)) {
            // 优先偶数步长
            ax2 += dax;
            ay2 += day;
        }
        generate2d(x, y, ax2, ay2, bx, by, coordinates);
        generate2d(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by, coordinates);
    } else {
        // 标准情况：分割为三个部分（上、横、下）
        if ((h2 % 2) && (h > 2)) {
            // 优先偶数步长
            bx2 += dbx;
            by2 += dby;
        }
        generate2d(x, y, bx2, by2, ax2, ay2, coordinates);
        generate2d(x + bx2, y + by2, ax, ay, bx - bx2, by - by2, coordinates);
        generate2d(x + (ax - dax) + (bx2 - dbx), y + (ay - day) + (by2 - dby),
                    -bx2, -by2, -(ax - ax2), -(ay - ay2), coordinates);
    }
}

// 生成希尔伯特曲线坐标
vector<Point> generate_mapping(int width, int height) {
    /*
    * width: 图像宽度
    * height: 图像高度
    */

    auto log = [](const string& msg, bool is_error = false) {
        lock_guard<mutex> lock(cout_mutex);
        // 格式：[序号/总数] 文件名: 消息
        string prefix = "[" + to_string(current_ctx.file_index) + "/"
                        + to_string(current_ctx.total_files) + "] "
                        + current_ctx.filename + ": ";
        if (is_error) {
            cerr << prefix << msg << endl;
        } else {
            cout << prefix << msg << endl;
        }
    };

    if (width <= 0 || height <= 0) {
        log("错误：无效的图像尺寸 (" + to_string(width) + "x" + to_string(height) + ")", true);
        return {};
    }

    vector<Point> coordinates;  // 存储希尔伯特曲线坐标
    coordinates.reserve(width * height);  // 预分配内存

    log("正在生成希尔伯特曲线（" + to_string(width) + "x" + to_string(height) + ")...", false);

    auto start = std::chrono::high_resolution_clock::now();
    if (width >= height) {
        generate2d(0, 0, width, 0, 0, height, &coordinates);
    } else {
        generate2d(0, 0, 0, height, width, 0, &coordinates);
    }
    auto end = std::chrono::high_resolution_clock::now();
    std::chrono::duration<double> elapsed = end - start;
    log("希尔伯特曲线生成完成，耗时: " + to_string(elapsed.count()) + "秒", false);

    // 验证坐标数量
    if (coordinates.size() != static_cast<size_t>(width * height)) {
        log("错误：生成的坐标数量 ("
            + to_string(coordinates.size())
            + ") 不匹配图像像素数 ("
            + to_string(width * height) + ")",
            true);
        return {};
    }
    return coordinates;
}

// 复制像素函数
void copy_pixels(
    const cv::Mat& src_img,
    cv::Mat* dst_img,
    const vector<Point>& curve,
    int64_t total,
    int64_t offset,
    bool is_encrypt,
    int channels,
    int depth
) {
    int64_t progress_step = total / 10;  // 处理进度，每 10% 输出一次
    progress_step = progress_step == 0 ? 1 : progress_step;  // 避免除零错误

    // 预计算偏移方向
    auto get_indices = [offset, total](int i, bool encrypt) -> std::pair<int, int> {
        return encrypt
            ? std::make_pair(i, static_cast<int>((i + offset) % total))
            : std::make_pair(static_cast<int>((i + offset) % total), i);
    };

    for (int i = 0; i < total; ++i) {
        auto [src_idx, dest_idx] = get_indices(i, is_encrypt);
        const Point& src_p = curve[src_idx];
        const Point& dest_p = curve[dest_idx];

        // 根据通道数和深度复制像素
        if (depth == CV_8U) {
            if (channels == 1) {
                dst_img->at<uchar>(dest_p.y, dest_p.x) = src_img.at<uchar>(src_p.y, src_p.x);
            } else if (channels == 3) {
                const cv::Vec3b& src_pixel = src_img.at<cv::Vec3b>(src_p.y, src_p.x);
                cv::Vec3b& dst_pixel = dst_img->at<cv::Vec3b>(dest_p.y, dest_p.x);
                dst_pixel = src_pixel;
            } else if (channels == 4) {
                const cv::Vec4b& src_pixel = src_img.at<cv::Vec4b>(src_p.y, src_p.x);
                cv::Vec4b& dst_pixel = dst_img->at<cv::Vec4b>(dest_p.y, dest_p.x);
                dst_pixel = src_pixel;
            }
        } else if (depth == CV_16U) {
            // 类似处理16位深度
            if (channels == 1) {
                dst_img->at<ushort>(dest_p.y, dest_p.x) = src_img.at<ushort>(src_p.y, src_p.x);
            } else if (channels == 3) {
                const cv::Vec3w& src_pixel = src_img.at<cv::Vec3w>(src_p.y, src_p.x);
                cv::Vec3w& dst_pixel = dst_img->at<cv::Vec3w>(dest_p.y, dest_p.x);
                dst_pixel = src_pixel;
            } else if (channels == 4) {
                const cv::Vec4w& src_pixel = src_img.at<cv::Vec4w>(src_p.y, src_p.x);
                cv::Vec4w& dst_pixel = dst_img->at<cv::Vec4w>(dest_p.y, dest_p.x);
                dst_pixel = src_pixel;
            }
        }

        // 每 progress_step 输出进度，动态刷新同一行
        if (i % progress_step == 0) {
            int64_t progress = static_cast<int64_t>(i) * 100 / total;
            {
                lock_guard<mutex> lock(cout_mutex);
                // 动态刷新同一行
                cout << "[" << current_ctx.file_index << "/" << current_ctx.total_files << "] "
                    << current_ctx.filename << ": 正在复制像素... " << progress << "% \r";
                cout.flush();
            }
        }

        if (i == total - 1) {
            lock_guard<mutex> lock(cout_mutex);
            // 动态刷新同一行
            cout << "[" << current_ctx.file_index << "/" << current_ctx.total_files << "] "
                << current_ctx.filename << ": 正在复制像素... " << "100% \r";
            cout.flush();
            cout << endl;  // 进度输出结束输出换行
        }
    }
}

// 图像处理函数
void process_image(const string& input_path, const string& output_path, bool is_encrypt) {
    try {
        auto log = [](const string& msg, bool is_error = false) {
            lock_guard<mutex> lock(cout_mutex);
            // 格式：[序号/总数] 文件名: 消息
            string prefix = "[" + to_string(current_ctx.file_index) + "/"
                            + to_string(current_ctx.total_files) + "] "
                            + current_ctx.filename + ": ";
            if (is_error) {
                cerr << prefix << msg << endl;
            } else {
                cout << prefix << msg << endl;
            }
        };

        // 内存检查（Windows）
        PROCESS_MEMORY_COUNTERS memInfo;
        GetProcessMemoryInfo(GetCurrentProcess(), &memInfo, sizeof(memInfo));
        log("当前内存使用: " + to_string(memInfo.WorkingSetSize / (1024 * 1024)) + " MB", false);

        // 读取图像
        log("正在读取图像: " + input_path + " ...", false);
        auto start = std::chrono::high_resolution_clock::now();  // 记录开始时间
        Mat img = imread(input_path, IMREAD_UNCHANGED | IMREAD_ANYDEPTH);
        if (img.empty()) {
            log("错误：无法读取图像： " + input_path , true);
            return;
        }
        auto end = std::chrono::high_resolution_clock::now();  // 记录结束时间
        std::chrono::duration<double> elapsed = end - start;  // 计算耗时
        log("读取图片耗时: " + to_string(elapsed.count()) + "秒", false);  // 输出耗时

        // 检查图片扩展名
        string input_ext = fs::path(input_path).extension().string();
        transform(input_ext.begin(), input_ext.end(), input_ext.begin(), ::tolower);
        const ImageFormat* format = nullptr;
        for (const auto& fmt : SUPPORTED_FORMATS) {
            if (fmt.extension == input_ext) {
                format = &fmt;
                break;
            }
        }
        if (!format) {
            log("错误：不支持的图像格式: " + input_ext, true);
            return;
        }

        int width = img.cols, height = img.rows;
        int channels = img.channels();
        int depth = img.depth();

        // 检查图片通道数，仅支持 1、3、4 通道
        if (channels != 1 && channels != 3 && channels != 4) {
            log("错误：不支持的通道数 (" + to_string(channels) + ")", true);
            return;
        }

        // 检查图片位深度，仅支持 8位 和 16位
        if (depth != CV_8U && depth != CV_16U) {
            log("错误：不支持的像素深度 (" + to_string(depth) + ")", true);
            return;
        }

        auto curve = generate_mapping(width, height);
        int64_t total = width * height;

        // 检查曲线是否有效
        if (curve.empty()) {
            log("错误：无法生成有效的希尔伯特曲线映射", true);
            return;
        }
        if (curve.size() != static_cast<size_t>(total)) {
            log("错误：希尔伯特曲线点数 ("
                + to_string(curve.size())
                + ") 不匹配图像像素数 ("
                + to_string(total)
                + ")", true);
            return;
        }

        // 统一坐标边界验证
        for (const auto& p : curve) {
            if (p.x < 0 || p.x >= width || p.y < 0 || p.y >= height) {
                log("错误：曲线坐标 (" + to_string(p.x) + "," + to_string(p.y) + ") 越界", true);
                return;
            }
        }
        log("曲线坐标验证通过", false);

        Mat output_img(img.size(), img.type(), Scalar(0));  // 初始化输出图像为全零

        // 像素复制循环
        start = std::chrono::high_resolution_clock::now();  // 记录开始时间
        double golden_ratio = (sqrt(5) - 1) / 2;  // 黄金比例
        int64_t offset = round(golden_ratio * total);  // 计算偏移量

        copy_pixels(img, &output_img, curve, total, offset, is_encrypt, channels, depth);

        end = std::chrono::high_resolution_clock::now();  // 记录结束时间
        elapsed = end - start;  // 计算耗时
        log("像素复制完成，复制耗时: " + to_string(elapsed.count()) + "秒", false);  // 输出耗时

        // 验证数据（检查是否全零）
        Scalar sum = cv::sum(output_img);
        if (sum[0] == 0 && sum[1] == 0 && sum[2] == 0 && sum[3] == 0) {
            log("错误：输出图像数据全零", true);
            return;
        }

        // 检查目标文件是否可写
        if (fs::exists(output_path)) {
            std::ofstream test_write(output_path, std::ios::app);
            if (!test_write.is_open()) {
                log("错误：无法写入文件（权限受限或文件锁定）: " + output_path, true);
                return;
            }
            test_write.close();
        }

        log("正在保存图像(覆盖原文件): " + output_path + " ...", false);
        start = std::chrono::high_resolution_clock::now();

        string ext = fs::path(output_path).extension().string();
        transform(ext.begin(), ext.end(), ext.begin(), ::tolower);

        // 直接保存图像，无需转变图像通道

        if (!imwrite(output_path, output_img, format->write_params)) {
            log("错误：无法保存图像: " + output_path, true);
        }

        end = std::chrono::high_resolution_clock::now();
        elapsed = end - start;
        log("图像保存完成，耗时: " + to_string(elapsed.count()) + "秒", false);
        log((is_encrypt ? "混淆" : "解混淆") + string("完成"), false);
    } catch (const std::bad_alloc& e) {
        cerr << "内存分配错误: " << e.what() << endl;
    } catch (const std::exception& e) {
        cerr << "标准异常: " << e.what() << endl;
    } catch (...) {
        cerr << "未知异常发生" << endl;
    }
}

void process_file(const string& path, bool is_encrypt) {
    process_image(path, path, is_encrypt);
}

int main(int argc, char** argv) {
    SetConsoleOutputCP(CP_UTF8);

    // 解析命令行参数
    if (argc < 2) {
        cerr << "用法: " << argv[0] << " [-e | -d]" << endl;
        return 1;
    }
    bool encrypt = string(argv[1]) == "-e";

    string target_folder = "files";
    if (!fs::exists(target_folder)) {
        fs::create_directory(target_folder);
        cout << "已创建文件夹: " << fs::absolute(target_folder) << endl;
    }

    vector<string> files;
    vector<string> supported_exts = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff", ".tif"};
    for (const auto& entry : fs::directory_iterator(target_folder)) {
        string ext = entry.path().extension().string();
        transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
        if (find(supported_exts.begin(), supported_exts.end(), ext) != supported_exts.end()) {
            files.push_back(entry.path().string());
        }
    }

    if (files.empty()) {
        cerr << "文件夹内无符合支持格式的图像文件!" << endl;
        cout << "支持的图片格式: ";
        for (const auto& ext : supported_exts) {
            cout << ext << " ";
        }
        cout << endl;
        return 1;
    }

    auto start = std::chrono::high_resolution_clock::now();  // 记录开始时间

    // 多线程处理文件
    vector<thread> threads;
    for (size_t i = 0; i < files.size(); ++i) {
        threads.emplace_back([&, i]() {
            string path = files[i];
            {
                lock_guard<mutex> lock(cout_mutex);
                cout << "处理中 [" << i + 1 << "/" << files.size() << "] " << path << endl;
            }
            current_ctx = {
                static_cast<int>(i + 1),
                static_cast<int>(files.size()),
                fs::path(path).filename().string()
            };
            process_file(path, encrypt);
            {
                lock_guard<mutex> lock(cout_mutex);
                cout << "处理结束 [" << i + 1 << "/" << files.size() << "] " << path << endl;
            }
        });
    }

    for (auto& t : threads) {
        t.join();
    }

    {
        lock_guard<mutex> lock(cout_mutex);
        auto end = std::chrono::high_resolution_clock::now();  // 记录结束时间
        std::chrono::duration<double> elapsed = end - start;  // 计算耗时
        cout << "所有文件处理完成（共 " << files.size() << " 个文件）" << endl;
        cout << "总耗时: " << elapsed.count() << "秒" << endl;
    }

    return 0;
}
