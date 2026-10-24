#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <exception>
#include <limits>
#include <vector>

namespace {

constexpr int kPalette[4][3] = {
    {0, 0, 0},
    {255, 255, 255},
    {232, 176, 0},
    {200, 0, 0},
};

constexpr int kKernel[6][3] = {
    {1, 0, 1},
    {2, 0, 1},
    {-1, 1, 1},
    {0, 1, 1},
    {1, 1, 1},
    {0, 2, 1},
};

void set_error(char* error, int error_len, const char* message) {
    if (!error || error_len <= 0) {
        return;
    }
    std::strncpy(error, message, static_cast<std::size_t>(error_len - 1));
    error[error_len - 1] = '\0';
}

double clamp_byte(double value) {
    return std::max(0.0, std::min(255.0, value));
}

int nearest_index(const double* pixel, const int* allowed, int allowed_count) {
    int best = allowed[0];
    double best_dist = 1e30;
    for (int i = 0; i < allowed_count; ++i) {
        int idx = allowed[i];
        double dr = pixel[0] - kPalette[idx][0];
        double dg = pixel[1] - kPalette[idx][1];
        double db = pixel[2] - kPalette[idx][2];
        double dist = dr * dr + dg * dg + db * db;
        if (dist < best_dist) {
            best_dist = dist;
            best = idx;
        }
    }
    return best;
}

}  // namespace

namespace {

double wrap_unit(double value) {
    return value - std::floor(value);
}

double smooth_affinity(double value) {
    const double t = std::max(0.0, std::min(1.0, value));
    return t * t * (3.0 - 2.0 * t);
}

double hue_component(double p, double q, double hue) {
    const double t = wrap_unit(hue);
    if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
    if (t < 0.5) return q;
    if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    return p;
}

void natural_warm_pixel(double* pixel) {
    const double r = pixel[0] / 255.0;
    const double g = pixel[1] / 255.0;
    const double b = pixel[2] / 255.0;
    const double maximum = std::max({r, g, b});
    const double minimum = std::min({r, g, b});
    const double delta = maximum - minimum;
    const double lightness = (maximum + minimum) / 2.0;
    double saturation = 0.0;
    double hue = 0.0;
    if (delta > 1e-12) {
        const double denominator = lightness > 0.5 ? 2.0 - maximum - minimum : maximum + minimum;
        saturation = std::max(0.0, std::min(1.0, delta / std::max(denominator, 1e-12)));
        const double rc = (maximum - r) / delta;
        const double gc = (maximum - g) / delta;
        const double bc = (maximum - b) / delta;
        const double sector = maximum == r ? bc - gc : (maximum == g ? 2.0 + rc - bc : 4.0 + gc - rc);
        hue = 360.0 * wrap_unit(sector / 6.0);
    }

    double affinity = 0.0;
    if (hue > 300.0) affinity = smooth_affinity((hue - 300.0) / 50.0);
    else if (hue < 110.0) affinity = 1.0 - smooth_affinity((hue - 60.0) / 50.0);
    const double gain = std::max(0.0, std::min(1.0, 0.60 * affinity));
    saturation = std::max(0.0, std::min(1.0,
        std::pow(saturation, 1.0 - 0.75 * gain) * (1.0 - std::max(0.0, std::min(1.0, 0.25 * (1.0 - affinity))))));
    const double cool = std::max(-60.0, std::min(0.0, -0.25 * (1.0 - affinity) * (hue - 60.0)));
    const double shortest = 360.0 * wrap_unit((30.0 - hue + 540.0) / 360.0) - 180.0;
    const double warm = std::max(-18.0, std::min(18.0, 0.12 * shortest));
    hue = wrap_unit((hue + cool + affinity * warm) / 360.0);
    const double q = lightness < 0.5 ? lightness * (1.0 + saturation) : lightness + saturation - lightness * saturation;
    const double p = 2.0 * lightness - q;
    pixel[0] = clamp_byte(hue_component(p, q, hue + 1.0 / 3.0) * 255.0);
    pixel[1] = clamp_byte(hue_component(p, q, hue) * 255.0);
    pixel[2] = clamp_byte(hue_component(p, q, hue - 1.0 / 3.0) * 255.0);
}

void prepare_warm_photo(std::vector<double>& data, int width, int height) {
    const std::size_t count = static_cast<std::size_t>(width) * static_cast<std::size_t>(height);
    std::array<std::size_t, 256> histogram{};
    for (std::size_t i = 0; i < count; ++i) {
        const std::size_t base = i * 3;
        const double luma = 0.2126 * data[base] + 0.7152 * data[base + 1] + 0.0722 * data[base + 2];
        ++histogram[static_cast<std::size_t>(clamp_byte(std::floor(luma + 0.5)))];
    }
    const double low_target = 0.005 * static_cast<double>(count);
    const double high_target = 0.995 * static_cast<double>(count);
    int low = 0;
    int high = 255;
    std::size_t cumulative = 0;
    bool low_found = false;
    for (int i = 0; i < 256; ++i) {
        cumulative += histogram[static_cast<std::size_t>(i)];
        if (!low_found && static_cast<double>(cumulative) >= low_target) {
            low = i;
            low_found = true;
        }
        if (static_cast<double>(cumulative) >= high_target) {
            high = i;
            break;
        }
    }
    if (high - low >= 8) {
        const double scale = 228.0 / static_cast<double>(high - low);
        for (double& channel : data) channel = clamp_byte((channel - low) * scale + 18.0);
    }

    std::vector<double> horizontal(data.size());
    std::vector<double> blurred(data.size());
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            const std::size_t base = (static_cast<std::size_t>(y) * width + x) * 3;
            const std::size_t left = (static_cast<std::size_t>(y) * width + std::max(0, x - 1)) * 3;
            const std::size_t right = (static_cast<std::size_t>(y) * width + std::min(width - 1, x + 1)) * 3;
            for (int channel = 0; channel < 3; ++channel)
                horizontal[base + channel] = (data[left + channel] + 2.0 * data[base + channel] + data[right + channel]) / 4.0;
        }
    }
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            const std::size_t base = (static_cast<std::size_t>(y) * width + x) * 3;
            const std::size_t above = (static_cast<std::size_t>(std::max(0, y - 1)) * width + x) * 3;
            const std::size_t below = (static_cast<std::size_t>(std::min(height - 1, y + 1)) * width + x) * 3;
            for (int channel = 0; channel < 3; ++channel)
                blurred[base + channel] = (horizontal[above + channel] + 2.0 * horizontal[base + channel] + horizontal[below + channel]) / 4.0;
        }
    }
    for (std::size_t i = 0; i < data.size(); ++i) data[i] = clamp_byte(data[i] + 0.30 * (data[i] - blurred[i]));
}

void diffuse_warm_photo(std::vector<double>& data, int width, int height, std::uint8_t* out) {
    static const std::array<double, 256> decode = [] {
        std::array<double, 256> table{};
        for (int i = 0; i < 256; ++i) table[static_cast<std::size_t>(i)] = 255.0 * std::pow(i / 255.0, 1.75);
        return table;
    }();
    const double rho = decode[230];
    const double palette[4][3] = {{0, 0, 0}, {255, 255, 255}, {255, rho, 0}, {rho, 0, 0}};
    for (std::size_t i = 0; i < data.size(); i += 3) {
        natural_warm_pixel(data.data() + i);
        for (int channel = 0; channel < 3; ++channel)
            data[i + channel] = decode[static_cast<std::size_t>(std::floor(clamp_byte(data[i + channel]) + 0.5))];
    }
    for (int y = 0; y < height; ++y) {
        const int direction = y % 2 == 0 ? 1 : -1;
        for (int x = direction == 1 ? 0 : width - 1; x >= 0 && x < width; x += direction) {
            const std::size_t pos = static_cast<std::size_t>(y) * width + x;
            const std::size_t base = pos * 3;
            int chosen = 0;
            double best_distance = std::numeric_limits<double>::infinity();
            for (int candidate = 0; candidate < 4; ++candidate) {
                const double dr = data[base] - palette[candidate][0];
                const double dg = data[base + 1] - palette[candidate][1];
                const double db = data[base + 2] - palette[candidate][2];
                const double distance = dr * dr + dg * dg + db * db;
                if (distance < best_distance) {
                    best_distance = distance;
                    chosen = candidate;
                }
            }
            out[pos] = static_cast<std::uint8_t>(chosen);
            const int dx[4] = {direction, -direction, 0, direction};
            const int dy[4] = {0, 1, 1, 1};
            const double weights[4] = {7.0 / 16.0, 3.0 / 16.0, 5.0 / 16.0, 1.0 / 16.0};
            for (int channel = 0; channel < 3; ++channel) {
                const double error = (data[base + channel] - palette[chosen][channel]) * 0.85;
                for (int neighbor = 0; neighbor < 4; ++neighbor) {
                    const int nx = x + dx[neighbor];
                    const int ny = y + dy[neighbor];
                    if (nx >= 0 && nx < width && ny < height) {
                        const std::size_t target = (static_cast<std::size_t>(ny) * width + nx) * 3 + channel;
                        data[target] += error * weights[neighbor];
                    }
                }
            }
        }
    }
}

}  // namespace

// Fixed natural/std defaults. Transport indices remain K/W/Y/R; calibration is internal.
extern "C" int inksight_eink_warm(
    const std::uint8_t* rgb, int width, int height, std::size_t rgb_len,
    std::uint8_t* out, std::size_t out_len, char* error, int error_len
) noexcept {
    if (!rgb || !out || width <= 0 || height <= 0 || error_len < 0) {
        set_error(error, error_len, "invalid pointers or dimensions");
        return 1;
    }
    const std::size_t w = static_cast<std::size_t>(width);
    const std::size_t h = static_cast<std::size_t>(height);
    if (w > std::numeric_limits<std::size_t>::max() / h) {
        set_error(error, error_len, "pixel count overflow");
        return 2;
    }
    const std::size_t count = w * h;
    // Keep allocations bounded even for direct ABI callers outside validated HTTP routes.
    if (count > 16U * 1024U * 1024U || count > std::numeric_limits<std::size_t>::max() / (3 * sizeof(double))) {
        set_error(error, error_len, "image exceeds native size limit");
        return 2;
    }
    if (rgb_len != count * 3 || out_len != count) {
        set_error(error, error_len, "input/output buffer length mismatch");
        return 3;
    }
    try {
        std::vector<double> data(rgb, rgb + rgb_len);
        prepare_warm_photo(data, width, height);
        diffuse_warm_photo(data, width, height, out);
        return 0;
    } catch (const std::exception&) {
        set_error(error, error_len, "native warm processing allocation failed");
        return 4;
    } catch (...) {
        set_error(error, error_len, "native warm processing failed");
        return 4;
    }
}

extern "C" int inksight_atkinson_palette(
    const std::uint8_t* rgb,
    int width,
    int height,
    int colors,
    std::uint8_t* out,
    char* error,
    int error_len
) {
    if (!rgb || !out) {
        set_error(error, error_len, "null input/output pointer");
        return 1;
    }
    if (width <= 0 || height <= 0) {
        set_error(error, error_len, "invalid dimensions");
        return 2;
    }
    if (colors != 3 && colors != 4) {
        set_error(error, error_len, "colors must be 3 or 4");
        return 3;
    }

    const int allowed_3[] = {0, 1, 3};
    const int allowed_4[] = {0, 1, 2, 3};
    const int* allowed = colors == 3 ? allowed_3 : allowed_4;
    const int allowed_count = colors == 3 ? 3 : 4;

    const int pixel_count = width * height;
    std::vector<double> data(static_cast<std::size_t>(pixel_count) * 3);
    for (int i = 0; i < pixel_count * 3; ++i) {
        data[static_cast<std::size_t>(i)] = static_cast<double>(rgb[i]);
    }

    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            const int pos = y * width + x;
            const int base = pos * 3;
            double old_pixel[3] = {data[base], data[base + 1], data[base + 2]};
            int idx = nearest_index(old_pixel, allowed, allowed_count);
            out[pos] = static_cast<std::uint8_t>(idx);

            double err[3] = {
                old_pixel[0] - kPalette[idx][0],
                old_pixel[1] - kPalette[idx][1],
                old_pixel[2] - kPalette[idx][2],
            };

            for (const auto& step : kKernel) {
                const int nx = x + step[0];
                const int ny = y + step[1];
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                    continue;
                }
                const int nbase = (ny * width + nx) * 3;
                for (int channel = 0; channel < 3; ++channel) {
                    data[nbase + channel] = clamp_byte(
                        data[nbase + channel] + err[channel] * (static_cast<double>(step[2]) / 8.0)
                    );
                }
            }
        }
    }

    return 0;
}

extern "C" int inksight_atkinson_bw(
    const std::uint8_t* gray,
    int width,
    int height,
    std::uint8_t* out,
    char* error,
    int error_len
) {
    if (!gray || !out) {
        set_error(error, error_len, "null input/output pointer");
        return 1;
    }
    if (width <= 0 || height <= 0) {
        set_error(error, error_len, "invalid dimensions");
        return 2;
    }

    const int pixel_count = width * height;
    std::vector<double> data(static_cast<std::size_t>(pixel_count));
    for (int i = 0; i < pixel_count; ++i) {
        data[static_cast<std::size_t>(i)] = static_cast<double>(gray[i]);
    }

    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            const int pos = y * width + x;
            const double old_value = data[pos];
            const double new_value = old_value >= 128.0 ? 255.0 : 0.0;
            out[pos] = static_cast<std::uint8_t>(new_value);
            const double err = old_value - new_value;

            for (const auto& step : kKernel) {
                const int nx = x + step[0];
                const int ny = y + step[1];
                if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                    continue;
                }
                const int npos = ny * width + nx;
                data[npos] = clamp_byte(data[npos] + err * (static_cast<double>(step[2]) / 8.0));
            }
        }
    }

    return 0;
}
