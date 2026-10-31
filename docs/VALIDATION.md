# 0.3.0 验证状态

更新：2026-10-31。**0.3.0 宿主测试、AMR 构建与 Y02 真机工作区/AI 文件工具闭环已完成；
生产真实 endpoint 与生产安全网络仍未通过。** 逐步记录见 [PROGRESS.md](PROGRESS.md) R09，
规划见 [PLAN.md](PLAN.md)，工具/工作区细节见 [CUSTOM_TOOLS](CUSTOM_TOOLS.md) /
[WORKSPACE_TOOLS](WORKSPACE_TOOLS.md)。

## 本轮最终结果

| 检查 | 实际方法 | 结果 / 边界 |
|---|---|---|
| 全量 JavaScript | `node D:/penagent/app/test/all.mjs` | legacy **5/5**；Node **124/124**；0 fail/cancelled/skipped；日志 `docs/evidence/js-tests-0.3.0.txt` |
| CI 策略 | `python -m unittest discover -s tools/tests -p 'test_*.py'` | **22/22**，纯 Python，无 C/C++ 执行 |
| 自造工具 / 识别 | 套件 `custom-tools.test.mjs` + `ui.test.mjs` | recipe 校验/执行/持久化重启/损坏存储/限额/识别排序、define→调用→回答 3 请求闭环、工具页 IME 清理 |
| 工作区工具 | `workspace.test.mjs` | 路径穿越拒绝、写/读/追加/删、执行超时与输出截断、适配器缺失 fail closed、真实 HTTP mock 3 请求 5 工具闭环 |
| 开发 curl 传输 | `net-dev.test.mjs` | 私网/合成 key 闸门、真实 status、临时文件清理、超时/取消错误；非生产 adapter |
| emoji 回归 | `source-contract.test.mjs` + 设备截图 | app/src 无 emoji/状态符号；图标为内联 PNG，状态用“已开启/已关闭”文字 |
| QuickJS 构建 | `npm --prefix app run build` / `build:prod` | 均退出 0；保留 theme-default 缺失、runtime 外部模块、Node http_parser 警告 |
| AMR 只读校验 | `tools/verify-amr.py` | 两包 appid/version、10 个脚本资源 size/MD5、入口含 app/index/settings/probe/tools/workspace、图标、无 native 库 |
| 真机安装 | `miniapp_cli uninstall/install/start` | Y02 4.9.7，install/start ret:0；覆盖安装与干净安装均执行，最终以干净安装取证 |
| 工作区自检 | 页面“运行自检” | 设备日志 `[pa:workspace] selftest {"ok":true,"steps":9}`；写/读/追加/列目录/执行/退出码/删除文件/删除空目录通过 |
| 开发模式 AI 文件闭环 | LAN 合成 mock + 真机 | 3 次模型 POST（5055/6388/7214 bytes，authorized=true）→ 5 次工具调用；最终 `notes/keep.txt` 留存、`notes/ai.txt` 删除，`status=completed toolCalls=5` |
| 设备 UI | capture 截图 | 工作区、设置文件工具开关、工具页、聊天页；`settings-file-tools.png` 中开关为 PNG 图标 + 文字 |

## 最终预览包

身份：appid `8002026100700001`，version `0.3.0`，规范入口 `index`，QuickJS `20200705`，无 `.so`。

| 产物 | 字节 | SHA-256 |
|---|---:|---|
| `app/artifacts/0.3.0/penagent-0.3.0-debug.amr` | 455247 | `37431def3660afbd262226ff4016c3199bd9362e7f705904f049e3ce753f49d5` |
| `app/artifacts/0.3.0/penagent-0.3.0-production.amr` | 443721 | `86d0a93298359463b880aeb61ff086a6191b15799728c658af5a5b4e9f15d972` |

“production”只指 CLI 构建模式，不是生产使用许可或验收通过。两个包都绑定最终源码；开发
origin 已恢复为 `http://127.0.0.1:8787`，无临时 LAN 地址。构建环境和依赖锁定仍未在干净机器重建。

## 工作区 / AI 文件能力

- 平台依据（Y02 实测）：`import('fs')` 可用但**无 open/write/rename**；`import('process')` 的
  `exec(file,args,options)` 返回 `{code,signal,stdout,stderr}`；`/bin/timeout` 存在。写文件用
  POSIX 引用后的 `printf > file` + fs 校验，执行统一 `/bin/timeout` 限时。原始记录见
  `docs/evidence/fs-probe-0.3.0.txt`、`DEVICE_PROBING.md` §12。
- 工作区根：`<appid>/data/penagent-workspace`，由 `$workspace` 槽目录推导，覆盖安装不删除 AI 文件。
- 工具：`file_list/file_read/file_write/file_delete` 默认开启，`file_exec` 默认关闭（设置页可开，
  高风险提示）。路径只能工作区相对；删除不允许根/非空目录；输出限幅。
- 真机证据：`docs/evidence/workspace-selftest-0.3.0.txt`、`workspace-ai-test-0.3.0.txt`、
  `workspace-device-0.3.0.txt`；截图 `app/artifacts/0.3.0/final-selftest.png`、
  `final-ai-lines2.png`、`settings-file-tools.png`、`tools.png`、`chat.png`。
- 取证后设备设置已恢复为空生产配置（无 key/URL/dev 模式，`file_exec=false`），工作区 notes/.net 已清理，
  mock 已停止。

## 开发模式网络 / 生产边界

生产仍禁用 flat `http.request`，原因不是 POST 不支持，而是已静态确认：关闭 TLS peer/hostname
校验、自动 redirect、无真实 HTTP status、无 caller timeout/signal，未发现 abort。生产必须 native
或其他独立验证安全 adapter。0.3.0 新增的 `services/net/dev.js` 只在
`developmentMode=true` + 回环/私网 host + 合成 `Bearer test-/mock-/fake-` key 时使用设备 curl，
返回 curl 真实 status，带 `-m` 与 `/bin/timeout`、响应上限、工作区临时文件清理，不记录 body/
header/key；它**不是**生产 adapter，不能解锁真实 endpoint。真机 AI 文件测试只使用该通道与合成内容。

## GitHub Actions / native

仓库 `Guzhuooo/penagent`（private）的 `.github/workflows/native-compile.yml` 最近一次 run
（`41175666914`，commit `bc01903`，最终 0.3.0 源码）全绿：JS **124/124**、Python 策略 22/22、
宿主 CTest **1/1 Passed**、AArch64 compile-only ELF64/AArch64。更早三次 run
`40168576908`、`40168752041`、`40169416478`（commit `824ffaf`）同样为绿。

- Node 测试（当时 93/93，后续 0.3.0 源码本地 124/124）；Python 策略 22/22；
- 宿主 CMake `HTTPX_BUILD_PLUGIN=OFF / HTTPX_BUILD_TESTS=ON` + CTest `1/1 Passed`；
- AArch64 compile-only 冒烟：`aarch64-linux-gnu-g++ -c`，目标文件 ELF64/AArch64，不链接、不执行。
- 证据目录 `docs/evidence/ci-native-0.3.0/`，含 run 摘要、host-ctest、aarch64-readelf、工具身份。

**所有 C/C++ configure/compile/link/CTest 只在 GitHub Actions 执行，本轮本机未执行。** 设备 `.so`
仍阻塞：没有获批 vendor toolchain/sysroot bundle；`native/ci-policy.json` 保持 disabled，
`native-manual.yml` 不启用。无设备 `.so`、ELF/SHA、真机加载/TLS 证据，不声称可用 native。

## 仍未完成 / 阻塞

- **最终 0.3.0 源码已推送并完成 CI**：commit `bc01903`（源码等同 `c2392c0`）的
  `native-compile.yml` 手动 run [41175666914](https://github.com/Guzhuooo/penagent/actions/runs/41175666914)
  两 job 全绿：JS **124/124**、策略 **22/22**、宿主 CTest **1/1**、AArch64 compile-only
  ELF64/AArch64。证据在 `docs/evidence/ci-native-0.3.0/run-41175666914/`。同一 commit 的 push
  run `41175661246` 被并发策略取消（cancelled，非失败）。
- 真实 endpoint 对话与生产凭据使用；生产安全 adapter 的 TLS peer/host、redirect、可信 status、
  接收限额、期限/取消/回收及有效/无效证书动态验收。
- 设备端 `file_exec` 的物理取消：已开始子进程只保证 `/bin/timeout` 墙钟上限，不能保证立即撤销。
- IME cancel/close/重复打开/前后台；两次进出与 `memoryUsageGC` 阈值；第二种逻辑分辨率 / 真机视觉/触控。
- 覆盖安装后旧 realm 继续运行时出现的一次 AI 重试失败；干净安装成功。热重载/运行态刷新不是验收路径。
- 真实 endpoint 下的自造工具创建/识别与工具页交互（本轮仅宿主 + 设备合成流量验证文件工具）。
- native `.so` 的 GitHub Actions 获批 bundle 构建、ELF/依赖/符号/SHA 与真机加载。
- 干净机器依赖锁定重建；孤立 session chunk 自动清理（4 MiB 只是索引历史预算）。
- 历史防火墙规则 Named `{750A4680-D434-48CF-AD2E-70ADF02FD95A}` 仍需管理员清理（本轮未提权重试）。

## 证据

- `docs/evidence/js-tests-0.3.0.txt`
- `docs/evidence/ci-policy-tests-0.3.0.txt`
- `docs/evidence/build-debug-0.3.0.txt` / `build-production-0.3.0.txt`
- `docs/evidence/amr-debug-0.3.0.json` / `amr-production-0.3.0.json`
- `docs/evidence/fs-probe-0.3.0.txt`
- `docs/evidence/workspace-selftest-0.3.0.txt` / `workspace-ai-test-0.3.0.txt` / `workspace-device-0.3.0.txt`
- `docs/evidence/emoji-scan-0.3.0.txt`
- `docs/evidence/source-sha256-0.3.0.json`
- `docs/evidence/ci-native-0.3.0/`
- `app/artifacts/0.3.0/`（AMR 与设备截图；截图含 UI 但无 key/payload）

这些是本地/私有仓库工程证据，不是远程发布授权。设备资料、SDK、截图与本地运行数据不能整包公开发布。
