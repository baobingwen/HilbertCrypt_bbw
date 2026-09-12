// Copyright [2025] <鲍炳文>
//
// 小土豆图片混淆 —— C++ 命令行版
//
// 算法：把 width×height 的矩形按**广义希尔伯特（Gilbert）曲线**展开，
//       再沿曲线做循环位移 (i + offset) % total。
//       与 web/rs 的 Rust/WASM 核心、Python 端算法逐字节等价。
//
// 用法：
//   hilbert_encrypt.exe -e [-o auto|<n>] [-j <n>] [--in-place] [--out-of-place]
//   hilbert_encrypt.exe -d [-o auto|<n>] [-j <n>] [--in-place] [--out-of-place]
//   hilbert_encrypt.exe --stdin-encrypt <w> <h> <total> <offset>   （跨语言测试通路）
//   hilbert_encrypt.exe --stdin-decrypt <w> <h> <total> <offset>

#include <windows.h>
#include <psapi.h>
#include <fcntl.h>
#include <io.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <numeric>
#include <optional>
#include <string>
#include <thread>
#include <vector>

// OpenCV 用于图像读写和像素操作
#include <opencv2/opencv.hpp>

namespace fs = std::filesystem;
using std::cerr;
using std::cout;
using std::endl;
using std::lock_guard;
using std::mutex;
using std::string;
using std::to_string;
using std::vector;
using cv::Mat;
using cv::Point;
using cv::Scalar;

// ---------------------------------------------------------------- 基本常量

// 曲线点类型：32 位有符号足够表达 [0, 46340] 范围内的坐标
using Coord = int32_t;

// 支持的图像格式（扩展名 -> 是否无损）
const vector<string> SUPPORTED_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff", ".tif"};

// 有损格式：混淆后再有损压缩会破坏像素对应关系，导致无法还原
inline bool is_lossy_extension(const string& ext) {
    return ext == ".jpg" || ext == ".jpeg" || ext == ".webp";
}

mutex cout_mutex;

// 每个文件处理时用到的上下文（用 thread_local 保证线程独立）
struct ThreadContext {
    size_t file_index = 0;
    size_t total_files = 0;
    string filename;
    bool quiet = false;
};

thread_local ThreadContext current_ctx;

// 统一的日志前缀：[序号/总数] 文件名:
string log_prefix() {
    if (current_ctx.total_files == 0) return {};
    return "[" + to_string(current_ctx.file_index) + "/" + to_string(current_ctx.total_files) + "] "
           + current_ctx.filename + ": ";
}

void log_line(const string& msg, bool is_error = false) {
    if (current_ctx.quiet) return;
    lock_guard<mutex> lock(cout_mutex);
    if (is_error) {
        cerr << log_prefix() << msg << endl;
    } else {
        cout << log_prefix() << msg << endl;
    }
}

// ---------------------------------------------------------------- 曲线生成

// 递归生成广义希尔伯特曲线（Jakub Červený 的 Gilbert 2D 算法）
void generate2d(Coord x, Coord y, Coord ax, Coord ay, Coord bx, Coord by, vector<Point>* coordinates) {
    const Coord w = std::abs(ax) + std::abs(ay);  // 主方向长度
    const Coord h = std::abs(bx) + std::abs(by);  // 正交方向长度

    const Coord dax = (ax == 0 ? 0 : ax > 0 ? 1 : -1);
    const Coord day = (ay == 0 ? 0 : ay > 0 ? 1 : -1);
    const Coord dbx = (bx == 0 ? 0 : bx > 0 ? 1 : -1);
    const Coord dby = (by == 0 ? 0 : by > 0 ? 1 : -1);

    if (h == 1) {
        // 平凡的横向填充
        for (Coord i = 0; i < w; ++i) {
            coordinates->emplace_back(x, y);
            x += dax;
            y += day;
        }
        return;
    }

    if (w == 1) {
        // 平凡的纵向填充
        for (Coord i = 0; i < h; ++i) {
            coordinates->emplace_back(x, y);
            x += dbx;
            y += dby;
        }
        return;
    }

    Coord ax2 = ax / 2, ay2 = ay / 2;
    Coord bx2 = bx / 2, by2 = by / 2;

    const Coord w2 = std::abs(ax2) + std::abs(ay2);
    const Coord h2 = std::abs(bx2) + std::abs(by2);

    if (2 * w > 3 * h) {
        // 长条情形：只沿主方向切成两段
        if ((w2 % 2) && (w > 2)) {
            ax2 += dax;
            ay2 += day;
        }
        generate2d(x, y, ax2, ay2, bx, by, coordinates);
        generate2d(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by, coordinates);
    } else {
        // 标准情形：上一步、一个长横段、下一步
        if ((h2 % 2) && (h > 2)) {
            bx2 += dbx;
            by2 += dby;
        }
        generate2d(x, y, bx2, by2, ax2, ay2, coordinates);
        generate2d(x + bx2, y + by2, ax, ay, bx - bx2, by - by2, coordinates);
        generate2d(x + (ax - dax) + (bx2 - dbx), y + (ay - day) + (by2 - dby),
                   -bx2, -by2, -(ax - ax2), -(ay - ay2), coordinates);
    }
}

// 生成覆盖 width×height 全部像素的曲线；失败时返回空表
vector<Point> generate_mapping(int width, int height) {
    if (width <= 0 || height <= 0) {
        log_line("错误：无效的图像尺寸 (" + to_string(width) + "x" + to_string(height) + ")", true);
        return {};
    }

    const int64_t total = static_cast<int64_t>(width) * static_cast<int64_t>(height);
    vector<Point> coordinates;
    coordinates.reserve(static_cast<size_t>(total));

    log_line("正在生成希尔伯特曲线（" + to_string(width) + "x" + to_string(height) + "）...");

    const auto start = std::chrono::high_resolution_clock::now();
    if (width >= height) {
        generate2d(0, 0, width, 0, 0, height, &coordinates);
    } else {
        generate2d(0, 0, 0, height, width, 0, &coordinates);
    }
    const auto end = std::chrono::high_resolution_clock::now();
    log_line("希尔伯特曲线生成完成，耗时: "
             + to_string(std::chrono::duration<double>(end - start).count()) + "秒");

    if (static_cast<int64_t>(coordinates.size()) != total) {
        log_line("错误：生成的坐标数量 (" + to_string(coordinates.size()) + ") 不匹配图像像素数 ("
                     + to_string(total) + ")",
                 true);
        return {};
    }

    // 曲线必须是双射，否则像素重排会丢数据
    int64_t w64 = width, h64 = height;
    vector<uint8_t> seen(static_cast<size_t>(total), 0);
    for (const auto& p : coordinates) {
        if (p.x < 0 || p.x >= width || p.y < 0 || p.y >= height) {
            log_line("错误：曲线坐标 (" + to_string(p.x) + "," + to_string(p.y) + ") 越界", true);
            return {};
        }
        const int64_t idx = static_cast<int64_t>(p.x) + static_cast<int64_t>(p.y) * w64;
        if (seen[static_cast<size_t>(idx)]) {
            log_line("错误：曲线重复覆盖像素 (" + to_string(p.x) + "," + to_string(p.y) + ")", true);
            return {};
        }
        seen[static_cast<size_t>(idx)] = 1;
    }
    (void)h64;
    log_line("曲线坐标验证通过");
    return coordinates;
}

// 黄金分割比默认偏移量（与 Web / Python 端完全一致的公式）
inline int64_t default_offset(int64_t total) {
    constexpr double kGoldenRatio = 0.6180339887498949;  // (sqrt(5)-1)/2
    return static_cast<int64_t>(std::llround(kGoldenRatio * static_cast<double>(total)));
}

// 归一化偏移量到 [0, total)
inline int64_t normalize_offset(int64_t offset, int64_t total) {
    if (total <= 0) return 0;
    int64_t m = offset % total;
    if (m < 0) m += total;
    return m;
}

// ---------------------------------------------------------------- 像素重排

// 原地循环置换：每个像素只搬运一次，峰值内存只有一个缓冲区
void permute_in_place(uint8_t* data, size_t total, size_t bytes_per_pixel,
                      const vector<Point>& curve, int row_bytes, int64_t shift) {
    if (total == 0 || shift % static_cast<int64_t>(total) == 0) return;

    auto offset_of = [&](size_t i) -> size_t {
        const Point& p = curve[i];
        return static_cast<size_t>(static_cast<int64_t>(p.y) * row_bytes
                                   + static_cast<int64_t>(p.x) * bytes_per_pixel);
    };

    vector<uint8_t> visited(total, 0);
    uint8_t saved[32];  // 最多 4 通道 × 16 位 = 8 字节，留足余量

    const size_t step = static_cast<size_t>(shift);
    for (size_t start = 0; start < total; ++start) {
        if (visited[start]) continue;

        const size_t start_p = offset_of(start);
        std::memcpy(saved, data + start_p, bytes_per_pixel);

        size_t to = start;
        do {
            visited[to] = 1;
            const size_t from = (to + total - step) % total;
            const size_t from_p = offset_of(from);
            const size_t to_p = offset_of(to);
            if (from == start) {
                std::memcpy(data + to_p, saved, bytes_per_pixel);
            } else {
                std::memmove(data + to_p, data + from_p, bytes_per_pixel);
            }
            to = from;
        } while (to != start);
    }
}

// 另开一份输出缓冲区（直白写法，用于对照/基准测试）；`shift` 语义与原地版一致
void permute_out_of_place(const uint8_t* src, uint8_t* dst, size_t total, size_t bytes_per_pixel,
                          const vector<Point>& curve, int row_bytes, int64_t shift) {
    if (total == 0) return;
    const size_t step = static_cast<size_t>(shift % static_cast<int64_t>(total));
    for (size_t i = 0; i < total; ++i) {
        const Point& s = curve[(i + total - step) % total];
        const Point& d = curve[i];
        const size_t s_p = static_cast<size_t>(static_cast<int64_t>(s.y) * row_bytes
                                               + static_cast<int64_t>(s.x) * bytes_per_pixel);
        const size_t d_p = static_cast<size_t>(static_cast<int64_t>(d.y) * row_bytes
                                               + static_cast<int64_t>(d.x) * bytes_per_pixel);
        std::memcpy(dst + d_p, src + s_p, bytes_per_pixel);
    }
}

// 把任意通道/深度的图像统一转成 CV_8UC4，便于统一重排
Mat normalize_to_rgba8(const Mat& img) {
    Mat out;
    switch (img.channels()) {
        case 1:
            cv::cvtColor(img, out, cv::COLOR_GRAY2BGRA);
            break;
        case 3:
            cv::cvtColor(img, out, cv::COLOR_BGR2BGRA);
            break;
        case 4:
            out = img;
            break;
        default:
            return {};
    }
    if (out.depth() != CV_8U) {
        double scale = (out.depth() == CV_16U) ? 1.0 / 257.0 : 1.0;
        out.convertTo(out, CV_8U, scale);
    }
    return out;
}

// 把 CV_8UC4 还原成原有的通道数与深度
Mat restore_from_rgba8(const Mat& rgba8, int channels, int depth) {
    Mat out;
    switch (channels) {
        case 1:
            cv::cvtColor(rgba8, out, cv::COLOR_BGRA2GRAY);
            break;
        case 3:
            cv::cvtColor(rgba8, out, cv::COLOR_BGRA2BGR);
            break;
        case 4:
        default:
            out = rgba8;
            break;
    }
    if (depth == CV_16U) {
        // 只支持 8 位与 16 位两种
        out.convertTo(out, CV_16U, 257.0);
    }
    return out;
}

// ---------------------------------------------------------------- 流程控制

struct Options {
    bool encrypt = true;
    int64_t offset = -1;  // -1 表示 auto
    int jobs = 0;         // 0 表示自动
    bool in_place = true; // 默认原地循环置换（更省内存）
    bool quiet = false;
    int jpeg_quality = 95;  // 0-100
    int webp_quality = 80;  // 0-100
};

// 按选项生成写参数（PNG 无损；JPEG/WebP 质量可调）
vector<int> write_params_for(const string& ext, const Options& opt) {
    if (ext == ".png") return {cv::IMWRITE_PNG_COMPRESSION, 3};
    if (ext == ".jpg" || ext == ".jpeg") return {cv::IMWRITE_JPEG_QUALITY, opt.jpeg_quality};
    if (ext == ".webp") return {cv::IMWRITE_WEBP_QUALITY, opt.webp_quality};
    return {};
}

// 处理单张图像：原地覆盖
bool process_image(const string& path, const Options& opt) {
    try {
        PROCESS_MEMORY_COUNTERS memInfo{};
        if (GetProcessMemoryInfo(GetCurrentProcess(), &memInfo, sizeof(memInfo))) {
            log_line("当前内存使用: " + to_string(memInfo.WorkingSetSize / (1024 * 1024)) + " MB");
        }

        const auto t_read_start = std::chrono::high_resolution_clock::now();
        Mat img = cv::imread(path, cv::IMREAD_UNCHANGED);
        const auto t_read_end = std::chrono::high_resolution_clock::now();
        if (img.empty()) {
            log_line("错误：无法读取图像： " + path, true);
            return false;
        }
        log_line("读取图片耗时: "
                 + to_string(std::chrono::duration<double>(t_read_end - t_read_start).count()) + "秒");

        // 检查扩展名
        string ext = fs::path(path).extension().string();
        std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) {
            return static_cast<char>(std::tolower(c));
        });
        if (std::find(SUPPORTED_EXTS.begin(), SUPPORTED_EXTS.end(), ext) == SUPPORTED_EXTS.end()) {
            log_line("错误：不支持的图像格式: " + ext, true);
            return false;
        }
        if (is_lossy_extension(ext)) {
            log_line("警告：" + ext + " 是有损格式，压缩会改变像素值，"
                     "混淆图可能无法完整还原。建议改用 PNG/TIFF。", true);
        }

        const int width = img.cols;
        const int height = img.rows;
        const int channels = img.channels();
        const int depth = img.depth();

        if (channels != 1 && channels != 3 && channels != 4) {
            log_line("错误：不支持的通道数 (" + to_string(channels) + ")", true);
            return false;
        }
        if (depth != CV_8U && depth != CV_16U) {
            log_line("错误：不支持的像素深度（仅支持 8/16 位）: " + to_string(depth), true);
            return false;
        }

        const int64_t total = static_cast<int64_t>(width) * static_cast<int64_t>(height);
        auto curve = generate_mapping(width, height);
        if (curve.empty()) {
            return false;
        }

        // 统一成 RGBA8 处理：浏览器端（WASM）也固定按 4 字节/像素处理，保证跨端一致
        const bool needs_conversion = (channels != 4) || (depth != CV_8U);
        Mat work = normalize_to_rgba8(img);
        if (work.empty()) {
            log_line("错误：图像通道转换失败", true);
            return false;
        }

        const int64_t offset = normalize_offset(
            opt.offset < 0 ? default_offset(total) : opt.offset, total);
        // 原地循环置换的语义是 direct[to] = 原 direct[to - shift]，
        // 因此加密取 offset，解密取 total - offset（与 Rust/WASM 的 process_pixels 一致）
        const int64_t shift = opt.encrypt ? offset : (total - offset) % total;

        const auto t_copy_start = std::chrono::high_resolution_clock::now();
        if (opt.in_place) {
            permute_in_place(work.data, static_cast<size_t>(total), 4, curve, work.step, shift);
        } else {
            Mat buffer = work.clone();
            permute_out_of_place(work.data, buffer.data, static_cast<size_t>(total), 4, curve,
                                 work.step, shift);
            work = buffer;
        }
        const auto t_copy_end = std::chrono::high_resolution_clock::now();
        log_line("像素重排完成，耗时: "
                 + to_string(std::chrono::duration<double>(t_copy_end - t_copy_start).count()) + "秒");

        Mat output = needs_conversion ? restore_from_rgba8(work, channels, depth) : work;

        // 原子写入：先写临时文件再替换，避免中途失败留下半张图。
        // 临时文件必须保留原扩展名，OpenCV 靠扩展名决定编码器。
        const fs::path target(path);
        fs::path tmp = target;
        tmp.replace_filename(target.stem().string() + ".hilbert-tmp" + target.extension().string());
        const auto t_write_start = std::chrono::high_resolution_clock::now();
        const vector<int> write_params = write_params_for(ext, opt);
        if (!cv::imwrite(tmp.string(), output, write_params)) {
            log_line("错误：无法写入临时文件: " + tmp.string(), true);
            std::error_code ec;
            fs::remove(tmp, ec);
            return false;
        }
        std::error_code ec;
        fs::rename(tmp, target, ec);
        if (ec) {
            // Windows 上跨卷或目标被占用时 rename 可能失败，退化为覆盖写
            log_line("临时文件改名失败（" + ec.message() + "），回退为直接覆盖写入", true);
            fs::remove(tmp, ec);
            if (!cv::imwrite(path, output, write_params)) {
                log_line("错误：无法保存图像: " + path, true);
                return false;
            }
        }
        const auto t_write_end = std::chrono::high_resolution_clock::now();
        log_line("图像保存完成，耗时: "
                 + to_string(std::chrono::duration<double>(t_write_end - t_write_start).count()) + "秒");
        log_line((opt.encrypt ? "混淆" : "解混淆") + string("完成"));
        return true;
    } catch (const std::bad_alloc& e) {
        log_line(string("内存分配错误: ") + e.what(), true);
    } catch (const std::exception& e) {
        log_line(string("标准异常: ") + e.what(), true);
    } catch (...) {
        log_line("未知异常发生", true);
    }
    return false;
}

// 收集目标文件夹内支持格式的图片
vector<string> collect_files(const string& folder) {
    vector<string> files;
    for (const auto& entry : fs::directory_iterator(folder)) {
        if (!entry.is_regular_file()) continue;
        string ext = entry.path().extension().string();
        std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) {
            return static_cast<char>(std::tolower(c));
        });
        if (std::find(SUPPORTED_EXTS.begin(), SUPPORTED_EXTS.end(), ext) != SUPPORTED_EXTS.end()) {
            files.push_back(entry.path().string());
        }
    }
    std::sort(files.begin(), files.end());
    return files;
}

// 用固定数量的工作线程处理文件列表（避免"每个文件一个线程"把机器打爆）
int process_folder(const string& folder, const Options& opt) {
    if (!fs::exists(folder)) {
        fs::create_directories(folder);
        cout << "已创建文件夹: " << fs::absolute(folder).string() << endl;
    }

    auto files = collect_files(folder);
    if (files.empty()) {
        cerr << "文件夹内无符合支持格式的图像文件!" << endl;
        cout << "支持的图片格式: ";
        for (const auto& ext : SUPPORTED_EXTS) cout << ext << " ";
        cout << endl;
        return 1;
    }

    unsigned hw = std::thread::hardware_concurrency();
    if (hw == 0) hw = 4;
    int jobs = opt.jobs > 0 ? opt.jobs : static_cast<int>(std::min<size_t>(files.size(), hw));
    jobs = std::max(1, std::min<int>(jobs, static_cast<int>(files.size())));

    cout << "开始处理 " << files.size() << " 个文件（并发 " << jobs << "）... 注意：本程序会覆盖原文件" << endl;

    const auto start = std::chrono::high_resolution_clock::now();
    std::atomic<size_t> next{0};
    std::atomic<int> ok_count{0};
    vector<std::thread> pool;
    pool.reserve(static_cast<size_t>(jobs));
    for (int t = 0; t < jobs; ++t) {
        pool.emplace_back([&]() {
            while (true) {
                const size_t index = next.fetch_add(1);
                if (index >= files.size()) break;
                const string path = files[index];
                current_ctx = ThreadContext{index + 1, files.size(),
                                            fs::path(path).filename().string(), opt.quiet};
                if (process_image(path, opt)) ok_count.fetch_add(1);
            }
        });
    }
    for (auto& th : pool) th.join();

    const auto end = std::chrono::high_resolution_clock::now();
    cout << "所有文件处理完成（成功 " << ok_count.load() << "/" << files.size() << " 个文件）" << endl;
    cout << "总耗时: " << std::chrono::duration<double>(end - start).count() << "秒" << endl;
    return ok_count.load() == static_cast<int>(files.size()) ? 0 : 1;
}

// ---------------------------------------------------------------- 原始通路

// 跨语言等价测试用的原始 RGBA 通路：stdin 收图像，stdout 吐图像
int run_raw_stream(bool encrypt, int width, int height, int64_t total_arg, int64_t offset_arg) {
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);

    const int64_t total = static_cast<int64_t>(width) * static_cast<int64_t>(height);
    if (width <= 0 || height <= 0 || total != total_arg) {
        cerr << "参数不合法: " << width << "x" << height << " total=" << total_arg << endl;
        return 2;
    }

    vector<uint8_t> buffer(static_cast<size_t>(total) * 4);
    size_t got = 0;
    while (got < buffer.size()) {
        const size_t n = std::fread(buffer.data() + got, 1, buffer.size() - got, stdin);
        if (n == 0) break;
        got += n;
    }
    if (got != buffer.size()) {
        cerr << "输入像素数据不足: 期望 " << buffer.size() << " 字节，收到 " << got << " 字节" << endl;
        return 2;
    }

    current_ctx = ThreadContext{1, 1, "stdin", true};
    auto curve = generate_mapping(width, height);
    if (curve.empty()) return 3;

    const int64_t offset = normalize_offset(offset_arg, total);
    const int64_t shift = encrypt ? offset : (total - offset) % total;
    // 连续排布的 RGBA 缓冲区，行跨度为 width * 4 字节
    permute_in_place(buffer.data(), static_cast<size_t>(total), 4, curve, width * 4, shift);

    std::fwrite(buffer.data(), 1, buffer.size(), stdout);
    std::fflush(stdout);
    return 0;
}

// ---------------------------------------------------------------- 入口

void print_usage(const char* argv0) {
    cout << "小土豆图片混淆 CLI（会覆盖原文件，请先备份）\n\n"
         << "用法: " << argv0 << " [-e | -d] [选项]\n\n"
         << "  -e, --encrypt        混淆 files/ 下的图片\n"
         << "  -d, --decrypt        解混淆 files/ 下的图片\n"
         << "  -o, --offset <值>    偏移量，auto 表示黄金分割比默认值（默认 auto）\n"
         << "  -j, --jobs <n>       并发线程数（默认 = 文件数与 CPU 核数的较小值）\n"
         << "      --in-place       原地循环置换（默认，省一半内存）\n"
         << "      --out-of-place   另开输出缓冲区（用于对照/基准测试）\n"
         << "      --jpeg-quality   0-100，默认 95（有损，会破坏可还原性）\n"
         << "      --webp-quality   0-100，默认 80（有损，会破坏可还原性）\n"
         << "  -q, --quiet          静默模式\n"
         << "  -h, --help           显示本帮助\n\n"
         << "注意：jpg/jpeg/webp 是有损格式，压缩会改变像素，混淆后可能无法完整还原；\n"
         << "      需要无损往返请使用 png/tiff/bmp。\n"
         << endl;
}

int main(int argc, char** argv) {
    SetConsoleOutputCP(CP_UTF8);

    Options opt;
    vector<string> args(argv + 1, argv + argc);

    if (args.empty()) {
        print_usage(argv[0]);
        return 1;
    }

    // 隐藏的原始通路（跨语言测试用），不走文件系统
    if (args[0] == "--stdin-encrypt" || args[0] == "--stdin-decrypt") {
        if (args.size() != 5) {
            cerr << "用法: " << args[0] << " <width> <height> <total> <offset>" << endl;
            return 2;
        }
        return run_raw_stream(args[0] == "--stdin-encrypt", std::stoi(args[1]), std::stoi(args[2]),
                              std::stoll(args[3]), std::stoll(args[4]));
    }

    bool mode_set = false;
    for (size_t i = 0; i < args.size(); ++i) {
        const string& a = args[i];
        if (a == "-h" || a == "--help") {
            print_usage(argv[0]);
            return 0;
        } else if (a == "-e" || a == "--encrypt") {
            opt.encrypt = true;
            mode_set = true;
        } else if (a == "-d" || a == "--decrypt") {
            opt.encrypt = false;
            mode_set = true;
        } else if (a == "-q" || a == "--quiet") {
            opt.quiet = true;
        } else if (a == "--jpeg-quality" || a == "--webp-quality") {
            if (i + 1 >= args.size()) {
                cerr << "缺少 " << a << " 的参数" << endl;
                return 1;
            }
            int quality = 0;
            try {
                quality = std::stoi(args[++i]);
            } catch (...) {
                cerr << "无法解析质量参数: " << args[i] << endl;
                return 1;
            }
            if (quality < 0 || quality > 100) {
                cerr << "质量参数必须在 0-100 之间: " << quality << endl;
                return 1;
            }
            if (a == "--jpeg-quality") {
                opt.jpeg_quality = quality;
            } else {
                opt.webp_quality = quality;
            }
        } else if (a == "--in-place") {
            opt.in_place = true;
        } else if (a == "--out-of-place") {
            opt.in_place = false;
        } else if (a == "-o" || a == "--offset") {
            if (i + 1 >= args.size()) {
                cerr << "缺少 --offset 的参数" << endl;
                return 1;
            }
            const string v = args[++i];
            if (v == "auto") {
                opt.offset = -1;
            } else {
                try {
                    opt.offset = std::stoll(v);
                } catch (...) {
                    cerr << "无法解析偏移量: " << v << endl;
                    return 1;
                }
            }
        } else if (a == "-j" || a == "--jobs") {
            if (i + 1 >= args.size()) {
                cerr << "缺少 --jobs 的参数" << endl;
                return 1;
            }
            try {
                opt.jobs = std::stoi(args[++i]);
            } catch (...) {
                cerr << "无法解析并发数: " << args[i] << endl;
                return 1;
            }
        } else {
            cerr << "未知参数: " << a << endl;
            print_usage(argv[0]);
            return 1;
        }
    }

    if (!mode_set) {
        cerr << "错误：必须指定 -e（混淆）或 -d（解混淆）" << endl;
        print_usage(argv[0]);
        return 1;
    }

    return process_folder("files", opt);
}
