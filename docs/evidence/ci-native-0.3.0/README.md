# CI native evidence — 0.3.0 cycle

本目录只保存**在 GitHub Actions 中真实执行**的构建/测试证据。项目要求：所有 C/C++
configure、编译、链接、CTest 都只能发生在 Actions；本目录中的日志均由 workflow
上传的 artifact 原样下载，未在本机重跑、未改写结论。

## 信任边界

- `.github/workflows/native-compile.yml` 是**实用型 CI**，不是设备产物流水线：
  - 宿主分支 `HTTPX_BUILD_PLUGIN=OFF`、`HTTPX_BUILD_TESTS=ON`，用 runner 自带
    `g++`/libcurl 编译并运行 loopback 合成测试（不接触设备）。
  - AArch64 分支只做 **compile-only** 冒烟（`aarch64-linux-gnu-g++ -c`），用
    readelf 确认 ELF64/AArch64；**不链接、不执行、不生成 `.so`**。
  - 因此本目录**不是**设备 ABI / TLS / 取消 / 加载兼容证据。
- `.github/workflows/native-device-build.yml` 是**设备插件**构建（2018-era 工具链 +
  真机 sysroot bundle）。它在 `ubuntu:18.04` 容器里链接出 `libjsapi_httpx.so`，再做
  静态 ELF/DT_NEEDED/版本符号审计；产物**未**装进 AMR、未在设备加载，因此同样**不是**
  TLS/取消/运行时/加载兼容证据。
- `.github/workflows/native-manual.yml` + `native/ci-policy.json`（`enabled: false`）
  保持原样：正式 released-artifact 链路仍需要获批的 vendor toolchain/sysroot bundle。
- 仓库为私有仓库 `Guzhuooo/penagent`；这些日志中不含凭据；设备来源数据只来自项目
  已记录的 Y02 profile。

## 运行记录

| run id | 触发 | commit | JS 测试 | 策略测试 | 宿主 CTest | AArch64 冒烟 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [40168576908](https://github.com/Guzhuooo/penagent/actions/runs/40168576908) | push | `e6f0832` | 93/93 通过 | 22/22 通过 | 1/1 通过（1.63s） | 2 个目标文件 ELF64/AArch64 | 绿 |
| [40168752041](https://github.com/Guzhuooo/penagent/actions/runs/40168752041) | push | `f4a020e` | 93/93 通过（node 20.20.2） | 22/22 通过 | 1/1 通过（1.63s） | 2 个目标文件 ELF64/AArch64，SHA-256 与上次一致 | 绿 |
| [40169416478](https://github.com/Guzhuooo/penagent/actions/runs/40169416478) | push | `824ffaf` | 93/93 通过（node 20.20.2） | 22/22 通过 | 1/1 通过（1.64s） | 2 个目标文件 ELF64/AArch64，SHA-256 与前两次一致 | 绿 |
| [41175666914](https://github.com/Guzhuooo/penagent/actions/runs/41175666914) | workflow_dispatch | `bc01903` | **124/124** 通过（最终 0.3.0 源码） | 22/22 通过 | 1/1 通过（1.64s） | 2 个目标文件 ELF64/AArch64 | 绿 |
| [41179510006](https://github.com/Guzhuooo/penagent/actions/runs/41179510006) | push | `58f5bc9` | **126/126** 通过（node 20.20.2） | 22/22 通过 | 1/1 通过（1.64s） | 2 个目标文件 ELF64/AArch64，SHA-256 与之前一致 | 绿 |

明细见各 `run-<id>.md` 与对应 `run-<id>/` 目录。

当前 HEAD 的验证状态：commit `9cab02e` 上 `native-device-build.yml` run
[41180136061](https://github.com/Guzhuooo/penagent/actions/runs/41180136061) 全绿
（`.so` 488,520 B / SHA `970b6a33…10b4a6`，request body 上限 2 MiB）；更早 commit
`58f5bc9` 上 `native-compile.yml` run 41179510006（JS 126/126、策略 22/22、CTest 1/1、
AArch64 冒烟）与 `native-device-build.yml` run 41179509958 全绿（旧 body 上限，
`.so` SHA `22d4e811…4fcf5cd`）。同一 commit 的 push 触发 run `41175661246` 因并发策略被
手动 run 取消（cancelled，非失败）。最终 0.4.0 AMR 已使用 `970b6a33…` 的 `.so`，并在
Y02 真机通过原生 HTTPS POST 200 与过期证书 TLS_ERROR 拒绝探针。

## 设备构建记录（`.github/workflows/native-device-build.yml`）

2018-era 工具链 + 真机自取 sysroot bundle（`native/device-bundle/`）在 Actions 容器内
构建 `libjsapi_httpx.so` 并静态审计：

| run id | 触发 | commit | 工具链 | 产物 SHA-256 | 审计 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| [41179283105](https://github.com/Guzhuooo/penagent/actions/runs/41179283105) | push | `82783bb` | ubuntu:18.04 / GCC 7.5.0 (`aarch64-linux-gnu-g++`), cmake 3.18.4 | `22d4e811…4fcf5cd`（488,520 B） | ELF64/AArch64 DYN、无 INTERP/RPATH/TEXTREL、DT_NEEDED 全部有设备 provider、版本符号 ≤ 设备上限 | 绿 |
| [41179509958](https://github.com/Guzhuooo/penagent/actions/runs/41179509958) | push | `58f5bc9` | 同上（容器 digest 相同） | `22d4e811…4fcf5cd`（与上次一致，可复现） | 同上，全部通过 | 绿 |
| [41180136061](https://github.com/Guzhuooo/penagent/actions/runs/41180136061) | push | `9cab02e` | 同上 | `970b6a33…10b4a6`（488,520 B，body cap 2 MiB） | 同上；已打进 0.4.0 AMR，真机通过原生 HTTPS/TLS 探针 | 绿 |

明细与下载的 artifact 见各 `native-device-run-<id>.md` 与目录（`.so` 被 `.gitignore` 的
`*.so` 排除，只在 Actions artifact 与本地下载副本中）。

## 复现 / 重跑

```sh
gh workflow run native-compile.yml --ref main
gh run list --workflow native-compile.yml
gh run view <run-id>
gh run download <run-id> -D docs/evidence/ci-native-0.3.0/run-<run-id>

gh workflow run native-device-build.yml --ref main
gh run list --workflow native-device-build.yml
gh run download <run-id> -D docs/evidence/ci-native-0.3.0/native-device-run-<run-id>
```

## 目录内容

- `run-<id>/js-tests-<sha>/js-tests.log`：Node 20 下 `npm --prefix app test` 的完整输出。
- `run-<id>/native-ci-evidence-<sha>/`：
  - `python-policy-tests.log`：`tools/tests/test_native_ci.py` 22 项 fail-closed 合同测试；
  - `host-configure.log` / `host-build.log` / `host-ctest.log`：宿主 CMake+CTest；
  - `aarch64-compile.log` / `aarch64-readelf.txt`：AArch64 编译冒烟与 ELF 校验、
    目标文件 SHA-256、未解析符号片段；
  - `toolchain-versions.txt` / `runner-identity.txt`：runner 与工具身份；
  - `summary.md`：workflow 生成的运行摘要（同样写入 Actions Step Summary）。
- `native-device-run-<id>/native-device-<sha>/`（设备构建）：
  - `libjsapi_httpx.so`：仅在本地下载副本/artifact 中（`*.so` 不入库）；
  - `build.log`：容器内 apt/pip/CMake/Make 与 CheckHttpxElf 输出；
  - `elf-report.json`：FAIL-CLOSED 的 ELF/DT_NEEDED/provider/版本符号审计结果；
  - `toolchain-identity.txt`：容器 digest、GCC/binutils/CMake 版本、sysroot 逐库 SHA；
  - `SHA256SUMS` / `summary.md`：artifact 校验与运行摘要。
