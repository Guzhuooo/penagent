# Device-derived native bundle — profile `y02-4.9.7`

本目录是**设备来源**的构建输入，仅供 GitHub Actions 中的 native 插件构建/静态审计使用：
SDK + curl 7.79.1 headers + 真机运行库 + `libfalcon.so`。所有 C/C++ configure、编译、
链接、ELF 审计都在 `.github/workflows/native-device-build.yml` 的容器里执行，**不在本机
编译**；本目录只做采集与打包。

## 内容

| 文件 | 说明 |
| --- | --- |
| `device-bundle.tar.xz` | 7,286,284 bytes，SHA-256 `2348651ea6a21e0a323b5cc974c03212f09ae0050a8b968750a9c90c4bd0063c` |
| `manifest.json` | 与压缩包内 `manifest.json` 逐字节一致（SHA-256 `5998863add7a40df66b638632ce750cec2d0b2ed5c95ce6cefb8e0bc77c987d0`），含全部 121 个文件的 SHA-256、设备路径与版本证据 |
| `build_bundle.py` | 采集/打包脚本（只做 adb pull、下载校验、哈希与打包；不编译） |

压缩包布局：

```text
manifest.json
sdk/include/                 SDK 头文件（来源 iot-miniapp-sdk.zip，SHA-256 564af743…）
sdk/src/                     SDK 源码（CMake 中作为静态库编译）
sysroot/usr/include/curl/    curl 7.79.1 headers（12 个文件，curlver.h 版本号 0x074f01）
sysroot/lib/                 24 个设备运行库（原始文件名）
sysroot/aliases.tsv          构建时创建的 soname / -l 别名表
falcon/libfalcon.so          设备 Falcon host 导出证据（不链接进插件）
provenance/                  adb 命令、设备身份、设备端 sha256sum 交叉校验
```

纳入 `sysroot/lib/` 的设备库（均为真机 `/usr/lib`，`/lib` 是 `/usr/lib` 的软链接）：
`ld-linux-aarch64.so.1`、`libc.so.6`、`libm.so.6`、`libpthread.so.0`、`libdl.so.2`、
`librt.so.1`、`libgcc_s.so.1`、`libstdc++.so.6.0.29`、`libcurl.so.4.7.0`，以及 libcurl
在设备上的直接依赖闭包：`libcares.so.2.5.1`、`libidn2.so.0.3.7`、`librtmp.so.1`、
`libpsl.so.5.3.2`、`libssl.so.1.1`、`libcrypto.so.1.1`、`libz.so.1.2.11`、
`libatomic.so.1.2.0`、`libgmp.so.10.4.1`、`libgnutls.so.30.30.0`、`libhogweed.so.6.4`、
`libiconv.so.2.6.0`、`libnettle.so.8.4`、`libunistring.so.2.1.0`、`libtasn1.so.6.6.1`。
`libnghttp2` 未出现在设备 libcurl 的 `DT_NEEDED` 中，因此不收录。

## 来源与校验（provenance）

- 设备：`adb` serial `<device-serial>`；`Y02-3562` / RK3562 / 固件 `4.9.7` /
  `Buildroot 2021.11` / kernel `5.10.160`（`provenance/device-identity.txt`）。
- 每个文件都用 `adb pull` 取回，并与**设备自身的 `sha256sum`** 交叉校验（25/25 通过，
  `provenance/device-sha256sum.txt`），随后写入 `manifest.json` 的 `files`/`libraries`。
- SDK：`iot-miniapp-sdk.zip` SHA-256 `564af743ba947eec3b1b4784ff99a3fcf6d8506f7eb59ef5be464f5505ca263a`，
  `manifest.json` 记录其 SDK 目录树哈希。
- curl headers：官方 `https://curl.se/download/curl-7.79.1.tar.gz`，来源 SHA-256
  `370b11201349816287fb0ccc995e420277fbfcaf76206e309b3f60f0eda090c2`，只取
  `include/curl/`；`curlver.h` 中 `LIBCURL_VERSION_NUM` = `0x074f01`。
- 压缩包本身在 workflow 中按上面的 SHA-256 校验，且压缩包内 `manifest.json` 必须与仓库
  内的 `manifest.json` 逐字节一致，否则立即失败。

设备 ABI 证据（由设备库的 ELF 版本定义得出，记入 `manifest.json`）：

| 项 | 设备实际 |
| --- | --- |
| 架构 / 字节序 | AArch64 / little-endian / ELF64 |
| glibc | 2.36（`GLIBC` 最高 `GLIBC_2.36`） |
| libstdc++ | 6.0.29（`GLIBCXX` 最高 `GLIBCXX_3.4.29`，`CXXABI_1.3.13`） |
| libgcc | `GCC_11.0` |
| curl | 7.79.1（`libcurl.so.4.7.0`，SONAME `libcurl.so.4`） |
| TLS | `OpenSSL 1.1.1l`（libssl/libcrypto 1.1.1 系列） |

## 2018-era 工具链（构建时，不在本机）

- 容器：`ubuntu:18.04`（EOL 镜像；CI 运行时记录 `RepoDigests`/`Image ID`）。
- 交叉编译器：`g++-aarch64-linux-gnu` = **GCC 7.5.0**（Ubuntu 18.04，2018-era GNU
  toolchain，glibc 2.27 dev headers），target triple `aarch64-linux-gnu`。
- CMake：bionic 自带 3.10 太旧，容器内 `pip3 install cmake==3.18.4.post1`。
- sysroot：容器内把工具链自带 dev 文件与本 bundle 的设备库/curl headers **合并**成
  `/tmp/ci-sysroot`（bundle 只提供设备部分，不会用宿主库冒充目标库）；构建后由
  `native/cmake/audit_device_elf.py` 复核 DT_NEEDED provider、版本符号上限、无
  RPATH/PT_INTERP/TEXTREL 和 `custom_init_jsapis` 入口。

## 重建

```sh
python native/device-bundle/build_bundle.py \
    --sdk-zip iot-miniapp-sdk.zip \
    --curl-tarball curl-7.79.1.tar.gz \
    --adb-serial <device-serial>
```

脚本会重新校验 zip/curl SHA-256、重新 adb pull 并交叉校验设备哈希、重建
`manifest.json` 与压缩包。若输出 SHA-256 变化，必须同步更新
`.github/workflows/native-device-build.yml` 的 `BUNDLE_ARCHIVE_SHA256`，并作为一次
可审查的变更提交。

## 边界（不得越界声明）

- 本 bundle 是**私有仓库**内的真机固件内容，仅供本项目的 CI 构建/审计；不得公开再
  分发，也不代表 SDK/固件许可之外的授权。
- 它不等于“vendor 批准的正式工具链 bundle”：`native-manual.yml` + `native/ci-policy.json`
  仍保持原样 disabled，本目录不替代该审批流程。
- 构建出的 `.so` 只证明**静态**链接/ELF 结果；未安装进 AMR、未在设备加载，因此不声称
  设备加载、TLS 信任链、取消语义或 Falcon 线程兼容。
