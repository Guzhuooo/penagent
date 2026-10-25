# M0 探针报告 · penagent

> 原始记录：2026-10-07；最新更正据只读反汇编结果与协调者记录，当前 ADB 断开，未重新 hash 设备或向 endpoint 发请求，未执行实际证书测试。
> 首台 profile：Y02 / 固件 4.9.7；应用 appid `8002026100700001`，规范入口 `index`。
> 历史截图：`app/artifacts/probe1-10.png`；历史设备日志：`/userdata/applog/DictPen_20261007_132922.log`（检索 `pa:probe`）。这些是原报告给出的证据位置，不代表本次重新取得或逐图验收。
> **M0 仅部分验证**。旧「POST 不支持所以必须 native」理由撤回；但已识别 flat HTTP 的生产安全**静态不合格**，生产必须 native 或其他独立验证的安全 adapter。正确 JSON POST 可能送达不等于可带真实 key / 用户内容；不宣称 native 或 M0 完成。

## 1. 构建 / 安装 / 启动链

| 项 | 可保留的窄范围结论 | 证据 / 限制 |
|---|---|---|
| 宿主构建链 | 历史记录 Node 20.18.0 + 全局 `aiot-vue-cli@1.0.32`，`aiot-cli -q -p` 出包成功 | 原打包记录；不代替当前源码的 check/test、production 与锁定重建 |
| 当前 appid | `8002026100700001` 有安装及 `index` 挂载记录 | `install ret:0`、`PageLifecycle->onStart _pageName=index`；仅证明此 ID 可用 |
| 用户原始 appid | `800Guzhuooo0001` 是 **14 个字符**，含字母 | 未做有效字母方案对照，不证明 numeric-only 或强制固定数字长度；显示名 Guzhuooo Agent |
| theme 警告 | 历史构建出现 `找不到theme "theme-dark"`，当次构建仍成功 | 非致命仅限该次记录，不扩大为任何 theme 错误均可忽略 |
| `libs/ is not a directory` | 无 `.so` 的历史包可出现该日志且仍挂载 | 若未来包应包含 native 库，此日志仍须排查，不能一概忽略 |
| 首帧与 vw/vh | 历史有 `setViewPort(936)` 色条探针及截图文件记录；Y02 单位校准另见 DEVICE_* | 本次无视觉验收；截图存在、尺寸或 ret:0 不能证明比例正确、无裁切或触控可用。当前源码按 profile 配置 viewport，不把 936 推广到通用布局 |

## 2. JSAPI 面（历史枚举）

原记录列出 16 个 key：

```text
http.downloadAndUnzip, http.downloadFile, http.downloadFileNoCache, http.request,
storage.{clear,get,getInfo,remove,set}{,Global}, storage.getStorageInfo, http, storage
```

- 原枚举的 `$falcon.jsapi.http` 子对象为 `eventMap, _uniqueId, name, downloadAndUnzip, downloadFile, downloadFileNoCache, request`。
- 当次枚举未找到 `http.httpBridge`。单独 `HttpBridge.httpBridge` 的二进制符号不能证明它暴露给第三方 JS，也不能用其参数合同代替 flat `http.request`。

## 3. POST 旧结论撤回与有效合同线索

### 3.1 哪些旧观察可以保留

| 探测 / 旧结论 | 复核后状态 |
|---|---|
| GET + 自定义 Bearer header | 原 mock 日志记录送达、当次响应约 216ms；只证明当次 GET/header，不证明 POST、TLS 或任意状态码 |
| 四种字段 `body/data/requestBody/params` 全为 `bodyLen:0` | **多字段对照无效**。旧 `probeRequest -> requestRaw` 重建 envelope，只把 `opts.body` 转发成 `payload.body`；其他输入字段未抵达 native。空正文不能排除 native 的 `data` 合同 |
| 嵌套调用同步返回 `{}` | **不是 HTTP 空响应证据**。框架的嵌套 `http.request` 包装返回 Promise，JSON.stringify(Promise) 为 `{}`；旧探针提前 settled 会抑制真正完成结果 |
| `http.request` 仅 GET / 纯 JS 无法调用 OpenAI / 必须 native | **撤回**。原调用字段和完成判据均不匹配，无法据此判定平台能力不足 |
| Global.execShell | 历史有存在、执行和 bool 返回记录，无 stdout 合同；期限、取消、阻塞均未验，不作为 LLM 响应通道 |

上述旧 wrapper / 旧探针缺陷由 `tools/post-contract-notes.md` 的调查快照支撑，不要求当前页面仍与旧行号相同。当前 `app/src/pages/probe/probe.vue` 已是等待 adapter 的异步页面，不再是旧嵌套同步探针；页面已改写也**不等于**有效 POST 已通过。net 正在独立整改，须对最终实现和真实请求重新取证，本报告不替其宣布修复。

### 3.2 应优先复测的静态合同

`tools/post-contract-notes.md` 记录匹配设备 SHA-256 的 `libfalcon.so` 反汇编：`HttpApiExtension::request` 读取 JSON 字符串 envelope、`method`、单数 `header` 和 `data`。候选调用为：

```js
const api = $falcon.jsapi;
api['http.request'].call(api, JSON.stringify({
  url: mockEchoUrl,
  method: 'POST',
  header: {
    'Content-Type': 'application/json',
    'Accept-Encoding': 'identity',
    Authorization: 'Bearer test-synthetic-key'
  },
  data: { ping: 1, text: '合成测试' }
}), callback);
```

- envelope 是 JSON 字符串，内部 `data` 是**对象**。JSON header 下 native 对非 null `data` 执行 `Json::dump`；预先 stringify 的 `data` 会再次编码成 JSON 字符串字面量，不是对象正文。
- 该 native 函数不读取 `body/requestBody/params`。缺失 / null data 在 JSON 模式下产生空正文；非 JSON 模式走对象键值对路径，不能当嵌套 JSON 原文发送。
- 嵌套 wrapper 不转换 `body -> data`、`headers -> header`，也不自动 stringify options。它与独立 HttpBridge / jq::JSHttp 合同不可混同。
- 最新只读反汇编更正：连接 timeout 固定 **10000ms / 10s**，总 timeout 固定 **100000ms / 100s**，不是旧记“总计 10s”。仅读取 url/header/method/data，无 caller TLS/redirect/timeout/signal；dataType/responseType 也未读取。JS 8/15/20s 等待期限既不改变 native deadline，也不构成物理取消。
- 这是已识别二进制的静态合同证据，不是对象 data 真机送达或实际证书测试。当前 ADB 断开、未重 hash；notes 的未执行旧 helper 含敏感 payload/echo 日志，现已从文档移除，禁止照搬。

### 3.3 生产安全：已静态确认不合格

证据绑定 `libfalcon.so` SHA-256 `91e23dcef405d849e17757656cd2603ecc21cc9d20437bf38937c6b13b664a58`（历史匹配设备的副本），`HttpApiExtension::request @0x7577f0`、size `0x3ce8`，flat 注册 `0x753728`。本轮只整理提供的只读分析结果，未重新反汇编或连接设备。

| 地址 | 设置 / 控制流 | 结论 |
|---|---|---|
| `0x757934` | FOLLOWLOCATION(52)=1 | 自动跟随 redirect，不服从 caller redirect policy |
| `0x75794c` | SSL_VERIFYPEER(64)=0 | 关闭证书链校验 |
| `0x757964` | SSL_VERIFYHOST(81)=0 | 关闭 TLS 主机名校验 |
| `0x75797c` | CONNECTTIMEOUT_MS(156)=10000 | 连接期限 10 秒 |
| `0x757998` | TIMEOUT_MS(155)=100000 | 总期限 100 秒 |
| `0x75a19c` | CURLINFO_RESPONSE_CODE，之后仅认 200/201 | 成功 `{result:'response text'}` 不含 HTTP status；错误 `{result:{errorMessage}}` 与 proxy error 3 不是 HTTP 状态 |

这些控制流已经违反生产门槛，**不能再写成“TLS/redirect 尚未验证而已”**。禁止从 errorMessage scrape/regex 状态、默认 200、或把正文自报状态当真实 HTTP status。未发现该 flat 路径 abort；此为限定调查范围，不是断言所有 Falcon API 均无 abort。成功 POST、HTTPS URL 或 JS 里附加 verify/redirect/signal 均不能修补 native 未读取的选项。

静态不合格不等于已经执行无效证书测试、复现攻击或新核对当前设备哈希。生产须 native httpx 或其他独立验证安全 adapter，原因是 TLS/redirect/status/期限/取消不达标，**不是 POST 不支持**。

### 3.4 复测出口与安全通道选择

1. ADB 恢复且获授权后，可仅用本地 mock、假 Bearer、固定合成对象与本地 ID 检查 flat JSON POST 送达；不发真实凭据 / 用户正文，不向第三方 endpoint 做安全试验。
2. 等待 flat callback / 嵌套 Promise 的真实完成，区分 dispatch 与响应，只 settle 一次；JS 期限不伪称底层已取消。原生总期限为 100s，较短 reporting timer 后仍可能有回调。
3. 服务端核对 method、Content-Type、auth-match bool、UTF-8 字节数、JSON 对象结构及固定字段匹配；只留受控状态 / 字节 / 匹配 bool / 耗时 / ID，禁止正文、raw echo、auth 和错误原文日志。未知 HTTP status 保持 unknown/null。
4. 此送达检查**不能解锁生产**。native httpx 或其他独立安全 adapter 必须验证 peer/host、有效 / 无效证书、redirect、真实 status、期限、物理取消 / 回收与上限；未通过前生产 fail closed。
5. native 并非已完成，其他安全 adapter 也未获本轮验收；不得编译 / 上传或触发远程 run，除非另有明确授权。

## 4. 生产须独立安全 adapter；native 未验收

- 历史记录其他已装应用的 `libjsapi_*.so`（如 reciter）为 ELF64 AArch64；这是目标 ABI / 其他应用可加载的线索，不证明 penagent httpx 已加载。
- 本地已有 `native/sdk/iot-miniapp-sdk/` 和 httpx 源码 / 构建配置；文件存在不等于匹配 sysroot/toolchain、CI 构建、TLS、取消或设备加载通过。
- 用户已决定 C/C++ 编译与链接统一 GitHub Actions；具体仓库、上传 SDK/sysroot 与远程运行仍按授权执行。不因为有 SDK 或源码就宣布 native 完成，也不因为旧 POST 探针失败就认定 native 必需。

## 5. 存储与输入法

| 项 | 历史证据及未关闭范围 |
|---|---|
| storage set/get | 原记录 JSON 字符串参数的一次 set→get 回读一致，schema `{version:1,data}`；重启、覆盖安装、断写、串行写与容量仍须验 |
| startTextEdit 确认 | 原记录输入 `S` 后有 `editConfirmed:true, text:"S"` 回调；UI「确认: S」是原观察描述，本次未视觉复核 |
| 当前 IME 实现 | 源码已有 Global 复用、UUID 判断、严格确认归一化、on/off 与 close、页面输入会话 hide 守卫；属于已实现路径，不等于真机取消 / close / 重复打开 / 前后台交错通过 |

## 6. 日志与开发环境

- 历史记录 `console.log` 不落 DictPen、warn/error 可检索，格式 `(console(<appid>).warn.0): ...`。当前 `services/log` 的 info 仍经 console.log；**尚未据本次证据证明已切 warn**。日志可观测性与敏感字段清理均须独立验证。
- 历史环境记录：adbd 重启后可能需人工 `adb shell auth`；宿主 8787 防火墙规则曾用于局域网 mock；MSYS 下 adb push 需正确 Windows 本地路径及路径转换设置。这些是当时环境记录，不证明当前连接 / 规则仍有效。
- `tools/mock-openai.mjs` 提供 `/v1/models`、`/v1/chat/completions`、`/v1/echo`。旧 auth/body 输出与 raw echo 不应进入真实凭据 / 用户内容测试证据；是否清理以最终文件与安全测试为准。

## 7. 回填计划与 M0 未关闭项

| 网关 | 当前结论 |
|---|---|
| LLM / POST / Bearer / TLS | object-data JSON POST 有静态合同、真机送达待测；flat TLS/redirect/status/期限/取消合同已确认不合格，生产必须独立安全 adapter，不是因 GET-only 推断锁定 native |
| appid / index | 当前数字 ID 有安装与挂载记录；14 字符原始 ID 未构成 numeric-only 对照 |
| JS 构建 | 历史打包可用；当前 check/test、production 和干净重建须单列证据 |
| UI / 截图 | 已留历史截图路径；本次未视觉查看，不声称视觉验收，多分辨率 / 触控布局仍待验 |
| IME | 确认有窄范围历史记录；取消 / close / 前后台等完整流程仍待验 |
| 生命周期 / 内存 | 两次进出、timer / 订阅 / 请求回收、memoryUsageGC 预热基线 / 阈值 / 趋势仍待验 |

当前 core、工具、页面与相对 token 的存在仅能说明实现已推进。R06 review 的页面四类、ledger、排队取消当时待修，R07 已有协调者提供的分项修复与独立验证记录，详见 PROGRESS；本轮未重跑，不作为真实 core+UI 最终集成、网络、IME、存储和内存出口通过。最新验证数量与最终 AMR SHA 留主 agent 收尾更新。
