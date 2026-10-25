#include "httpx_core.h"

#include <jquick_config.h>
#include <jsmodules/JSCModuleExtension.h>
#include <jqutil_v2/JQFunctionTemplate.h>
#include <jqutil_v2/JQTemplateEnv.h>
#include <cstring>

using namespace JQUTIL_NS;

namespace {
void reject(const JQAsyncInfo& info, httpx::ErrorCode code) {
    info.postError(JQErrorDesc(httpx::errorName(code), httpx::errorMessage(code), static_cast<int>(code)));
}

// Read only the known shallow fields. The SDK's default recursive serializer
// has no depth bound and would recurse indefinitely for cyclic option objects.
class Value {
public:
    Value(JSContext* ctx, JSValue value) : ctx_(ctx), value_(value) {
        if (JS_IsException(value)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            throw httpx::Error(httpx::ErrorCode::InvalidOptions);
        }
    }
    ~Value() { JS_FreeValue(ctx_, value_); }
    Value(const Value&) = delete;
    Value& operator=(const Value&) = delete;
    JSValue get() const { return value_; }
private:
    JSContext* ctx_;
    JSValue value_;
};
Bson readPrimitive(JSContext* ctx, JSValue value, Bson::Type type, std::size_t limit = 0) {
    if (type == Bson::STRING) {
        if (!JS_IsString(value)) throw httpx::Error(httpx::ErrorCode::InvalidOptions);
        std::size_t size = 0;
        const char* raw = JS_ToCStringLen(ctx, &size, value);
        if (!raw) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            throw httpx::Error(httpx::ErrorCode::InvalidOptions);
        }
        struct CString {
            JSContext* ctx; const char* raw;
            ~CString() { JS_FreeCString(ctx, raw); }
        } owned{ctx, raw};
        if (size > limit) throw httpx::Error(httpx::ErrorCode::InvalidOptions);
        return Bson(std::string(raw, size));
    }
    if (type == Bson::BOOL && JS_IsBool(value)) return Bson(JS_ToBool(ctx, value) == 1);
    if (type == Bson::DOUBLE && JS_IsNumber(value)) {
        double number;
        if (JS_ToFloat64(ctx, &number, value) == 0) return Bson(number);
        JS_FreeValue(ctx, JS_GetException(ctx));
    }
    throw httpx::Error(httpx::ErrorCode::InvalidOptions);
}
Bson readOptions(JQPrepareInfo& prepare) {
    auto* ctx = prepare.context();
    if (prepare.argc() != 1 || !JS_IsObject(prepare.argv()[0]) || JS_IsArray(ctx, prepare.argv()[0]) != 0)
        throw httpx::Error(httpx::ErrorCode::InvalidOptions);
    const auto opts = prepare.argv()[0];
    Bson::object result;
    struct Field { const char* name; Bson::Type type; std::size_t limit; };
    for (const auto& field : {Field{"url", Bson::STRING, httpx::kMaxUrl},
                             Field{"method", Bson::STRING, 4},
                             Field{"body", Bson::STRING, httpx::kMaxBody},
                             Field{"timeoutMs", Bson::DOUBLE, 0},
                             Field{"allowInsecureHttp", Bson::BOOL, 0}}) {
        Value value(ctx, JS_GetPropertyStr(ctx, opts, field.name));
        if (!JS_IsUndefined(value.get())) result.emplace(field.name, readPrimitive(ctx, value.get(), field.type, field.limit));
    }
    Value headers(ctx, JS_GetPropertyStr(ctx, opts, "headers"));
    if (!JS_IsUndefined(headers.get())) {
        if (!JS_IsObject(headers.get()) || JS_IsArray(ctx, headers.get()) != 0)
            throw httpx::Error(httpx::ErrorCode::InvalidOptions);
        JSPropertyEnum* props = nullptr;
        uint32_t count = 0;
        if (JS_GetOwnPropertyNames(ctx, &props, &count, headers.get(), JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            throw httpx::Error(httpx::ErrorCode::InvalidOptions);
        }
        struct Properties {
            JSContext* ctx; JSPropertyEnum* props; uint32_t count;
            ~Properties() {
                for (uint32_t i = 0; i < count; ++i) JS_FreeAtom(ctx, props[i].atom);
                js_free(ctx, props);
            }
        } owned{ctx, props, count};
        if (count > httpx::kMaxHeaders) throw httpx::Error(httpx::ErrorCode::InvalidOptions);
        Bson::object map;
        std::size_t bytes = 0;
        for (uint32_t i = 0; i < count; ++i) {
            Value key(ctx, JS_AtomToString(ctx, props[i].atom));
            auto name = readPrimitive(ctx, key.get(), Bson::STRING, 256).string_value();
            Value value(ctx, JS_GetProperty(ctx, headers.get(), props[i].atom));
            auto text = readPrimitive(ctx, value.get(), Bson::STRING, httpx::kMaxHeaderBytes);
            bytes += name.size() + text.string_value().size() + 4;
            if (bytes > httpx::kMaxHeaderBytes) throw httpx::Error(httpx::ErrorCode::InvalidOptions);
            map.emplace(std::move(name), std::move(text));
        }
        result.emplace("headers", Bson(map));
    }
    return Bson(result);
}
httpx::Request parseOptions(const Bson& opts) {
    if (!opts.is_object() || !opts["url"].is_string()) throw httpx::Error(httpx::ErrorCode::InvalidOptions);
    httpx::Request request;
    request.url = opts["url"].string_value();
    const auto& fields = opts.object_items();
    if (fields.count("method")) request.method = opts["method"].string_value();
    if (fields.count("body")) request.body = opts["body"].string_value();
    if (fields.count("timeoutMs")) request.timeoutMs = opts["timeoutMs"].number_value();
    if (fields.count("allowInsecureHttp")) request.allowInsecureHttp = opts["allowInsecureHttp"].bool_value();
    for (const auto& header : opts["headers"].object_items()) request.headers.emplace_back(header.first, header.second.string_value());
    httpx::validate(request);
    return request;
}

class HttpClient;
class RequestData final : public JQuick::REF_BASE {
public:
    ~RequestData() override {
        // SDK work closures are destroyed on their worker. Transfer the final
        // owner reference to a JS-thread task: JQBaseObject destruction touches
        // template registries which must not race JS GC.
        if (owner.get()) {
            try {
                auto* release = new JQStdFuncTask([keep = owner]() {});
                owner.clear();
                handler->post(release);
            } catch (...) {
                // Allocation failure during teardown: retain one reference
                // rather than destroy SDK registries on a worker thread.
                if (owner.get()) { owner->REF(); owner.clear(); }
            }
        }
    }
    JQuick::sp<JQBaseObject> owner; // Acquire on JS thread; SDK async info otherwise has only a weak reference.
    JQuick::sp<JQuick::Handler> handler;
    std::shared_ptr<httpx::Cancellation> token;
    httpx::Request request;
};
class HttpClient final : public JQBaseObject {
public:
    ~HttpClient() override { slot_.close(); }
    bool prepare(JQPrepareInfo& info) {
        std::shared_ptr<httpx::Cancellation> token;
        try {
            // Reserve before reading properties; getters may call stop/request.
            token = slot_.begin();
            JQuick::sp<RequestData> data = new RequestData();
            data->handler = jsHandler();
            data->owner = this;
            data->token = token;
            const Bson opts = readOptions(info);
            data->request = parseOptions(opts);
            info.asyncInfo().SetParams({opts});
            info.asyncInfo().setData(data.get());
        } catch (const httpx::Error& error) {
            if (token) slot_.finish(token);
            reject(info.asyncInfo(), error.code);
        } catch (...) {
            if (token) slot_.finish(token);
            reject(info.asyncInfo(), httpx::ErrorCode::Internal);
        }
        // Never ask the SDK to run its unbounded recursive serializer.
        // postError is immediate on the JS thread; SDK sees callback removed and skips dispatch.
        return true;
    }
    void request(JQAsyncInfo& info) {
        auto data = info.dataAs<RequestData>();
        if (!data.get()) { reject(info, httpx::ErrorCode::Internal); return; }
        httpx::ErrorCode failure = httpx::ErrorCode::Internal;
        try {
            const auto response = httpx::perform(std::move(data->request), data->token);
            Bson result(Bson::object{{"statusCode", Bson(response.statusCode)}, {"body", Bson(response.body)}});
            // Linearize completion against stop() and free the slot only after I/O exits.
            if (slot_.finish(data->token)) reject(info, httpx::ErrorCode::Cancelled);
            else info.post(result);
            return;
        } catch (const httpx::Error& error) { failure = error.code; }
        catch (...) { failure = httpx::ErrorCode::Internal; }
        if (slot_.finish(data->token)) failure = httpx::ErrorCode::Cancelled;
        reject(info, failure);
    }
    void cancelAll(JQFunctionInfo& info) {
        try { slot_.cancel(); info.GetReturnValue().SetUndefined(); }
        catch (...) { info.GetReturnValue().ThrowInternalError("HTTPX_INTERNAL_ERROR"); }
    }
protected:
    void OnGCCollect() override { slot_.close(); }
private:
    httpx::RequestSlot slot_;
};

const std::vector<std::string> exports = {"HttpClient"};
int moduleInit(JSContext* ctx, JSModuleDef* module) {
    try {
        httpx::initializeCurl();
        auto env = JQModuleEnv::CreateModule(ctx, module, "httpx");
        auto tpl = JQFunctionTemplate::New(env, "HttpClient");
        tpl->InstanceTemplate()->setObjectCreator([]() -> JQBaseObject* {
            try { return new HttpClient(); } catch (...) { return nullptr; }
        });
        tpl->setAsyncScheduleMode(JQAsyncSchedule::MODE_MODULE | JQAsyncSchedule::MODE_APP | JQAsyncSchedule::MODE_OBJECT);
        tpl->setAsyncScheduleHook([](JQAsyncScheduleInfo& schedule) {
            schedule.setThreadKeepAliveMs(0); // Release idle SDK workers as soon as I/O exits.
        });
        tpl->SetProtoMethodPromise("request", &HttpClient::request).SetPrepareParamsHook(&HttpClient::prepare);
        tpl->SetProtoMethod("cancelAll", &HttpClient::cancelAll);
        tpl->SetProtoMethod("stop", &HttpClient::cancelAll);
        const JSValue constructor = tpl->GetFunction();
        if (JS_IsException(constructor)) { env->setModuleExportFailed(); return -1; }
        env->setModuleExport("HttpClient", constructor);
        env->setModuleExportDone(JS_UNDEFINED, exports);
        return 0;
    } catch (...) {
        JS_ThrowInternalError(ctx, "HTTPX_INTERNAL_ERROR");
        return -1;
    }
}
DEF_MODULE_LOAD_FUNC_EXPORT(httpx, moduleInit, exports)
} // namespace

extern "C" JQUICK_EXPORT void custom_init_jsapis() {
    registerCModuleLoader("httpx", &httpx_module_load);
}
