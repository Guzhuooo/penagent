#pragma once

#include <atomic>
#include <cstddef>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace httpx {
constexpr std::size_t kMaxBody = 128 * 1024;
constexpr std::size_t kMaxResponse = 2 * 1024 * 1024;
constexpr std::size_t kMaxHeaders = 64;
constexpr std::size_t kMaxHeaderBytes = 16 * 1024;
constexpr std::size_t kMaxUrl = 8192;
constexpr long kMaxTimeoutMs = 60000;

enum class ErrorCode {
    InvalidOptions = 1, Busy = 2, Cancelled = 3, Timeout = 4,
    ResponseTooLarge = 5, Tls = 6, Network = 7, Internal = 8,
    InvalidResponse = 9, Closed = 10
};
const char* errorName(ErrorCode code) noexcept;
const char* errorMessage(ErrorCode code) noexcept;
class Error : public std::runtime_error {
public:
    explicit Error(ErrorCode code) : std::runtime_error(errorMessage(code)), code(code) {}
    ErrorCode code;
};

struct Request {
    std::string url;
    std::string method = "GET";
    std::vector<std::pair<std::string, std::string>> headers;
    std::string body;
    double timeoutMs = 30000;
    bool allowInsecureHttp = false;
};
struct Response { int statusCode = 0; std::string body; };
struct Cancellation { std::atomic<bool> cancelled{false}; };

// Reservation occurs on the JS thread, before SDK worker dispatch. cancel() does
// not release the slot: the old worker must exit before another request starts.
class RequestSlot {
public:
    std::shared_ptr<Cancellation> begin();
    bool finish(const std::shared_ptr<Cancellation>& token);
    void cancel();
    void close();
    ~RequestSlot() { close(); }
private:
    std::mutex mutex_;
    std::shared_ptr<Cancellation> active_;
    bool closed_ = false;
};

void initializeCurl();
bool validUtf8(const std::string& text) noexcept;
void validate(Request& request);
Response perform(Request request, const std::shared_ptr<Cancellation>& token);
} // namespace httpx
