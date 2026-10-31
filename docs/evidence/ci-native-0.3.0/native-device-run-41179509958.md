# Device build run 41179509958 — reproducible second green build

- Run URL: https://github.com/Guzhuooo/penagent/actions/runs/41179509958
- Run id: `41179509958`（attempt 1）
- Workflow: `.github/workflows/native-device-build.yml`
- Trigger: `push` to `main`
- Commit: `58f5bc9e27da79fcaca9a9bdf531794c3562d9f7`
  （记录首次绿 run 的证据提交本身）
- Runner: GitHub-hosted `ubuntu-24.04`（宿主不编译）
- 结论：job "AArch64 plugin build (2018 toolchain + device bundle)" 全部步骤 success。

## 与首次绿 run 41179283105 的关系

同一份源码 + 同一 bundle + 同一容器/工具链，重建结果**完全一致**：

- `libjsapi_httpx.so`：488,520 bytes，SHA-256
  `22d4e811dd8bb003a86c0c492f04875803637aa8a3f1f3eb1a4aec7544fcf5cd`（与首次绿相同）。
- bundle：`001ec916cd6810e79752c08f72620efecab396a961fa17dcfae798805acf4f81`。
- 容器：`ubuntu@sha256:152dc042452c496007f07ca9127571cb9c29697f42acbfad72324b2bb2e43c98`。
- 工具链：`aarch64-linux-gnu-g++ (Ubuntu/Linaro 7.5.0-3ubuntu1~18.04) 7.5.0`、binutils 2.30、
  cmake 3.18.4、glibc 2.27 dev headers。
- ELF64 little-endian AArch64 DYN；SONAME `libjsapi_httpx.so`；无
  PT_INTERP/RPATH/RUNPATH/TEXTREL；`custom_init_jsapis` 导出；DT_NEEDED
  `libcurl.so.4, libstdc++.so.6, libgcc_s.so.1, libc.so.6, ld-linux-aarch64.so.1`
  均有设备 provider 且 SHA/SONAME 匹配；版本符号 ≤ 设备上限
  （GLIBC ≤ 2.36、GLIBCXX ≤ 3.4.29、CXXABI ≤ 1.3.13、GCC ≤ 11.0）。

两点证据改进（相对首次绿）：workflow 的 summary 现在写明来源设备 `adb`
`<device-serial>`（而不是容器 tag），且这是**仓库内记录**的第二次可复现构建。

## artifact

`native-device-58f5bc9e27da79fcaca9a9bdf531794c3562d9f7/`：
`libjsapi_httpx.so`（仅本地/artifact，`*.so` 不入库）、`build.log`、`elf-report.json`、
`SHA256SUMS`、`toolchain-identity.txt`、`summary.md`。

同一 commit 的 `.github/workflows/native-compile.yml` run
[41179510006](https://github.com/Guzhuooo/penagent/actions/runs/41179510006) 也全绿
（JS 126/126、策略 22/22、CTest 1/1、AArch64 冒烟）。

## 边界

仍未安装进 AMR、未在真机加载；不声称设备加载、TLS 信任链、取消或运行时兼容。
`native-manual.yml` + `ci-policy.json` 保持 `enabled: false`。
