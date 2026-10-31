# 0.3.1 验证状态

更新：2026-10-31。**0.3.1 宿主测试、AMR 构建、Y02 真机安装/工作区闭环、UI 高度回归与
native 2018 工具链 + 真机 sysroot 构建均已完成；生产真实 endpoint 与设备 native 加载仍未通过。**
逐步记录见 [PROGRESS.md](PROGRESS.md) R09–R10，规划见 [PLAN.md](PLAN.md)，
工具/工作区/native 细节见 [CUSTOM_TOOLS](CUSTOM_TOOLS.md) / [WORKSPACE_TOOLS](WORKSPACE_TOOLS.md) /
[native/README.md](../native/README.md)。

## 本轮最终结果

| 检查 | 实际方法 | 结果 / 边界 |
|---|---|---|
| 全量 JavaScript | `node D:/penagent/app/test/all.mjs` | legacy **5/5**；Node **126/126**；0 fail；日志 `docs/evidence/js-tests-0.3.1.txt` |
| CI 策略 | `python -m unittest discover -s tools/tests -p 'test_*.py'` | **22/22**，纯 Python，无 C/C++ 执行 |
| UI 高度单位 | 增强 `source-contract.test.mjs` | 审计 154 条尺寸声明：height 家族 52 条全部 vh/token/calc，width 家族 102 条全部 vw/token；2 个组件根补 vh min-height；新测试从 124→126 |
| AMR 构建/校验 | `npm --prefix app run build` / `build:prod` + `tools/verify-amr.py` | 均退出 0；两包 10 个证书资源、入口 app/index/settings/probe/tools/workspace、无 `.so`；日志 `build-*-0.3.1.txt` / `amr-*-0.3.1.json` |
| 真机安装 | Y02 4.9.7 ADB；0.3.1 debug AMR | 卸载/安装/启动 ret:0；chat/settings/workspace 截图正常；workspace 自检 ok |
| native device build | `.github/workflows/native-device-build.yml` | run [41179509958](https://github.com/Guzhuooo/penagent/actions/runs/41179509958) @ `58f5bc9` 全绿；`.so` 静态审计通过 |
| native compile CI | `native-compile.yml` | run [41179510006](https://github.com/Guzhuooo/penagent/actions/runs/41179510006) @ `58f5bc9` 全绿：JS 126/126、策略 22/22、宿主 CTest 1/1、AArch64 compile-only |

## 最终预览包（0.3.1）

身份：appid `8002026100700001`，version `0.3.1`，规范入口 `index`，QuickJS `20200705`，无 `.so`。

| 产物 | 字节 | SHA-256 |
|---|---:|---|
| `app/artifacts/0.3.1/penagent-0.3.1-debug.amr` | 455270 | `fa94045042d8d90107eed90fe574bcc124800e979c90bd3cb4b06cea641764bd` |
| `app/artifacts/0.3.1/penagent-0.3.1-production.amr` | 443732 | `c4082f0908447b287403243a322f59c899816f11a7719922c31757626a02c79d` |

“production”只指 CLI 构建模式，不是生产使用许可或验收通过。两包绑定最终 UI 源码；开发
origin 为 `http://127.0.0.1:8787`，无临时 LAN 地址。干净机器依赖锁定重建仍未完成。

## UI 高度 / emoji

- 12 个 UI 样式文件、154 条 height/width 声明全部已是 vh/vw 字面量或 `viewport.less` 的
  vh/vw token；0 条单位违规。为两个内容高度组件根节点补了 vh 下限：
  `message-card .message min-height:20vh`、`tool-card .card min-height:14vh`（不截断文字）。
- `source-contract.test.mjs` 新增两个硬门禁：逐条解析 height 家族 → 必须 vh（字面量/calc/该
  token 定义为 vh）、width 家族 → vw，禁 px/%/em/rem/auto 等；每个 page/component 根必须声明
  vw 宽 + vh 高/下限。反向注入 `10px`、`100%`、vw-token 当高度均会失败（独立验证）。
- 设备截图：`app/artifacts/0.3.1/chat.png`、`settings.png`、`workspace-selftest.png`；表情符号
  仍由内联 PNG/文字承担。

## 工作区 / AI 文件能力（0.3.0 已验证，0.3.1 未回归变化）

- Y02 实测：`import('fs')` 可用但无 open/write/rename；`process.exec` execFile 语义；写文件用
  POSIX 引用 `printf > file` + fs 校验；执行经 `/bin/timeout`。详见 `docs/evidence/fs-probe-0.3.0.txt`。
- Y02 真机：工作区自检 `selftest {"ok":true,"steps":9}`；开发模式 AI 文件闭环
  `ai-file-test {"status":"completed","toolCalls":5}`，`notes/keep.txt` 留存、`notes/ai.txt` 删除；
  证据 `docs/evidence/workspace-*.txt`。0.3.1 只改 UI 高度，未改工作区代码。
- `file_exec` 默认关闭，高风险，需设置页显式开启；开发模式 curl 传输仅限合成 key/私网，
  不是生产安全 adapter。

## Native：2018 工具链 + 真机 sysroot（0.3.1 新增）

- 设备实际：Y02 / 固件 4.9.7 / aarch64 little-endian / glibc **2.36**（Buildroot stable）/
  libstdc++.so.6.0.29（GLIBCXX 3.4.29）/ curl 7.79.1（libcurl.so.4.7.0，OpenSSL 1.1.1l）/
  `/lib/ld-linux-aarch64.so.1`。
- sysroot/bundle 从真机 ADB 采集：`native/device-bundle/device-bundle.tar.xz`
  SHA-256 `001ec916cd6810e79752c08f72620efecab396a961fa17dcfae798805acf4f81`（7,286,284 B），
  含 SDK（用户提供 `iot-miniapp-sdk.zip`，SHA-256 `564af7…263a`）、curl 7.79.1 headers、24 个设备
  运行库、libfalcon.so、manifest/provenance；文件级 SHA 与设备 `sha256sum` 交叉校验。
- 工具链（全部在 Actions 容器内，本机未编译）：`ubuntu:18.04` + `aarch64-linux-gnu-g++`
  **GCC 7.5.0**（Ubuntu/Linaro 2018-era，glibc 2.27 dev headers）+ binutils 2.30 + cmake 3.18.4；
  容器 sysroot = 工具链 dev 文件 + 设备 bundle 覆盖。
- 产物：`libjsapi_httpx.so` **488,520 B**，SHA-256
  `22d4e811dd8bb003a86c0c492f04875803637aa8a3f1f3eb1a4aec7544fcf5cd`；
  ELF64 little-endian AArch64 DYN、SONAME `libjsapi_httpx.so`、导出 `custom_init_jsapis`、
  无 PT_INTERP/RPATH/RUNPATH/TEXTREL；DT_NEEDED `libcurl.so.4, libstdc++.so.6, libgcc_s.so.1,
  libc.so.6, ld-linux-aarch64.so.1` 均匹配设备 provider SHA/SONAME；所需符号 ≤ 设备上限
  （GLIBC_2.17≤2.36、GLIBCXX_3.4.21≤3.4.29、CXXABI_1.3.9≤1.3.13、GCC_3.0≤GCC_11.0）。
- artifact 只在 Actions（`native-device-58f5bc9…`，30 天）；文本报告/证据在
  `docs/evidence/ci-native-0.3.0/native-device-run-41179509958/`。`.so` 未入仓（`.gitignore`）。
- **边界**：`.so` 未打进 AMR、未在设备加载；不证明设备加载、TLS 信任链、取消、Falcon 线程或
  运行时兼容。`native-manual.yml` + `ci-policy.json` 仍 disabled，正式发布仍需获批 vendor bundle。

## 仍未完成 / 阻塞

- 真实 endpoint 对话与生产凭据；生产安全 adapter 的 TLS peer/host、redirect、可信 status、
  接收限额、期限/取消回收及证书动态验收。
- native `.so` 打进 AMR 的打包/安装/加载、Falcon 导出符号运行时解析、TLS/取消/销毁与真机功能验证；
  需要获批的正式 vendor bundle 或对本次真机自采 bundle 的发布范围授权。
- IME cancel/close/重复打开/前后台；两次进出与 `memoryUsageGC` 阈值；第二种逻辑分辨率与视觉/触控。
- 真实 endpoint 下的自造工具创建/识别与工具页交互（本轮仅宿主 + 设备合成流量）。
- 干净机器依赖锁定重建；孤立 session chunk 自动清理。
- 历史防火墙规则 `{750A4680-D434-48CF-AD2E-70ADF02FD95A}` 仍需管理员清理（本轮未提权重试）。

## 证据

- `docs/evidence/js-tests-0.3.1.txt` / `ci-policy-tests-0.3.1.txt`
- `docs/evidence/build-debug-0.3.1.txt` / `build-production-0.3.1.txt`
- `docs/evidence/amr-debug-0.3.1.json` / `amr-production-0.3.1.json`
- `docs/evidence/emoji-scan-0.3.0.txt`（沿用；0.3.1 额外高度门禁由测试覆盖）
- `docs/evidence/fs-probe-0.3.0.txt`、`workspace-*.txt`（0.3.0 设备证据，代码未回归）
- `docs/evidence/ci-native-0.3.0/`（含 `native-device-run-41179509958/` 与 `run-41179510006/`）
- `native/device-bundle/`、`native/cmake/`、`.github/workflows/native-device-build.yml`
- `app/artifacts/0.3.1/`（AMR 与截图；截图含 UI 但无 key/payload）

这些是本地/私有仓库工程证据，不是远程发布授权。设备资料、SDK、截图与本地运行数据不能整包公开发布。
