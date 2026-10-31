# Device build run 41179283105 — first green `libjsapi_httpx.so`

- Run URL: https://github.com/Guzhuooo/penagent/actions/runs/41179283105
- Run id: `41179283105`（attempt 1）
- Workflow: `.github/workflows/native-device-build.yml`
- Trigger: `push` to `main`
- Commit: `82783bba13d319fd2e598c81ad046679dc62f6c1`
- Runner: GitHub-hosted `ubuntu-24.04`（宿主只做校验/审计，不编译）
- 结论：**job "AArch64 plugin build (2018 toolchain + device bundle)" 全部步骤 success**。

## 输入 bundle

- `native/device-bundle/device-bundle.tar.xz`
  SHA-256 `001ec916cd6810e79752c08f72620efecab396a961fa17dcfae798805acf4f81`，
  7,284,740 bytes。
- 仓库内 `manifest.json` 与压缩包内 `manifest.json` 逐字节一致
  （SHA-256 `3a2f98c36cf70997a8fc63922df91b70f3c63487b7a5e64559b7766ce2644dd2`）。
- bundle 校验：121 个文件 SHA-256、SDK 目录树哈希、curl 7.79.1 `0x074f01` pin、
  soname 别名目标全部通过；来源设备 `adb` serial `<device-serial>`（Y02 / 4.9.7 /
  Buildroot 2021.11 / kernel 5.10.160）。

## 工具链（容器内，全部在 Actions）

- 容器：`ubuntu:18.04`，`ubuntu@sha256:152dc042452c496007f07ca9127571cb9c29697f42acbfad72324b2bb2e43c98`，
  image id `sha256:f9a80a55f492e823bf5d51f1bd5f87ea3eed1cb31788686aa99a2fb61a27af6a`。
- 编译器：`aarch64-linux-gnu-g++ (Ubuntu/Linaro 7.5.0-3ubuntu1~18.04) 7.5.0`，
  triple `aarch64-linux-gnu`，`-print-sysroot` = `/`。
- binutils：`GNU ld/nm/readelf ... 2.30`（`binutils-aarch64-linux-gnu 2.30-21ubuntu1~18.04.9`）。
- CMake：`3.18.4`（bionic 自带 3.10 太旧；容器内 `pip3 install cmake==3.18.4.post1`）。
- glibc dev headers：`libc6-dev-arm64-cross 2.27-3ubuntu1cross1.1`。
- sysroot：容器内 `/tmp/ci-sysroot` = 工具链 dev 文件 ∪ bundle 设备库；24 个设备库
  覆盖同名工具链库（逐库 SHA-256 见 artifact `toolchain-identity.txt`）。

## 产物与审计

- `libjsapi_httpx.so`：488,520 bytes，SHA-256
  `22d4e811dd8bb003a86c0c492f04875803637aa8a3f1f3eb1a4aec7544fcf5cd`。
- `build.log`：33,078 bytes；`elf-report.json`：4,877 bytes。
- `SHA256SUMS`（4 文件，`.so` + 3 个文本）：见本目录 artifact 副本。
- ELF：ELF64 little-endian AArch64、`Type: DYN`、SONAME `libjsapi_httpx.so`；
  无 `PT_INTERP`、`RPATH`/`RUNPATH`、`TEXTREL`。
- 入口：`custom_init_jsapis` 以 GLOBAL FUNC 导出（`CheckHttpxElf.cmake` post-build
  gate 与宿主审计双重确认）。
- DT_NEEDED 与设备 provider（bundle 内，SHA/SONAME 均匹配）：
  `libcurl.so.4`、`libstdc++.so.6`、`libgcc_s.so.1`、`libc.so.6`、
  `ld-linux-aarch64.so.1`（loader 无 SONAME，按文件名匹配）。
- 版本符号上限（required ≤ device maxima）：
  `GLIBC_2.17 ≤ GLIBC_2.36`、`GLIBCXX_3.4.21 ≤ GLIBCXX_3.4.29`、
  `CXXABI_1.3.9 ≤ CXXABI_1.3.13`、`GCC_3.0 ≤ GCC_11.0`；
  全部 required 版本符号都由上述 provider 的 `.gnu.version_d` 定义。
- 未解析导入 174 个（Falcon host 导出 + libcurl + 目标 libc/stdc++），由设备加载时
  解析；本次审计**不能**证明它们在设备运行时存在。

## artifact 文件

`native-device-82783bba13d319fd2e598c81ad046679dc62f6c1/`：

- `libjsapi_httpx.so`（488,520 bytes）
- `build.log`
- `elf-report.json`
- `SHA256SUMS`
- `toolchain-identity.txt`（容器/工具链/sysroot 逐库 SHA、容器 digest）
- `summary.md`

（`.so` 被仓库 `.gitignore` 的 `*.so` 规则排除，只保存在 Actions artifact 与本机
下载副本中；入库的是文本证据与 SHA-256。）

## 仍未证明 / 下一步

- 未安装进 AMR、未在设备 `miniapp_cli install/start` 加载，因此没有加载日志、
  导出功能、TLS/CA、取消/销毁、Falcon 线程或运行时兼容证据。
- `native-manual.yml` + `ci-policy.json` 仍保持 `enabled: false`；正式发布链路仍需
  用户批准的 vendor toolchain/SDK/sysroot bundle 与披露范围。
