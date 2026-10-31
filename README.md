# Guzhuooo Agent · penagent

运行于有道词典笔 Falcon / QuickJS 的轻量 OpenAI-compatible agent harness。

**当前为 0.3.1 集成预览。** 聊天、设置、会话存储、有界工具循环、声明式自造工具、工具识别、
工作区文件编辑/删除/执行均已有实现与宿主测试；Y02 真机已完成 0.3.1 安装、工作区自检与
开发模式 AI 文件工具闭环。生产真实 endpoint 仍未解锁：已识别 flat `http.request` 静态不合格
（关闭 TLS peer/hostname 校验、自动 redirect、无真实 HTTP status、无 caller timeout/signal），
生产保持 fail closed，需要 native 或另一条独立验证的安全 adapter。开发模式额外提供 curl
传输，只允许回环/私网 + 合成 key，不能用于生产。详细边界见 [验证状态](docs/VALIDATION.md)。

## 已实现（0.3.1）

- Vue 2 页面：会话列表、聊天、发送/停止、工具状态卡、设置、能力探针、工具目录/识别、文件工作区。
- 全部 UI 几何使用 vw/vh；组件高度严格审计为 vh（宽度 vw），状态图标改为内联 PNG 或文字，不再依赖 emoji/状态符号字体；source-contract 回归测试守护。
- API 根、密钥、模型配置；密钥遮罩、默认内存、明文保存须确认、清除读回验证。
- OpenAI 兼容非流式 `/chat/completions`；单次 POST、无自动重试；工具组原子提交、上下文裁剪、
  取消与迟到回调隔离。
- 工具：`clock`、`calculator`、`note`、`device_info`、`net_probe`、`execShell` 预设、声明式
  `define_tool/delete_tool/list_tools`、`file_list/file_read/file_write/file_delete/file_exec`。
- 自造工具：5 种安全 recipe（lookup/compute/template/text/convert），持久化 `pa.customTools`，
  有界工具识别（名称/关键字/描述/中文二元组），无 eval / 动态代码。
- 工作区：`$workspace` 推导 app 私有根，绝对路径/`..`/控制字符拒绝；写入经 POSIX 引用 shell
  + fs 校验；执行经 `/bin/timeout` 限时、输出有界；`file_exec` 默认关闭。详见
  [WORKSPACE_TOOLS](docs/WORKSPACE_TOOLS.md)。
- 单层版本化存储、旧双层只读兼容、串行写 / 读回 / 分块索引；损坏、写失败显式报错。
- GitHub Actions：JS 测试、Python 策略测试、宿主 C++ build + CTest、AArch64 compile-only
  冒烟；所有 C/C++ 编译只在 Actions 执行。设备 `.so` 仍需获批 toolchain/sysroot bundle。

## 构建与测试

Node **20.18.0**、全局 **aiot-vue-cli 1.0.32**。完整依赖锁定 / 干净机器重建仍未完成。

```sh
npm --prefix app test
npm --prefix app run check
npm --prefix app run build       # debug QuickJS AMR
npm --prefix app run build:prod  # production 构建模式 AMR（未解锁生产网络）
python tools/verify-amr.py app/artifacts/0.3.1/penagent-0.3.1-debug.amr
python -m unittest discover -s tools/tests -v
```

- 最终 0.3.1 验证：legacy **5/5** + Node **126/126**、Python 策略 **22/22**，0 fail。
- `check` 是 CLI 环境检查，不是源码 lint；CLI 仍会报告缺省 theme、runtime 外部模块等警告。
- 发布身份来自 `app/package.json`：version `0.3.1`、appid `8002026100700001`、入口 `index`。
- 预览产物（SHA/字节见 [VALIDATION](docs/VALIDATION.md)）：
  [debug AMR](app/artifacts/0.3.1/penagent-0.3.1-debug.amr)、
  [production 构建模式 AMR](app/artifacts/0.3.1/penagent-0.3.1-production.amr)。
- production 只是 CLI 构建模式，不是生产使用许可；两个包都未验证真实 endpoint 对话。

## 合成 mock / 开发模式

```sh
node tools/mock-openai.mjs                      # 默认 127.0.0.1:8787
MOCK_HOST=0.0.0.0 node tools/mock-openai.mjs    # 显式 LAN 联调
```

只接受 `test-synthetic-key` / `probe-key-123`，日志只保留受控 metadata。输入 `synthetic-tools`
返回 calculator+clock 两调用；`synthetic-files` 返回 file_write/file_read/file_exec/
file_write/file_delete 五调用，用于工作区闭环。

- 笔上的 `127.0.0.1` 是笔自身；真机 LAN 联调必须显式设置开发模式并配置私网地址，结束前清除。
- 开发模式 curl 传输（`services/net/dev.js`）只对回环/私网 host + 合成 key 生效，使用 curl
  真实 status、`-m` + `/bin/timeout` 双限时、响应上限和临时文件清理；不记录 body/header/key。
  它不是生产安全 adapter，不改变 flat HTTP 的生产禁用结论。
- 生产 HTTPS、TLS peer/hostname 校验、可信 HTTP status、期限/取消仍须独立安全 adapter。

## 设备安装（Y02 / ADB）

```sh
adb devices -l
adb push D:/penagent/app/artifacts/0.3.1/penagent-0.3.1-debug.amr /tmp/penagent-0.3.1.amr
adb shell miniapp_cli install /tmp/penagent-0.3.1.amr
adb shell miniapp_cli start 8002026100700001 index
```

本 profile 启动使用显式位置参数页面名（`index`），不要照 CLI help 的 `--page` 示例。
安装 ret:0 后仍需页面挂载、截图和功能验证；覆盖安装后若发现页面仍运行旧 realm，应重新冷启动
/ 干净安装再取证，不能把旧页面的失败当成新代码结论。ADB 认证提示必须人工处理。

## GitHub Actions / Native

仓库：`Guzhuooo/penagent`（private）。两条 workflow：

- `native-compile.yml`：ubuntu-24.04 上跑 JS 测试、Python 策略测试、宿主 C++ CMake build +
  CTest、AArch64 compile-only 冒烟。所有 C/C++ 编译只在 Actions。
- `native-device-build.yml`（0.3.1 新增）：在 ubuntu:18.04 容器里用 **2018 年 GCC 7.5.0
  AArch64 交叉工具链** + 从真机采集的 sysroot bundle（SDK + curl 7.79.1 headers + 24 个设备
  运行库 + libfalcon.so）构建 `libjsapi_httpx.so`，并在宿主做 fail-closed ELF/ABI 审计。

最近证据：

- 最终 0.3.1 源码 commit `58f5bc9` 的 native device build run
  [41179509958](https://github.com/Guzhuooo/penagent/actions/runs/41179509958) 全绿；
  artifact `libjsapi_httpx.so` **488,520 bytes**，SHA-256
  `22d4e811dd8bb003a86c0c492f04875803637aa8a3f1f3eb1a4aec7544fcf5cd`；
  ELF64 little-endian AArch64 DYN，SONAME `libjsapi_httpx.so`，无 PT_INTERP/RPATH/RUNPATH/TEXTREL，
  导出 `custom_init_jsapis`；DT_NEEDED 对 libcurl.so.4 / libstdc++.so.6 / libgcc_s.so.1 /
  libc.so.6 / ld-linux-aarch64.so.1 的设备 provider SHA/SONAME 匹配；所需版本符号
  GLIBC_2.17 ≤ 2.36、GLIBCXX_3.4.21 ≤ 3.4.29、CXXABI_1.3.9 ≤ 1.3.13、GCC_3.0 ≤ GCC_11.0。
- 同一 commit 的 `native-compile` run
  [41179510006](https://github.com/Guzhuooo/penagent/actions/runs/41179510006) 全绿（JS 126/126、
  策略 22/22、宿主 CTest 1/1、AArch64 compile-only）。
- 设备工具链/系统库：Y02 实机 glibc **2.36**、libstdc++ **6.0.29**（GLIBCXX 3.4.29）、
  curl **7.79.1**；sysroot/bundle 的来源、文件 SHA 与 adb 采集命令见
  [native/README.md](native/README.md) 与 `native/device-bundle/manifest.json`。
- **边界**：该 `.so` 尚未打进 AMR、尚未在设备加载，不声称设备加载、TLS 信任链、取消语义或
  Falcon 线程兼容；`native-manual.yml` + `native/ci-policy.json` 仍保持 disabled，正式发布
  链路仍需获批 vendor bundle。`.gitignore` 忽略 `*.so`，二进制只在 Actions artifact（30 天），
  文本证据与 SHA 入库。

## 文档与验收边界

- [总规划](docs/PLAN.md) · [技术标准](docs/STANDARDS.md) · [逐步记录](docs/PROGRESS.md)
- [自造工具与识别](docs/CUSTOM_TOOLS.md) · [工作区文件与执行](docs/WORKSPACE_TOOLS.md)
- [探针与更正](docs/SPIKE_REPORT.md) · [设备画像](DEVICE_PROFILE.md) · [探测记录](DEVICE_PROBING.md)
- [核心 adapter 合同](app/src/core/README.md) · [最新验证](docs/VALIDATION.md) ·
  [native 构建说明](native/README.md)

0.3.1 已真机验证：安装、工作区自检 9 步、开发模式 AI 文件工具闭环（写入/读取/执行/删除）、
UI 高度 vh/vw 回归测试；native 插件已在 Actions 用 2018 工具链 + 真机 sysroot 构建并通过静态审计。
仍未验证 / 未通过：真实 endpoint 对话、生产安全 adapter、IME 取消/重复开关、两次进出内存差值、
多分辨率、native `.so` 打进 AMR 与真机加载。`file_exec` 是高风险能力，默认关闭；开启后 AI 可
执行工作区命令，用户需自行承担风险。`DEVICE_*`、profiles、截图、SDK 和本地运行数据包含
设备/许可相关信息，不能把整个目录直接公开发布；公开/私有远程操作均须具体授权。
