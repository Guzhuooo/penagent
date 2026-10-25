#include "httpx_core.h"

#include <curl/curl.h>
#include <arpa/inet.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>

#if LIBCURL_VERSION_NUM < 0x074F01
#error "httpx requires libcurl headers >= 7.79.1"
#endif

namespace httpx {
const char* errorName(ErrorCode code) noexcept {
    switch (code) {
    case ErrorCode::InvalidOptions: return "HTTPX_INVALID_OPTIONS";
    case ErrorCode::Busy: return "HTTPX_BUSY";
    case ErrorCode::Cancelled: return "HTTPX_CANCELLED";
    case ErrorCode::Timeout: return "HTTPX_TIMEOUT";
    case ErrorCode::ResponseTooLarge: return "HTTPX_RESPONSE_TOO_LARGE";
    case ErrorCode::Tls: return "HTTPX_TLS_ERROR";
    case ErrorCode::Network: return "HTTPX_NETWORK_ERROR";
    case ErrorCode::InvalidResponse: return "HTTPX_INVALID_RESPONSE";
    case ErrorCode::Closed: return "HTTPX_CLOSED";
    default: return "HTTPX_INTERNAL_ERROR";
    }
}
const char* errorMessage(ErrorCode code) noexcept {
    switch (code) {
    case ErrorCode::InvalidOptions: return "Invalid HTTP request options";
    case ErrorCode::Busy: return "A request is already in flight";
    case ErrorCode::Cancelled: return "Request cancelled";
    case ErrorCode::Timeout: return "Request timed out";
    case ErrorCode::ResponseTooLarge: return "Response exceeds 2 MiB";
    case ErrorCode::Tls: return "TLS verification or handshake failed";
    case ErrorCode::Network: return "HTTP transport failed";
    case ErrorCode::InvalidResponse: return "Response is not valid UTF-8 HTTP text";
    case ErrorCode::Closed: return "HTTP client is closed";
    default: return "HTTP client internal error";
    }
}
std::shared_ptr<Cancellation> RequestSlot::begin() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (closed_) throw Error(ErrorCode::Closed);
    if (active_) throw Error(ErrorCode::Busy);
    active_ = std::make_shared<Cancellation>();
    return active_;
}
bool RequestSlot::finish(const std::shared_ptr<Cancellation>& token) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!token || active_ != token) return true;
    const bool cancelled = token->cancelled.load();
    active_.reset();
    return cancelled;
}
void RequestSlot::cancel() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (active_) active_->cancelled.store(true);
}
void RequestSlot::close() {
    std::lock_guard<std::mutex> lock(mutex_);
    closed_ = true;
    if (active_) active_->cancelled.store(true);
}
void initializeCurl() {
    // Initialize on the JS thread before any SDK workers use curl. Do not call
    // global_cleanup: Falcon or another plugin may also use process-wide curl.
    static const CURLcode result = curl_global_init(CURL_GLOBAL_DEFAULT);
    if (result != CURLE_OK) throw Error(ErrorCode::Internal);
    const auto* version = curl_version_info(CURLVERSION_NOW);
    if (!version || version->version_num < 0x074F01 || !(version->features & CURL_VERSION_SSL) ||
        !(version->features & CURL_VERSION_ASYNCHDNS)) {
        // NOSIGNAL with synchronous DNS cannot enforce a bounded DNS timeout.
        throw Error(ErrorCode::Internal);
    }
}
bool validUtf8(const std::string& text) noexcept {
    std::size_t i = 0;
    while (i < text.size()) {
        const auto first = static_cast<unsigned char>(text[i++]);
        if (first < 0x80) continue;
        unsigned count;
        std::uint32_t value, minimum;
        if (first >= 0xc2 && first <= 0xdf) { count = 1; value = first & 0x1f; minimum = 0x80; }
        else if (first >= 0xe0 && first <= 0xef) { count = 2; value = first & 0x0f; minimum = 0x800; }
        else if (first >= 0xf0 && first <= 0xf4) { count = 3; value = first & 7; minimum = 0x10000; }
        else return false;
        if (count > text.size() - i) return false;
        while (count--) {
            const auto next = static_cast<unsigned char>(text[i++]);
            if ((next & 0xc0) != 0x80) return false;
            value = (value << 6) | (next & 0x3f);
        }
        if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return false;
    }
    return true;
}
namespace {
using Url = std::unique_ptr<CURLU, decltype(&curl_url_cleanup)>;
using Easy = std::unique_ptr<CURL, decltype(&curl_easy_cleanup)>;
using HeaderList = std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)>;
bool tokenChar(unsigned char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
        std::string("!#$%&'*+-.^_`|~").find(static_cast<char>(c)) != std::string::npos;
}
std::string lower(std::string text) {
    for (char& c : text) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
    return text;
}
std::string part(CURLU* url, CURLUPart which) {
    char* raw = nullptr;
    const auto rc = curl_url_get(url, which, &raw, 0);
    std::unique_ptr<char, decltype(&curl_free)> owned(raw, &curl_free);
    return rc == CURLUE_OK ? std::string(raw) : std::string();
}
bool present(CURLU* url, CURLUPart which) {
    char* raw = nullptr;
    const auto rc = curl_url_get(url, which, &raw, 0);
    curl_free(raw);
    return rc == CURLUE_OK;
}
bool localAddress(std::string host) {
    if (host.size() > 2 && host.front() == '[' && host.back() == ']') host = host.substr(1, host.size() - 2);
    in_addr v4{};
    if (inet_pton(AF_INET, host.c_str(), &v4) == 1) {
        const auto n = ntohl(v4.s_addr);
        return (n >> 24) == 127 || (n >> 24) == 10 || (n >> 20) == 0xac1 || (n >> 16) == 0xc0a8;
    }
    in6_addr v6{};
    if (inet_pton(AF_INET6, host.c_str(), &v6) != 1) return false;
    if (IN6_IS_ADDR_LOOPBACK(&v6)) return true;
    if ((v6.s6_addr[0] & 0xfe) == 0xfc) return true; // unique local IPv6
    if (IN6_IS_ADDR_V4MAPPED(&v6)) {
        const auto* p = &v6.s6_addr[12];
        return p[0] == 127 || p[0] == 10 || (p[0] == 172 && p[1] >= 16 && p[1] <= 31) ||
            (p[0] == 192 && p[1] == 168);
    }
    return false;
}
struct Transfer {
    const Cancellation* token;
    std::string body;
    bool overflow = false;
    bool allocationFailed = false;
};
std::size_t writeBody(char* data, std::size_t size, std::size_t count, void* opaque) noexcept {
    auto& state = *static_cast<Transfer*>(opaque);
    if (state.token->cancelled.load()) return 0;
    if (size && count > std::numeric_limits<std::size_t>::max() / size) { state.overflow = true; return 0; }
    const auto bytes = size * count;
    if (bytes > kMaxResponse - state.body.size()) { state.overflow = true; return 0; }
    try { state.body.append(data, bytes); }
    catch (...) { state.allocationFailed = true; return 0; }
    return bytes;
}
int progress(void* opaque, curl_off_t, curl_off_t, curl_off_t, curl_off_t) noexcept {
    return static_cast<Transfer*>(opaque)->token->cancelled.load() ? 1 : 0;
}
void checked(CURLcode rc) { if (rc != CURLE_OK) throw Error(ErrorCode::Internal); }
} // namespace

void validate(Request& request) {
    const auto invalid = [] { throw Error(ErrorCode::InvalidOptions); };
    if (request.url.empty() || request.url.size() > kMaxUrl) invalid();
    for (unsigned char c : request.url) if (c <= 0x20 || c >= 0x7f || c == '\\') invalid();
    // Require an absolute URL; curl's URL API otherwise permits guessed schemes.
    if (request.url.compare(0, 8, "https://") && request.url.compare(0, 7, "http://")) invalid();
    Url url(curl_url(), &curl_url_cleanup);
    if (!url) throw Error(ErrorCode::Internal);
    if (curl_url_set(url.get(), CURLUPART_URL, request.url.c_str(), 0) != CURLUE_OK) invalid();
    const auto scheme = part(url.get(), CURLUPART_SCHEME);
    const auto host = part(url.get(), CURLUPART_HOST);
    if (host.empty() || present(url.get(), CURLUPART_USER) || present(url.get(), CURLUPART_PASSWORD) ||
        present(url.get(), CURLUPART_OPTIONS) || present(url.get(), CURLUPART_FRAGMENT) ||
        present(url.get(), CURLUPART_ZONEID)) invalid();
    if (scheme != "https" && !(scheme == "http" && request.allowInsecureHttp && localAddress(host))) invalid();
    // Use precisely the parsed URL, including curl's canonical numeric host.
    request.url = part(url.get(), CURLUPART_URL);
    if (request.method != "GET" && request.method != "POST" && request.method != "HEAD") invalid();
    if (request.body.size() > kMaxBody || !validUtf8(request.body)) invalid();
    if (request.method != "POST" && !request.body.empty()) invalid();
    if (!std::isfinite(request.timeoutMs) || request.timeoutMs < 1 || std::floor(request.timeoutMs) != request.timeoutMs) invalid();
    request.timeoutMs = std::min(request.timeoutMs, static_cast<double>(kMaxTimeoutMs));
    if (request.headers.size() > kMaxHeaders) invalid();
    std::size_t bytes = 0;
    std::vector<std::string> names;
    for (const auto& header : request.headers) {
        if (header.first.empty() || header.first.size() > 256 || header.second.size() > kMaxHeaderBytes) invalid();
        for (unsigned char c : header.first) if (!tokenChar(c)) invalid();
        for (unsigned char c : header.second) if (c < 0x20 || c >= 0x7f) invalid();
        const auto name = lower(header.first);
        // Curl owns framing and authority. Disallow duplicate case variants.
        if (name == "host" || name == "content-length" || name == "transfer-encoding" ||
            name == "connection" || name == "proxy-authorization" || name == "expect" ||
            name == "accept-encoding" || name == "trailer" || name == "upgrade" ||
            std::find(names.begin(), names.end(), name) != names.end()) invalid();
        names.push_back(name);
        bytes += header.first.size() + header.second.size() + 4;
        if (bytes > kMaxHeaderBytes) invalid();
    }
}
Response perform(Request request, const std::shared_ptr<Cancellation>& token) {
    initializeCurl();
    validate(request);
    if (!token) throw Error(ErrorCode::Internal);
    if (token->cancelled.load()) throw Error(ErrorCode::Cancelled);
    Easy easy(curl_easy_init(), &curl_easy_cleanup);
    if (!easy) throw Error(ErrorCode::Internal);
    HeaderList headers(nullptr, &curl_slist_free_all);
    auto append = [&](const std::string& line) {
        auto* next = curl_slist_append(headers.get(), line.c_str());
        if (!next) throw Error(ErrorCode::Internal);
        headers.release();
        headers.reset(next);
    };
    append("Expect:");
    for (const auto& header : request.headers) {
        append(header.first + (header.second.empty() ? ";" : ": " + header.second));
    }
    Transfer transfer{token.get(), {}, false, false};
    auto set = [&](CURLoption option, auto value) { checked(curl_easy_setopt(easy.get(), option, value)); };
    set(CURLOPT_URL, request.url.c_str());
    set(CURLOPT_HTTPHEADER, headers.get());
    set(CURLOPT_NOSIGNAL, 1L);
    set(CURLOPT_TIMEOUT_MS, static_cast<long>(request.timeoutMs));
    set(CURLOPT_CONNECTTIMEOUT_MS, static_cast<long>(request.timeoutMs));
    set(CURLOPT_SSL_VERIFYPEER, 1L);
    set(CURLOPT_SSL_VERIFYHOST, 2L);
    set(CURLOPT_SSLVERSION, static_cast<long>(CURL_SSLVERSION_TLSv1_2));
    set(CURLOPT_FOLLOWLOCATION, 0L);
    set(CURLOPT_MAXREDIRS, 0L);
    set(CURLOPT_UNRESTRICTED_AUTH, 0L);
    set(CURLOPT_PROTOCOLS, static_cast<long>(CURLPROTO_HTTPS | (request.allowInsecureHttp ? CURLPROTO_HTTP : 0)));
    set(CURLOPT_REDIR_PROTOCOLS, static_cast<long>(CURLPROTO_HTTPS));
    set(CURLOPT_PROXY, ""); // Do not inherit proxy credentials/routing from the environment.
    set(CURLOPT_NETRC, static_cast<long>(CURL_NETRC_IGNORED));
    set(CURLOPT_ACCEPT_ENCODING, "identity");
    set(CURLOPT_WRITEFUNCTION, &writeBody);
    set(CURLOPT_WRITEDATA, &transfer);
    set(CURLOPT_NOPROGRESS, 0L);
    set(CURLOPT_XFERINFOFUNCTION, &progress);
    set(CURLOPT_XFERINFODATA, &transfer);
    if (request.method == "POST") {
        set(CURLOPT_POST, 1L);
        set(CURLOPT_POSTFIELDS, request.body.data());
        set(CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(request.body.size()));
    } else if (request.method == "HEAD") set(CURLOPT_NOBODY, 1L);
    else set(CURLOPT_HTTPGET, 1L);
    const auto rc = curl_easy_perform(easy.get());
    if (token->cancelled.load()) throw Error(ErrorCode::Cancelled);
    if (transfer.overflow) throw Error(ErrorCode::ResponseTooLarge);
    if (transfer.allocationFailed) throw Error(ErrorCode::Internal);
    if (rc == CURLE_OPERATION_TIMEDOUT) throw Error(ErrorCode::Timeout);
    if (rc == CURLE_PEER_FAILED_VERIFICATION || rc == CURLE_SSL_CONNECT_ERROR ||
        rc == CURLE_SSL_CERTPROBLEM || rc == CURLE_SSL_CACERT_BADFILE || rc == CURLE_SSL_CIPHER ||
        rc == CURLE_SSL_ISSUER_ERROR) throw Error(ErrorCode::Tls);
    if (rc != CURLE_OK) throw Error(ErrorCode::Network);
    long status = 0;
    checked(curl_easy_getinfo(easy.get(), CURLINFO_RESPONSE_CODE, &status));
    if (status < 100 || status > 599 || !validUtf8(transfer.body)) throw Error(ErrorCode::InvalidResponse);
    return {static_cast<int>(status), std::move(transfer.body)};
}
} // namespace httpx
