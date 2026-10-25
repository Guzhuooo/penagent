# 0.2.0 验证状态

更新：2026-10-17。**宿主集成预览已构建并校验；新版真机验收与生产网络仍未完成。** 每步修复、失败和历史更正在 [PROGRESS.md](PROGRESS.md)，总体出口在 [PLAN.md](PLAN.md)。

## 本轮最终结果

| 检查 | 实际方法 | 结果 / 边界 |
|---|---|---|
| 全量 JavaScript | `node app/test/all.mjs` | 旧 runner **5/5**；Node **93/93**；0 fail、cancelled、skipped |
| CI 策略 | `python -m unittest discover -s tools/tests -p 'test_*.py'` | **22/22**；纯 Python，没有执行 C/C++ |
| 页面与真实 core 集成 | 包含在上述 Node 套件 | 初始草稿、等待期间停止、完成工具组保存、交错新建/发送、持久 audit/重启防重放、reservation 保存期间取消、settings 加载门禁与重入 |
| 宿主真实 HTTP | 临时端口 mock + fetch，包含在套件 | 两次模型 POST、calculator/clock 结果对应、最终答复、会话读回；不是 Falcon 真机 HTTP |
| 平台适配器集成 | 实际 net/storage + 模拟 Falcon 回调 | JSON 对象 data、单次 POST、未知 status 拒绝、迟到回调、单层 envelope、损坏失败；cancel/timeout 的排队 note 原生写均为 0 |
| 独立限定复核 | 只读源码与同 realm SFC + 真实 core 行为实验 | 原六项 Important 与后续 transition/send 竞态均关闭；定向 81/81。不是额外的全量测试数，也不保证全项目无其他缺陷 |
| UI 源合同 | 套件 source-contract tests | 当前长度为 vw/vh、scroller 显式尺寸与方向、无 page 直调平台；不证明多尺寸视觉或触控通过 |
| QuickJS 构建 | `npm --prefix app run build:prod`、`run build` | 均退出 0；保留 theme-default 缺失、外部 native global、Node http_parser 警告 |
| AMR 只读校验 | `tools/verify-amr.py` | 两包 appid/version、6 个脚本资源 size/MD5、必需入口、图标与无 native 库通过；不证明真机兼容 |
| CLI check | `aiot-cli check` | 既有退出 0；仅为环境检查，不是源码 lint |

测试日志会显示 Node MockTimers 实验性警告；没有把警告隐藏为无输出成功。根目录不是 Git 仓库，未声称 `git diff --check` 或工作树干净；源码 whitespace 检查单独执行。

## 最终预览包

身份：appid `8002026100700001`，version `0.2.0`，规范入口 `index`，QuickJS `20200705`，无 `.so`。

| 产物 | 字节 | SHA-256 |
|---|---:|---|
| `app/artifacts/0.2.0/penagent-0.2.0-debug.amr` | 426756 | `bed013a789cade131dbc5203001597c024425e2d4ce30e6b9c926b4a2ab56029` |
| `app/artifacts/0.2.0/penagent-0.2.0-production.amr` | 420045 | `fe24f677d202efeb3fd572515ab7d89072c2114599f071d1fd18b116e349dbb5` |

“production”只指 CLI 构建模式，**不是生产使用许可或验收通过**。两包都绑定修正后的 runtime 源码，开发 origin 保持 `http://127.0.0.1:8787`，没有临时宿主 LAN 地址。构建环境与依赖尚未完成干净机器锁定重建；源 SHA 快照不能替代可复现构建证明。

## flat HTTP：生产禁用的原因

历史匹配设备的 `libfalcon.so` 副本 SHA-256 为 `91e23dcef405d849e17757656cd2603ecc21cc9d20437bf38937c6b13b664a58`；函数 `HttpApiExtension::request @0x7577f0`、size `0x3ce8`，注册 `0x753728`。

| 地址 | 静态操作 | 结论 |
|---|---|---|
| `0x757934` | FOLLOWLOCATION(52)=1 | 自动跟随重定向 |
| `0x75794c` | SSL_VERIFYPEER(64)=0 | 关闭证书链校验 |
| `0x757964` | SSL_VERIFYHOST(81)=0 | 关闭主机名校验 |
| `0x75797c` | CONNECTTIMEOUT_MS(156)=10000 | 连接 10 秒 |
| `0x757998` | TIMEOUT_MS(155)=100000 | 总计 100 秒；旧总计 10 秒说法作废 |
| `0x75a19c` | CURLINFO_RESPONSE_CODE，后仅认 200/201 | success 仅 `{result:'response text'}`，不返回 HTTP status |

只读取 url/header/method/data；未读取 caller TLS/redirect/timeout/signal，未发现该路径 abort。error 包装与 proxy error 3 不是 HTTP 状态，不 scrape 错误文本、不默认 200。JS timer 只限制等待，不能改 native 期限或证明物理取消。生产需要 native 或另一条独立验证安全 adapter，**不是因为 JSON POST 不可能**。

当前 ADB 断开，本轮没有重新 hash 设备，也没有执行有效/无效证书测试；上述是指定本地副本的静态证据，不是动态证书测试或 exploit。详细来源见 [HTTP 调查](../tools/post-contract-notes.md)。正确 data + 假 Bearer 的真机 POST 送达仍待验，成功也不能解锁该 insecure flat 的生产使用。未知真实状态会被 core 拒绝，即使 mock 正文可解析也不会假装成功。

## 本轮设备状态

先前指定 shell/help 与笔 curl 到合成 mock 曾成功，只证明当时连接可用。0.2.0 push 时目标消失，之后多次 `adb devices -l` 为空。**本轮新版 push/install/start 没有成功执行**，没有通过重启设备或 ADB 掩盖断连。旧 0.1.0 的安装/入口/IME 确认记录仅为历史窄范围证据。

## 环境清理

- 临时 `0.0.0.0:8787` mock task 已停止；随后只读检查该端口监听数为 **0**。
- 历史项目规则 Name `{750A4680-D434-48CF-AD2E-70ADF02FD95A}`、DisplayName `penagent-mock-8787`、本地 TCP8787、remote `<lan-subnet>` 仍存在。严格匹配后删除返回 **Windows Error 5 / 拒绝访问**，未提权或重试。
- 该规则仍需管理员清理；不要删除其他入站规则。在管理员 PowerShell 中可仅针对该精确 Name 检查及移除。mock 停止不等于防火墙规则已删除。

## 仍未完成 / 阻塞

- ADB 恢复后的 0.2.0 首次/覆盖安装、显式 index、聊天/配置/工具/存储冷启动。
- 真正 endpoint 对话；没有真实凭据，也不能经已确认 insecure 的 flat 试发真实 key/内容。
- 安全 adapter 的 TLS peer/host、redirect、可信状态、接收限额、期限/取消/回收及有效/无效证书动态验收。
- 系统 IME cancel/close/重复打开、前后台、敏感输入可见性；两次以上进入退出与预登记 memoryUsageGC 阈值；第二种逻辑尺寸与真机视觉/触控。
- net_probe HEAD 与只读 exec 预设可靠期限/取消。当前默认能力拒绝，设置开关不能绕过。
- GitHub 具体仓库、可见性、源码/SDK/sysroot/toolchain 上传范围与 immutable bundle 授权。workflow 已准备但 policy disabled；没有创建仓库、push、上传或触发 run。既有 action SHA 在线核验遇证书链错误，未绕过。
- Native 的 Actions build/CTest/ELF/SHA 与真机加载。**所有 C/C++ configure/build/link/test 仅在 GitHub Actions，本轮未执行**。
- 干净机器依赖锁定重建；孤立 session chunk 自动清理。4 MiB 是索引历史预算，不是全部底层存储物理上限；索引 commit 失败可能留下无索引块，见独立复核记录。
- 上述精确防火墙规则管理员清理。

## 证据

- `docs/evidence/js-tests-0.2.0.txt`
- `docs/evidence/ci-policy-tests-0.2.0.txt`
- `docs/evidence/build-debug-0.2.0.txt`
- `docs/evidence/build-production-0.2.0.txt`
- `docs/evidence/review-0.2.0.md`
- `docs/evidence/source-sha256-0.2.0.json`
- `app/artifacts/0.2.0/*-manifest-check.json` 及两个 AMR

这些是本地工程证据，不是远程发布授权。旧规划中的 appid、密钥和重试结论以当前 PLAN/STANDARDS/PROGRESS 更正为准；设备资料、SDK与运行数据不能整包上传。
