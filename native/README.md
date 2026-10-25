# Native CI preparation — not a compatibility claim

此目录是可选 M0.5 路线。平台 POST 能力仍须有效复测；存在 SDK 不等于启用 native。
遵循 `docs/STANDARDS.md` §11。**全部 C/C++ configure、编译、链接、CTest 只允许在 GitHub Actions；不要在本机执行 CMake、编译器或 CTest。**

## 当前状态（2026-10-25）

- 用户已授权创建**私有**仓库 `https://github.com/Guzhuooo/penagent`（默认分支 `main`）；
  public 可见性未授权，仓库实际为 private。
- 新增实用型 `.github/workflows/native-compile.yml`，已在 GitHub Actions 真实跑绿：
  JS 测试、纯 Python 策略合同测试、宿主 CMake 编译 + CTest、AArch64 compile-only
  冒烟。已绿运行：run
  [40168576908](https://github.com/Guzhuooo/penagent/actions/runs/40168576908)
  @ `e6f0832`（首次）与 run
  [40168752041](https://github.com/Guzhuooo/penagent/actions/runs/40168752041)
  @ `f4a020e`；两次两个 job 均成功，CTest 1/1 通过，AArch64 目标文件 SHA-256 一致。
  逐 run 明细、ctest 输出与下载的 artifact 见 `docs/evidence/ci-native-0.3.0/`。
  **本机从未执行** CMake、编译器或 CTest。
- **仍阻塞**：设备 `.so` 的链接/交付需要获批的固定 toolchain + SDK + sysroot bundle
  （来源、revision、SHA-256、许可、artifact 披露范围均未批准且不可下载），因此
  `ci-policy.json` 保持 `enabled: false`、`native-manual.yml` 保持未启用；
  AArch64 插件链接/设备加载仍需该 bundle。**本目录不声称任何 `.so` 设备兼容。**
- action 固定完整 revision：checkout `11bd71901bbe5b1630ceea73d27597364c9af683`
  （v4.2.2）、setup-node `39370e3970a6d050c480ffad4ff0ed4d3fdee5af`（v4.1.0）、
  upload-artifact `ea165f8d65b6e75b540449e92b4886f43607fa02`（v4.6.2）。本次已用
  GitHub API 在线核对这三个 tag 对应的 commit SHA；后续审批仍应复核，不关闭 TLS 校验。

## 实用型 CI：宿主测试 + AArch64 编译冒烟

`.github/workflows/native-compile.yml`（`workflow_dispatch`；另在 push 到 `main` 且改动
`.github/workflows/native-compile.yml`、`native/**`、`tools/**` 时自动运行）：

- `js-tests` job（ubuntu-24.04）：Node 20，`npm --prefix app test`（无依赖安装步骤）。
- `native` job（ubuntu-24.04）按顺序执行，全部日志以文本 artifact 上传：
  1. 记录 runner/工具身份（Ubuntu 版本、g++/cmake/ninja/python/curl、交叉 triple）；
  2. `python3 -B -m unittest discover -s tools/tests -p 'test_native_ci.py' -v`
     （22 项 fail-closed 策略合同，无 C/C++）；
  3. `cmake -S native -B build-host -DHTTPX_BUILD_PLUGIN=OFF -DHTTPX_BUILD_TESTS=ON
     -DCMAKE_BUILD_TYPE=Release` + build + `ctest --output-on-failure`；
  4. AArch64 **compile-only** 冒烟：`aarch64-linux-gnu-g++ -std=gnu++17 -O2
     -Wall -Wextra -c` 编译 `httpx_core.cpp` 与 `httpx_core_tests.cpp`，再用
     `file` + `aarch64-linux-gnu-readelf -h` 断言 `ELF64` / `AArch64`，并检查 curl、
     socket、pthread 未解析符号片段。**不链接、不执行、不产出 `.so`。**
- 信任边界：该 workflow 使用 runner 自带宿主工具链，只证明源码在 Actions 中可编译、
  宿主 core 测试可通过；**不是**设备 ABI/TLS/取消/加载证据，也不替代
  `native-manual.yml` 的审核流程。
- 宿主 curl：runner 为 8.5.0，满足 `native/CMakeLists.txt` 现有的
  `find_package(CURL 7.79.1)` 宿主分支下限，**因此无需放宽下限**；插件分支
  `curlver.h` `0x074f01`（7.79.1）pin 保持原样。宿主 8.5.0 会给出
  `CURLOPT_PROTOCOLS`/`CURLOPT_REDIR_PROTOCOLS` 弃用告警，仅出现在宿主/冒烟编译，
  设备分支 pin 的 7.79.1 无此弃用。
- 重跑：`gh workflow run native-compile.yml --ref main`，然后
  `gh run list --workflow native-compile.yml` / `gh run view <run-id>`。

## 审批和运行边界

先人工审查 `.github/workflows/native-manual.yml`、`tools/native-ci.py` 和策略，再由用户明确授权：

1. `authorization.repository` 精确 owner/repo、`visibility` 为 public/private/internal、`ref` 为具体 `refs/heads/...`、非敏感 `approval_reference`。
2. `source_upload_scope` 使用明确路径 / glob；不要使用全仓 `**`。脚本核对所有 Git tracked 文件均在范围内（glob 使用 Python fnmatch，`*` 可跨 `/`，审批时注意）。**此运行时门禁不能撤销之前的 push**：授权必须发生在建立仓库或上传任何源码之前。不批准 SDK/sysroot 入仓。
3. `artifact_upload_scope` 必须逐字为下列六项且顺序相同：
   `libjsapi_httpx.so`, `manifest.json`, `SHA256SUMS`, `build.log`, `link-command.json`, `elf-report.json`。
   包括二进制、脱敏阶段日志、精确链接命令（仅替换临时目录前缀）、工具身份与来源摘要、依赖和符号名称。需要单独批准这个披露范围；不含 SDK、sysroot、源码、测试 payload 或原始工具输出。
4. bundle URL、压缩包 SHA-256、根 manifest SHA-256 必须固定在策略中并与手动输入相同，然后才可将 `enabled` 改为 true。
5. 人工配置 `native-reviewed` GitHub Environment 的 required reviewers、允许分支和无敏感 secrets；workflow 文件不能自动确保仓库启用了这些保护。不要向任务注入真实 key 或设备数据，关闭 Actions debug logging。workflow_dispatch 输入会由 GitHub 保存，因此 URL 和输入本身也不得含凭据或隐私。

只允许 `workflow_dispatch`，不响应 push/PR/定时任务；最小 `contents: read`，checkout 不保留凭据；不调用 apt、包安装器、SDK 上传、release、部署或目标程序。runner 固定为 `ubuntu-24.04` 标签（GitHub 托管镜像并非 immutable image）。目标编译工具必须来自获批 bundle，不从 runner 自动选编译器/目标库。宿主测试有意使用 bundle 中显式宿主编译器及 curl 开发文件，宿主基础系统运行库仅服务 CI core tests，不作为设备依赖证据。

## 获批 immutable bundle 合同

只接受公开、无认证的 HTTPS：

```text
https://<approved-public-host>/sha256/<64-lowercase-sha256>/bundle.tar.xz
```

不自动选择镜像/最新版本，不使用 secrets 或签名 query。拒绝 userinfo、query、fragment、非 443 端口、IP 字面量、私网/保留 DNS 地址和全部 HTTP 重定向。连接绑定已校验公网 IP，TLS 仍验证原 hostname。压缩包 SHA 验证后才解包；限制下载/展开体积和成员数，拒绝绝对路径、`..`、重复条目、软/硬链接、稀疏文件、设备节点。发布者须将 SDK/工具链/sysroot 所需链接预先物化为普通文件，并调整绝对链接脚本；不为适配而偷用 host 库。工具链必须在指定 runner 上可运行。

根目录必须有 `manifest.json`（UTF-8，不允许重复 key）。以下字段全必需；示例中的占位值**不是有效来源、SHA 或兼容性证据**，不得直接启用：

```json
{
  "schema_version": 1,
  "profile": "y02-4.9.7",
  "abi": {
    "machine": "AArch64", "class": "ELF64", "endian": "little", "libc": "glibc",
    "libc_version": "<verified-version>",
    "libstdcxx_version": "<verified-version>",
    "curl_version": "7.79.1", "tls_version": "<verified-backend-and-version>"
  },
  "toolchain": {
    "path": "toolchain", "revision": "<fixed-revision>",
    "source_url": "https://<approved-host>/<fixed-source>",
    "source_sha256": "<original-source-archive-sha256>", "tree_sha256": "<materialized-tree-sha256>"
  },
  "sdk": {
    "path": "sdk", "revision": "<fixed-revision>",
    "source_url": "https://<approved-host>/<fixed-source>",
    "source_sha256": "<original-source-archive-sha256>", "tree_sha256": "<materialized-tree-sha256>"
  },
  "sysroot": {
    "path": "sysroot", "revision": "<fixed-revision>",
    "source_url": "https://<approved-host>/<fixed-source>",
    "source_sha256": "<original-source-archive-sha256>", "tree_sha256": "<materialized-tree-sha256>"
  },
  "tools": {
    "cmake": {"path": "host/bin/cmake", "sha256": "<sha256>", "version_line": "<exact --version first line>"},
    "ninja": {"path": "host/bin/ninja", "sha256": "<sha256>", "version_line": "<exact --version first line>"},
    "file": {"path": "host/bin/file", "sha256": "<sha256>", "version_line": "<exact --version first line>"},
    "cc": {"path": "toolchain/bin/aarch64-gcc", "sha256": "<sha256>", "version_line": "<exact first line>", "target_triple": "<exact aarch64 Linux GNU triple>"},
    "cxx": {"path": "toolchain/bin/aarch64-g++", "sha256": "<sha256>", "version_line": "<exact first line>", "target_triple": "<same verified triple>"},
    "nm": {"path": "toolchain/bin/aarch64-nm", "sha256": "<sha256>", "version_line": "<exact first line>"},
    "readelf": {"path": "toolchain/bin/aarch64-readelf", "sha256": "<sha256>", "version_line": "<exact first line>"},
    "host_cc": {"path": "host/bin/gcc", "sha256": "<sha256>", "version_line": "<exact first line>", "target_triple": "<exact x86_64 Linux GNU triple>"},
    "host_cxx": {"path": "host/bin/g++", "sha256": "<sha256>", "version_line": "<exact first line>", "target_triple": "<same verified host triple>"}
  },
  "ctest": {"path": "host/bin/ctest", "sha256": "<sha256>"},
  "curl_include": "sysroot/usr/include",
  "curl_library": {"path": "sysroot/usr/lib/libcurl.so.4", "sha256": "<sha256>"},
  "host_curl_include": "host/include",
  "host_curl_library": {"path": "host/lib/libcurl.so", "sha256": "<sha256>"},
  "target_libraries": [
    {"path": "sysroot/usr/lib/libcurl.so.4", "sha256": "<sha256>", "soname": "libcurl.so.4"},
    {"path": "sysroot/lib/libc.so.6", "sha256": "<sha256>", "soname": "libc.so.6"}
  ],
  "falcon_host_libraries": [
    {"path": "evidence/falcon-runtime", "sha256": "<sha256>", "approved_symbols": ["<exact SDK-and-runtime-verified export>"]}
  ]
}
```

`target_libraries` 必须补齐模块每项 DT_NEEDED 的真实目标 ELF，包括实际所需 libstdc++/libgcc/loader 等，不是照抄示例两个条目。Falcon provider 可为实际宿主 executable 或 shared object，但 approved_symbols 只能为经 SDK 和该 runtime 同时核实的精确导出子集。需要包含版本后缀时使用 `name@VERSION`；无正则、前缀豁免、弱符号豁免或版本上限猜测。若缺少可选弱符号也会保守失败，应提交单独可审查的证据和设计变更，而非加入通配放行。

所有路径相对 bundle 根，不能含空格/控制字符或逃逸。`tree_sha256` 计算方式：遍历组件目录所有普通文件，按相对 POSIX 路径排序，对每项 UTF-8 `"<file sha256>  <relative/path>\n"` 的拼接计算 SHA-256；空目录和文件 mode 不计入，归档总 SHA 仍覆盖 mode。可直接导入 `tools/native-ci.py` 的 `tree_sha()` 做纯文件哈希，无需 configure。source_sha256 是原始来源内容哈希，tree_sha256 是实际物化内容哈希，两者不得混用。根 manifest SHA 位于策略中，避免 bundle 自证授权。

bundle 是**已信任的可执行供应链**，SHA 只证明内容固定，不证明来源诚实、SDK 许可或 sandbox 安全。下载后会执行其工具；必须先人工验证版权、来源、宿主工具安全、目标库与该固件的证据关系。不给此任务敏感凭据。工具进程仅继承最小 PATH/locale/临时 HOME，不继承 key、编译器注入变量或动态库注入变量；仍不能视为恶意编译器沙箱。

## CI 顺序与产物

1. 纯 Python 合同测试；策略 / repo / visibility / ref / source scope / bundle 输入匹配。
2. SHA 验证、安全下载与解包，逐组件内容树、工具路径/SHA/版本/target triple 核验。
3. 单独宿主 build 目录，插件 OFF、core tests ON；编译后仅 CI runner 本机 CTest 运行 loopback 合成测试。禁止执行 AArch64 测试或下载目标程序运行。
4. 生成显式 AArch64 CMake toolchain，固定 sysroot、GNU 编译器、nm/readelf、ONLY target include/library/package 查找；插件 ON、tests OFF。
5. `file`, `readelf -h/-l/-d/--version-info`, `nm -D`：ELF64 little-endian AArch64 DYN，入口 `custom_init_jsapis`，依赖 libcurl.so.4，无 PT_INTERP/RPATH/RUNPATH/TEXTREL。每项 DT_NEEDED 必须有 SHA+SONAME 匹配的目标 provider；导入符号（含 GLIBC/GLIBCXX/CXXABI/GCC 版本）只能由 **实际 DT_NEEDED 库**或批准的精确 Falcon host 子集提供。不以“GLIBC_2.17+”推定兼容。
6. 审核成功后复制 `.so`，复核 SHA，固定六文件 staging。SHA256SUMS 覆盖另外五个文件（不自含）；7 天 retention，不上传失败构建。

`build.log` 只记录阶段名和成功 exit code；原始 configure/编译/测试/ELF 工具 stdout/stderr 不打印、不落盘、不上传，避免编译器引用源码或环境泄密。失败只给稳定错误类别，需人工使用合成数据复现诊断。链接命令单独保存，只替换 `<SOURCE>` / `<CI_WORK>` 前缀；其余内容为已批准工具和固定参数。artifact manifest 仅发布白名单来源 revision/哈希、工具身份，不复制 bundle 任意额外 metadata。

即使将来 CI 通过，也仅说明所提供证据库满足静态符号检查，不能证明运行时 namespace、间接依赖闭包、TLS/CA、Falcon 线程 API、加载和功能兼容。还须逐 profile 真机加载、错误/取消/销毁/TLS 测试。AMR 打包前和解包后再次复核 `.so` SHA 与 CI manifest 一致；本 workflow 不生成 AMR，也不声称完成该检查。

## 允许本机执行的纯脚本检查

从项目目录运行（不安装依赖、不涉及 C/C++）：

```sh
python -B -m unittest discover -s tools/tests -p test_native_ci.py -v
```

这些测试使用合成归档、mock 工具输出与假授权 fixture，不发网络、不 configure、不运行 native 测试，不替代真实 Actions 构建验证。同一命令也在 `native-compile.yml` 的 `native` job 中执行，结果随 artifact 保存。

真正的目标产物路径（`native-manual.yml`）仍保持未启用状态：其脚本会调用获批 bundle 中的 CMake/编译器/CTest，而当前**没有**获批 bundle。不要在本地用任何其它方式补做该构建。
