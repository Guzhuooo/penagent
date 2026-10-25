#include "httpx_core.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#include <atomic>
#include <chrono>
#include <future>
#include <iostream>
#include <limits>
#include <thread>

namespace {
using namespace std::chrono_literals;
void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}
template<class Function>
void expect(httpx::ErrorCode code, Function fn) {
    try { fn(); }
    catch (const httpx::Error& error) { require(error.code == code, "wrong stable error code"); return; }
    throw std::runtime_error("expected an httpx error");
}

// A single-use real HTTP peer. Bounded accepts/reads and atomic release avoid
// hanging CI on a failing client. No curl process, shell, or external service.
class Peer {
public:
    explicit Peer(std::string reply, bool stall = false) : reply_(std::move(reply)), stall_(stall) {
        socket_ = socket(AF_INET, SOCK_STREAM, 0);
        require(socket_ >= 0, "socket failed");
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (bind(socket_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0 || listen(socket_, 1) != 0) {
            close(socket_); throw std::runtime_error("bind/listen failed");
        }
        socklen_t size = sizeof(address);
        if (getsockname(socket_, reinterpret_cast<sockaddr*>(&address), &size) != 0) {
            close(socket_); throw std::runtime_error("getsockname failed");
        }
        port_ = ntohs(address.sin_port);
        worker_ = std::thread([this] { serve(); });
    }
    ~Peer() { release(); if (worker_.joinable()) worker_.join(); close(socket_); }
    Peer(const Peer&) = delete;
    Peer& operator=(const Peer&) = delete;
    std::string url() const { return "http://127.0.0.1:" + std::to_string(port_) + "/test"; }
    void release() { released_.store(true); }
    void waitReceived() {
        const auto deadline = std::chrono::steady_clock::now() + 3s;
        while (!received_.load() && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(5ms);
        require(received_.load(), "peer did not receive request");
    }
    std::string captured() { release(); if (worker_.joinable()) worker_.join(); return captured_; }
private:
    void serve() noexcept {
        pollfd descriptor{socket_, POLLIN, 0};
        if (poll(&descriptor, 1, 3000) <= 0) return;
        const int connection = accept(socket_, nullptr, nullptr);
        if (connection < 0) return;
        timeval timeout{3, 0};
        setsockopt(connection, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
        setsockopt(connection, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
        try {
            std::size_t target = std::string::npos;
            char buffer[4096];
            while (captured_.size() < 256 * 1024) {
                const auto bytes = recv(connection, buffer, sizeof(buffer), 0);
                if (bytes <= 0) break;
                captured_.append(buffer, static_cast<std::size_t>(bytes));
                const auto end = captured_.find("\r\n\r\n");
                if (end != std::string::npos && target == std::string::npos) {
                    target = end + 4;
                    const auto length = captured_.find("Content-Length: ");
                    if (length != std::string::npos && length < end) target += std::stoul(captured_.substr(length + 16));
                }
                if (target != std::string::npos && captured_.size() >= target) break;
            }
            received_.store(true);
            const auto deadline = std::chrono::steady_clock::now() + 5s;
            while (stall_ && !released_.load() && std::chrono::steady_clock::now() < deadline)
                std::this_thread::sleep_for(5ms);
            std::size_t offset = 0;
            while (offset < reply_.size()) {
                const auto sent = send(connection, reply_.data() + offset, reply_.size() - offset, MSG_NOSIGNAL);
                if (sent <= 0) break;
                offset += static_cast<std::size_t>(sent);
            }
        } catch (...) {}
        close(connection);
    }
    int socket_ = -1;
    uint16_t port_ = 0;
    std::string reply_, captured_;
    bool stall_;
    std::atomic<bool> received_{false}, released_{false};
    std::thread worker_;
};
std::string reply(const std::string& body, const std::string& status = "200 OK") {
    return "HTTP/1.1 " + status + "\r\nContent-Length: " + std::to_string(body.size()) +
        "\r\nConnection: close\r\n\r\n" + body;
}
httpx::Request request(const Peer& peer) {
    httpx::Request options;
    options.url = peer.url(); options.allowInsecureHttp = true; options.timeoutMs = 3000;
    return options;
}
std::shared_ptr<httpx::Cancellation> token() { return std::make_shared<httpx::Cancellation>(); }
void validationTests() {
    httpx::Request options;
    options.url = "https://example.com/v1?q=test";
    httpx::validate(options);
    for (const std::string url : {"", "example.com", "ftp://example.com", "https:///",
            "https://user:secret@example.com", "https://example.com/#fragment", "https://example.com/\r\nX:1",
            "http://127.0.0.1/", "https://example.com/\\other"}) {
        options.url = url;
        expect(httpx::ErrorCode::InvalidOptions, [&] { httpx::validate(options); });
    }
    options.allowInsecureHttp = true;
    for (const std::string url : {"http://127.0.0.1/", "http://10.1.2.3/", "http://172.16.2.3/",
            "http://192.168.1.2/", "http://[::1]/", "http://[fd00::1]/", "http://[::ffff:127.0.0.1]/"}) {
        options.url = url; httpx::validate(options);
    }
    for (const std::string url : {"http://example.com/", "http://localhost/", "http://8.8.8.8/",
            "http://172.32.1.2/", "http://0.0.0.0/", "http://[2001:4860::1]/", "http://[::]/",
            "http://[::ffff:8.8.8.8]/", "http://[fe80::1%25eth0]/"}) {
        options.url = url; expect(httpx::ErrorCode::InvalidOptions, [&] { httpx::validate(options); });
    }
    options.url = "https://example.com/";
    for (auto method : {"PUT", "get", "POST\r\n"}) {
        options.method = method; expect(httpx::ErrorCode::InvalidOptions, [&] { httpx::validate(options); });
    }
    options.method = "POST";
    options.body.assign(httpx::kMaxBody, 'x'); httpx::validate(options);
    options.body += 'x'; expect(httpx::ErrorCode::InvalidOptions, [&] { httpx::validate(options); });
    options.body = std::string("\xc0\xaf", 2);
    expect(httpx::ErrorCode::InvalidOptions, [&] { httpx::validate(options); });
    options.body = "";
    for (auto timeout : {0.0, -1.0, 1.5, std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()}) {
        options.timeoutMs = timeout; expect(httpx::ErrorCode::InvalidOptions, [&] { httpx::validate(options); });
    }
    options.timeoutMs = 1000000; httpx::validate(options); require(options.timeoutMs == 60000, "timeout not capped");
    for (const auto& header : std::vector<std::pair<std::string, std::string>>{
            {"Authorization", "Bearer secret\r\nX: bad"}, {"Bad:Name", "value"}, {"X-Test", std::string("a\0b", 3)},
            {"Content-Length", "999"}, {"Host", "evil.example"}, {"Transfer-Encoding", "chunked"},
            {"Expect", "100-continue"}, {"Accept-Encoding", "gzip"}}) {
        options.headers = {header}; expect(httpx::ErrorCode::InvalidOptions, [&] { httpx::validate(options); });
    }
    options.headers = {{"X-Test", "one"}, {"x-test", "two"}};
    expect(httpx::ErrorCode::InvalidOptions, [&] { httpx::validate(options); });
    options.headers = {{"Authorization", "Bearer fixture"}, {"Content-Type", "application/json"}};
    httpx::validate(options);
    options.method = "HEAD"; options.body = "body";
    expect(httpx::ErrorCode::InvalidOptions, [&] { httpx::validate(options); });
    require(httpx::validUtf8("\xf0\x9f\x92\xa1\xe4\xb8\xad"), "valid UTF-8 rejected");
    for (const std::string bad : {"\xed\xa0\x80", "\xf4\x90\x80\x80", "\x80", "\xe2\x82"})
        require(!httpx::validUtf8(bad), "invalid UTF-8 accepted");
}
void lifecycleTests() {
    httpx::RequestSlot slot;
    auto first = slot.begin();
    expect(httpx::ErrorCode::Busy, [&] { slot.begin(); });
    slot.cancel(); slot.cancel();
    require(first->cancelled.load(), "cancel did not signal token");
    expect(httpx::ErrorCode::Busy, [&] { slot.begin(); });
    require(slot.finish(first), "cancellation lost on finish");
    auto next = slot.begin(); require(!next->cancelled.load(), "new token inherited cancellation");
    slot.finish(first); expect(httpx::ErrorCode::Busy, [&] { slot.begin(); });
    require(!slot.finish(next), "normal completion marked cancelled");
    for (int i = 0; i < 100; ++i) {
        auto active = slot.begin();
        std::thread canceller([&] { slot.cancel(); });
        bool wasCancelled = slot.finish(active);
        canceller.join();
        require(wasCancelled == active->cancelled.load(), "stop/finish race lost cancellation");
    }
    auto active = slot.begin(); slot.close(); slot.close();
    require(active->cancelled.load(), "close did not cancel");
    slot.finish(active); expect(httpx::ErrorCode::Closed, [&] { slot.begin(); });
    std::shared_ptr<httpx::Cancellation> destroyed;
    { httpx::RequestSlot temporary; destroyed = temporary.begin(); }
    require(destroyed->cancelled.load(), "destruction did not cancel");
}
void transportTests() {
    {
        Peer peer(reply("{\"ok\":true}", "201 Created"));
        auto options = request(peer); options.method = "POST";
        options.body = std::string("utf8:\xe4\xb8\xad\0end", 12);
        options.headers = {{"Authorization", "Bearer fixture-secret"}, {"Content-Type", "application/json"}, {"X-Empty", ""}};
        const auto response = httpx::perform(options, token());
        require(response.statusCode == 201 && response.body == "{\"ok\":true}", "POST response mismatch");
        const auto wire = peer.captured();
        require(wire.find("POST /test HTTP/") == 0, "wrong wire method");
        require(wire.find("Authorization: Bearer fixture-secret\r\n") != std::string::npos, "auth header missing");
        require(wire.substr(wire.find("\r\n\r\n") + 4) == options.body, "UTF-8/NUL POST body truncated");
    }
    {
        Peer peer(reply("failure", "401 Unauthorized"));
        const auto response = httpx::perform(request(peer), token());
        require(response.statusCode == 401 && response.body == "failure", "HTTP errors must resolve with body");
    }
    {
        Peer peer("HTTP/1.1 200 OK\r\nContent-Length: 9999999\r\nConnection: close\r\n\r\n");
        auto options = request(peer); options.method = "HEAD";
        const auto response = httpx::perform(options, token());
        require(response.statusCode == 200 && response.body.empty(), "HEAD read a body");
    }
    {
        Peer peer("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/credential-leak\r\nContent-Length: 0\r\n\r\n");
        auto options = request(peer); options.headers = {{"Authorization", "Bearer fixture"}};
        require(httpx::perform(options, token()).statusCode == 302, "redirect was followed");
    }
    {
        Peer peer(reply(std::string(httpx::kMaxResponse, 'r')));
        require(httpx::perform(request(peer), token()).body.size() == httpx::kMaxResponse, "exact response limit rejected");
    }
    {
        Peer peer(reply(std::string(httpx::kMaxResponse + 1, 'r')));
        expect(httpx::ErrorCode::ResponseTooLarge, [&] { httpx::perform(request(peer), token()); });
    }
    {
        // Chunked responses cannot rely on Content-Length for the cap.
        const std::string chunk(httpx::kMaxResponse + 1, 'r');
        Peer peer("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n200001\r\n" + chunk + "\r\n0\r\n\r\n");
        expect(httpx::ErrorCode::ResponseTooLarge, [&] { httpx::perform(request(peer), token()); });
    }
    {
        Peer peer(reply(std::string("\xff", 1)));
        expect(httpx::ErrorCode::InvalidResponse, [&] { httpx::perform(request(peer), token()); });
    }
    {
        Peer peer(reply("late"), true);
        auto options = request(peer); options.timeoutMs = 100;
        expect(httpx::ErrorCode::Timeout, [&] { httpx::perform(options, token()); });
        peer.release();
    }
    {
        Peer peer(reply("late"), true);
        auto cancellation = token();
        auto work = std::async(std::launch::async, [&] {
            expect(httpx::ErrorCode::Cancelled, [&] { httpx::perform(request(peer), cancellation); });
        });
        peer.waitReceived();
        cancellation->cancelled.store(true);
        const bool finished = work.wait_for(2500ms) == std::future_status::ready;
        peer.release(); work.get(); require(finished, "progress cancellation was not prompt");
    }
    {
        // A truncated framed response is a transport failure, not success.
        Peer peer("HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nshort");
        expect(httpx::ErrorCode::Network, [&] { httpx::perform(request(peer), token()); });
    }
    {
        // HTTPS must perform TLS even when the test-only HTTP flag is present.
        Peer peer(reply("plaintext"));
        auto options = request(peer);
        options.url.replace(0, 4, "https"); options.timeoutMs = 500;
        // Peer expects HTTP headers, so a handshake timeout is also valid:
        // HTTPS must never return the peer's plaintext as a successful body.
        try {
            httpx::perform(options, token());
            throw std::runtime_error("HTTPS accepted a plaintext server");
        } catch (const httpx::Error& error) {
            require(error.code == httpx::ErrorCode::Tls || error.code == httpx::ErrorCode::Timeout ||
                error.code == httpx::ErrorCode::Network, "unexpected plaintext TLS failure");
        }
        peer.release();
    }
    {
        auto cancellation = token(); cancellation->cancelled.store(true);
        httpx::Request options; options.url = "https://example.com/";
        expect(httpx::ErrorCode::Cancelled, [&] { httpx::perform(options, cancellation); });
    }
}
} // namespace
int main() {
    try {
        httpx::initializeCurl();
        validationTests(); lifecycleTests(); transportTests();
        std::cout << "httpx validation, lifetime, and real loopback transport tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "httpx test failed: " << error.what() << '\n';
        return 1;
    }
}
