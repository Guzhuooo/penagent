# 0.4.0 验证状态（可用预览）

更新：2026-10-31。**0.4.0 把 native `httpx` transport 打进 AMR，Y02 真机已加载该模块并通过
原生 HTTPS POST 200、过期证书 TLS_ERROR 拒绝、LAN mock 驱动的 AI 文件工具闭环；生产 transport
已从 fail-closed flat 切换到 native。真实 OpenAI-compatible endpoint + 真实 key 仍未验证。**
逐条记录见 [PROGRESS.md](PROGRESS.md) R09–R11，规划见 [PLAN.md](PLAN.md)。

## 最终结果

| 检查 | 结果 / 证据 |
|---|---|
| JS 全量 | legacy **5/5** + Node **131/131**，0 fail；`docs/evidence/js-tests-0.4.0.txt`（本地）/ CI run 41181149627 |
| Python 策略 | **22/22**；`docs/evidence/ci-policy-tests-0.4.0.txt` |
| CI native-compile | run [41181149627](https://github.com/Guzhuooo/penagent/actions/runs/41181149627) @ `acabee7` 绿：JS 131/131、策略 22/22、宿主 CTest 1/1、AArch64 smoke |
| CI native-device | run [41181149672](https://github.com/Guzhuooo/penagent/actions/runs/41181149672) @ `acabee7` 绿：`.so` 970b6a… |
| AMR 构建/校验 | debug/production 均 build 成功；`verify-amr.py --native-sha256` 通过（11 资源、唯一 `libs/libjsapi_httpx.so`、AArch64 ELF、SHA 匹配） |
| 真机安装 | 0.4.0 debug，uninstall/install/start ret:0；版本 0.4.0 |
| 真机 native HTTPS POST | probe 页：`原生状态 200 · 420 B · 689 ms`（POST JSON → https://httpbin.org/post） |
| 真机 TLS 拒绝 | probe 页：过期证书 `预期拒绝：TLS_ERROR`（peer/hostname 校验生效） |
| 真机 AI 文件闭环 | 原生 transport + LAN 合成 mock：`ai-file-test {"status":"completed","toolCalls":5}`；`notes/keep.txt` 留存、`notes/ai.txt` 删除 |
| UI 高度 | 154 条尺寸声明全部 vh/vw；新增严格门禁；0.4.0 沿用 |

## 最终包（0.4.0）

appid `8002026100700001`，version `0.4.0`，入口 `index`，QuickJS `20200705`。

| 产物 | 字节 | SHA-256 |
|---|---:|---|
| `app/artifacts/0.4.0/penagent-0.4.0-debug.amr` | 638697 | `4ad0aac9aee31b748d215a8dc1e305906be60931e565e8b8a0b64f62789558cf` |
| `app/artifacts/0.4.0/penagent-0.4.0-production.amr` | 626825 | `b2f7621ac3f47d7d7bdba7fe9c0460b8c4e99183a7e0070ef6111bfbf46b9eff` |

两包均含 `libs/libjsapi_httpx.so`：488,520 B，SHA-256
`970b6a33bc568016d35291193f181af562963f76bdfe1af34d97022d4d10b4a6`（Actions run
41180136061/41181149672 构建；2018 GCC 7.5.0 + 真机 sysroot；body cap 2 MiB）。production
只是 CLI 构建模式，不是生产使用许可；两包均未用真实 endpoint/key 对话。

## Native transport（0.4.0 新增）

- `app/src/services/net/native.js`：动态 `import('httpx')` → `HttpClient.request({url,method,
  headers,body,timeoutMs,allowInsecureHttp})`，返回真实 HTTP status + body；TLS peer/host 校验、
  禁 redirect、期限、cancelAll；native 错误码映射 CANCELLED/NET_TIMEOUT/TLS_ERROR/LIMIT_REACHED
  等；模块缺失时 production fail closed，dev 模式回退 curl。
- 构建与审计：`.github/workflows/native-device-build.yml`，2018 GCC 7.5.0 AArch64 cross +
  真机 sysroot bundle；静态审计 ELF64 LE AArch64 DYN、SONAME、入口、DT_NEEDED provider
  SHA/SONAME、版本符号 ≤ 设备 glibc 2.36 / libstdc++ 6.0.29 / curl 7.79.1。
- 证据：`docs/evidence/native-device-0.4.0.txt`、`docs/evidence/ci-native-0.3.0/`、
  `native/README.md`、`native/device-bundle/manifest.json`。

## 仍未完成 / 阻塞

- **真实 OpenAI-compatible endpoint + 真实 key 对话**：无凭据，未测试；native HTTPS POST 200
  只证明传输/TLS/JSON 路径，不证明具体 API 账户、计费或模型行为。
- Falcon 线程/取消全链路、TLS 信任链异常矩阵、native 加载失败回退、长对话 2 MiB body/2 MiB
  response 压力、真实 endpoint 下的工具循环。
- IME cancel/close/重复打开/前后台；两次进出内存差与 `memoryUsageGC` 阈值；第二种逻辑分辨率。
- `native-manual.yml` + `ci-policy.json` 仍 disabled；正式发布链路仍需获批 vendor bundle。
- 干净机器依赖锁定重建；孤立 session chunk 自动清理；历史防火墙规则管理员清理。

## 证据

- `docs/evidence/js-tests-0.4.0.txt` / `ci-policy-tests-0.4.0.txt`
- `docs/evidence/build-debug-0.4.0.txt` / `build-production-0.4.0.txt`
- `docs/evidence/amr-debug-0.4.0.json` / `amr-production-0.4.0.json`
- `docs/evidence/native-device-0.4.0.txt`
- `docs/evidence/ci-native-0.3.0/`（含 41181149627/41181149672 与 41180136061）
- `docs/evidence/source-sha256-0.4.0.json`
- `app/artifacts/0.4.0/`（AMR 与截图）

这些是本地/私有仓库工程证据，不是远程发布授权。设备资料、SDK、截图与本地运行数据不能整包公开发布。
