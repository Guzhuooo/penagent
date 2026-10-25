# Guzhuooo Agent · penagent

运行于有道词典笔 Falcon / QuickJS 的轻量 OpenAI-compatible agent harness。

**当前为 0.2.0 集成预览，不是已验收的生产对话版本。** 聊天、设置、会话存储与有界工具循环已有实现和宿主测试记录；已识别 flat `http.request` 的生产安全不是仅未验证，而是静态不合格：关闭 TLS peer/hostname 校验、自动跟随 redirect、无可信 HTTP status、无 caller timeout/signal 控制，且未发现该路径 abort。生产保持 fail closed，必须 native 或其他独立验证的安全 adapter，原因不是 POST 不支持。设备 ADB 仍断开，本轮未重 hash / 做证书测试，新版真机安装、正确 JSON POST 与完整验收未完成。本轮审查发现的问题已修复并独立复核；最终测试、包摘要与剩余阻塞见 [验证状态](docs/VALIDATION.md)，逐步记录至 R08。

## 已实现

- Vue 2 页面：会话列表、聊天、发送/停止、工具状态卡、配置与能力探针。
- 所有组件几何/字体/scroller 使用 vw/vh，相对 token；硬件宽高只在 device profile。
- API 根地址、密钥、模型配置；密钥遮罩，默认内存，选择明文保存须确认；清除后读回验证。
- 非流式 `/chat/completions` 与 `tools/tool_calls`；每轮最多6次模型请求、8个调用/批、24个工具、120秒预算；POST无自动重试。
- 工具 schema 验证、完整工具组、上下文裁剪、取消与迟到回调隔离。
- `clock`、安全解析计算器、`note` CRUD、筛选后的 `device_info`；`net_probe` 与 execShell 只提供受控契约，当前平台能力不足时拒绝执行。
- 单层版本化存储、旧双层只读兼容、串行写/读回/分块索引；损坏或写失败明确报错。

## 构建与测试

已用 Node **20.18.0**、全局 **aiot-vue-cli 1.0.32** 验证。当前不含完整依赖锁定/干净机器重建证据。

```sh
npm --prefix app test
npm --prefix app run check
npm --prefix app run build
python tools/verify-amr.py app/8002026100700001.0_2_0.amr
python -m unittest discover -s tools/tests -v
```

- `check` 是 CLI 环境检查，不是源码 lint。
- `build` 为 debug QuickJS AMR；`build:prod` 为 production QuickJS AMR。
- 发布身份来自 `app/package.json`，规范页面入口 `index`，appid `8002026100700001`。
- CLI 可能报告缺省 theme-default、runtime 外部 `global`、Node http_parser 警告；构建成功不代表设备运行/视觉通过。
- `tools/verify-amr.py` 只读取 CLI 生成的包，检查版本、manifest、脚本资源大小/摘要、必需入口和无未验证 native 库；不重新打包。
- 最终验证：旧 **5/5** + Node **93/93**、Python 策略 **22/22**，0 fail / cancelled / skipped；debug/production QuickJS 均构建成功并通过 AMR 校验。限定独立复核已关闭本轮发现的六项问题及后续 transition/send 竞态；不代表真机或生产网络通过。
- 预览产物：[debug AMR](app/artifacts/0.2.0/penagent-0.2.0-debug.amr)（426756 bytes）和 [production 构建模式 AMR](app/artifacts/0.2.0/penagent-0.2.0-production.amr)（420045 bytes）。完整 SHA、日志和验收边界见 [VALIDATION](docs/VALIDATION.md)；production 模式包也未解锁生产网络。

## 合成 mock

```sh
node tools/mock-openai.mjs
```

默认只监听宿主回环 `127.0.0.1:8787`，只接受 `test-synthetic-key` / `probe-key-123`。日志仅保留受控 metadata，echo 不返回原始凭据或正文。

- 输入 `synthetic-tools` 可使 mock 返回 calculator 与 clock 两个调用，再验证两个 tool 结果一一对应并给出最终回答。
- 宿主集成测试会自动创建临时端口，无需长期启动 mock。
- 笔上的 `127.0.0.1` 是笔本身，不是 PC。LAN 联调须明确设置开发用 `services/device/development.js`，启动 mock 时将 `MOCK_HOST` 设为所需接口，并在结束前恢复回环值。不要把临时宿主IP写入发布包。
- 平台 flat HTTP 的 `header` 为单数，`data` 为对象，外层 envelope 才 JSON.stringify；正确 JSON POST 可能成立但真机送达仍待验。该实现固定连接 **10 秒**、总计 **100 秒**（旧总超时 10 秒说法错误），忽略 caller TLS/redirect/timeout/signal；JS timer 只是等待期限，不会取消 native。仅可用于显式开发模式、受控私网/回环 mock、合成内容与假凭据，不能靠本地 POST 成功解锁生产。
- flat 内部仅认 HTTP 200/201，成功只返回 `{result:'response text'}`、无真实状态；错误 `{result:{errorMessage}}` 与 proxy error 3 不是 HTTP status。未知状态保持 null，禁止 scrape 错误文本、默认 200 或信任 mock 正文自报状态。绑定二进制 SHA、地址与未执行旧敏感日志 helper 的移除说明见 [HTTP 静态调查](tools/post-contract-notes.md)。

### 环境清理限制

协调者已停止 mock 后台任务，但历史防火墙规则仍待管理员清理：Name `{750A4680-D434-48CF-AD2E-70ADF02FD95A}`、DisplayName `penagent-mock-8787`、TCP 本地端口 8787、remote `<lan-subnet>`、enabled。严格匹配该规则后 `Remove-NetFirewallRule` 返回 Windows Error 5（拒绝访问），未提权 / 重试，不声称规则已删除；不要宽泛删除其他规则。随后检查端口监听数为 0；详细失败与精确规则范围已归档于 VALIDATION / PROGRESS R08。

## 设备安装（设备重新连接后）

安装会覆盖本项目应用包；不要卸载或删除应用数据来伪造冷启动通过。先核对 ADB 的 shell 实际可用。Git Bash 的本地 ADB 路径使用 Windows 格式：

```sh
adb devices -l
MSYS_NO_PATHCONV=1 adb -s <serial> push D:/penagent/app/8002026100700001.0_2_0.amr /tmp/penagent-0.2.0.amr
MSYS_NO_PATHCONV=1 adb -s <serial> shell 'miniapp_cli install /tmp/penagent-0.2.0.amr'
MSYS_NO_PATHCONV=1 adb -s <serial> shell 'miniapp_cli start 8002026100700001 index'
```

本 profile 实测启动使用显式位置参数 `index`，不要照 CLI help 的 `--page` 示例。认证提示必须人工处理。安装 ret:0 之后仍需 PageLifecycle、截图和功能证据。

## Native / GitHub Actions

`httpx` 源码与手动 workflow 已准备，但尚无可用 native 交付。由于已识别 flat 通道静态安全不合格，生产必须 native 或另一条独立验证安全 adapter，不能仅因 JSON POST 可送达跳过安全门槛。**所有 C/C++ 编译和链接只在 GitHub Actions；本轮未编译或上传。** `native/ci-policy.json` 默认 disabled；具体仓库、可见性、上传范围、SDK/sysroot/toolchain bundle 与 SHA 未获明确授权，不创建仓库、push、上传或触发 run。

配置与 ABI/ELF/取消/TLS 验收说明见 [native/README.md](native/README.md)。没有 CI 产物、ELF/SHA 和真机加载证据，不提供或声称可用 `.so`。

## 文档与验收边界

- [总规划](docs/PLAN.md)
- [技术标准](docs/STANDARDS.md)
- [逐步工作记录](docs/PROGRESS.md)
- [探针报告与历史结论更正](docs/SPIKE_REPORT.md)
- [核心 adapter 合同](app/src/core/README.md)
- [最新验证状态](docs/VALIDATION.md)

当前真实 endpoint 对话、正确 data 的真机 POST、IME取消/重复开关、内存回收、多分辨率与正式新包设备运行均未通过验收。R08 已完成宿主侧真实 core+UI 的持久、重启防重放、取消回归及最终全测；这些不关闭设备验收。索引 commit 失败可能留下孤立 chunk，当前没有自动垃圾回收，4 MiB 只是索引历史预算而非全部底层存储上限。旧规划中的 appid 格式推断、密钥保存与自动重试结论以当前 PLAN/STANDARDS/PROGRESS 为准：原始 `800Guzhuooo0001` 是 14 字符，不证明 numeric-only；密钥默认内存、明文保存须知情确认；POST 不自动重试。

源扫描/宿主 mock 只证明其覆盖范围，截图采集也不等于视觉验收。`DEVICE_*`、profiles、截图、SDK和本地运行数据包含设备或许可相关信息，不能把整个目录直接发布；公开/私有远程操作均须具体授权。
