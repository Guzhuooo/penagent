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
- `.github/workflows/native-manual.yml` + `native/ci-policy.json`（`enabled: false`）
  保持原样：设备 `.so` 仍需要获批的 vendor toolchain/sysroot bundle。
- 仓库为私有仓库 `Guzhuooo/penagent`；这些日志中不含 SDK、凭据或设备数据。

## 运行记录

| run id | 触发 | commit | JS 测试 | 策略测试 | 宿主 CTest | AArch64 冒烟 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [40168576908](https://github.com/Guzhuooo/penagent/actions/runs/40168576908) | push | `e6f0832` | 93/93 通过 | 22/22 通过 | 1/1 通过（1.63s） | 2 个目标文件 ELF64/AArch64 | 绿 |
| [40168752041](https://github.com/Guzhuooo/penagent/actions/runs/40168752041) | push | `f4a020e` | 93/93 通过（node 20.20.2） | 22/22 通过 | 1/1 通过（1.63s） | 2 个目标文件 ELF64/AArch64，SHA-256 与上次一致 | 绿 |
| [40169416478](https://github.com/Guzhuooo/penagent/actions/runs/40169416478) | push | `824ffaf` | 93/93 通过（node 20.20.2） | 22/22 通过 | 1/1 通过（1.64s） | 2 个目标文件 ELF64/AArch64，SHA-256 与前两次一致 | 绿 |

明细见各 `run-<id>.md` 与对应 `run-<id>/` 目录。

仓库最后一次被本 workflow 完整验证的 commit 是 `824ffaf`（run 40169416478）；其后
只向本目录追加文档/证据，未改动 `native/`、`tools/` 或 workflow，因此没有新的运行。

## 复现 / 重跑

```sh
gh workflow run native-compile.yml --ref main
gh run list --workflow native-compile.yml
gh run view <run-id>
gh run download <run-id> -D docs/evidence/ci-native-0.3.0/run-<run-id>
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
