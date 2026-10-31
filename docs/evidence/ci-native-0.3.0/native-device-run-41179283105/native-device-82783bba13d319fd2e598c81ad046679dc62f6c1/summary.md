# Native device build (2018 toolchain + device sysroot)

- commit: `82783bba13d319fd2e598c81ad046679dc62f6c1`
- run: https://github.com/Guzhuooo/penagent/actions/runs/41179283105
- bundle: `001ec916cd6810e79752c08f72620efecab396a961fa17dcfae798805acf4f81` (profile y02-4.9.7, adb ubuntu:18.04)
- toolchain: Ubuntu 18.04 `g++-aarch64-linux-gnu` (GCC 7.5.0), cmake 3.18.4, glibc 2.27 dev headers
- artifact:
```
artifact sha256: 22d4e811dd8bb003a86c0c492f04875803637aa8a3f1f3eb1a4aec7544fcf5cd
artifact size: 488520
22d4e811dd8bb003a86c0c492f04875803637aa8a3f1f3eb1a4aec7544fcf5cd  libjsapi_httpx.so
```
- static audit (elf-report.json):
```
needed: libcurl.so.4, libstdc++.so.6, libgcc_s.so.1, libc.so.6, ld-linux-aarch64.so.1
soname: libjsapi_httpx.so
providers: ld-linux-aarch64.so.1, libc.so.6, libcurl.so.4, libgcc_s.so.1, libstdc++.so.6
device maxima: {'CXXABI': 'CXXABI_1.3.13', 'GCC': 'GCC_11.0', 'GLIBC': 'GLIBC_2.36', 'GLIBCXX': 'GLIBCXX_3.4.29'}
entry point: custom_init_jsapis (exported)
unresolved imports: 174
```
- NOT device evidence: not installed into an AMR, not loaded on the device,
  no TLS / cancellation / Falcon threading / runtime claim.
