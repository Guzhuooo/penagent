# Run 41180136061 — native device build with 2 MiB request body

- Run URL: https://github.com/Guzhuooo/penagent/actions/runs/41180136061
- Workflow: `.github/workflows/native-device-build.yml`
- Trigger: push to `main` after `native: raise request body limit to 2 MiB`
- Commit: `9cab02ef4f41b4eafe9b2c409205c251cf241b8c`
- Toolchain: ubuntu:18.04 container, `aarch64-linux-gnu-g++` GCC 7.5.0, binutils 2.30,
  cmake 3.18.4, glibc 2.27 dev headers + device-derived sysroot bundle.
- 结论：job `AArch64 plugin build (2018 toolchain + device bundle)` 全部成功。

## 产物

```text
libjsapi_httpx.so 488,520 bytes
SHA-256 970b6a33bc568016d35291193f181af562963f76bdfe1af34d97022d4d10b4a6
```

与旧版（body cap 128 KiB）产物大小相同但 SHA 不同；本版 body 上限 2 MiB，与 core
request budget 对齐，已打入 0.4.0 AMR 并在 Y02 真机加载测试。

## 静态审计

- ELF64 little-endian AArch64 DYN；SONAME `libjsapi_httpx.so`；
- 无 PT_INTERP / RPATH / RUNPATH / TEXTREL；导出 `custom_init_jsapis`；
- DT_NEEDED：`libcurl.so.4, libstdc++.so.6, libgcc_s.so.1, libc.so.6,
  ld-linux-aarch64.so.1`，每项对应 bundle 设备 provider 的 SHA/SONAME；
- 版本符号需求 ≤ 设备上限：GLIBC_2.17≤2.36、GLIBCXX_3.4.21≤3.4.29、
  CXXABI_1.3.9≤1.3.13、GCC_3.0≤GCC_11.0。

## 边界

该运行只证明静态构建/审计；设备加载、TLS 信任链、取消与 Falcon 线程兼容需另行验证。
本次 0.4.0 已把该 `.so` 打进 AMR，并在真机通过原生 HTTPS GET/POST 与 TLS 拒绝探针，
但完整 OpenAI endpoint 对话仍未用真实凭据验证。
