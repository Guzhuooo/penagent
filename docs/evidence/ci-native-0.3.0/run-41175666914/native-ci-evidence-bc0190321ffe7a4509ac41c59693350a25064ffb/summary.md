# Native compile workflow (host-only; NOT device evidence)

- commit: `bc0190321ffe7a4509ac41c59693350a25064ffb`
- run: https://github.com/Guzhuooo/penagent/actions/runs/41175666914
- trigger: workflow_dispatch
- host build: HTTPX_BUILD_PLUGIN=OFF, HTTPX_BUILD_TESTS=ON, Release, runner g++
- CTest: real loopback transport tests ran on the runner
- AArch64: compile-only smoke with `aarch64-linux-gnu-g++`; objects verified as ELF64/AArch64; nothing was linked or executed
- no .so, no AMR, no device-ABI/TLS claim from this run

## Host CTest tail
```
Internal ctest changing into directory: /home/runner/work/penagent/penagent/build-host
Test project /home/runner/work/penagent/penagent/build-host
    Start 1: httpx_core
1/1 Test #1: httpx_core .......................   Passed    1.64 sec

100% tests passed, 0 tests failed out of 1

Total Test time (real) =   1.71 sec
```

## AArch64 object verification
```
## build-cross/httpx_core.o
build-cross/httpx_core.o: ELF 64-bit LSB relocatable, ARM aarch64, version 1 (GNU/Linux), not stripped
  Class:                             ELF64
  Data:                              2's complement, little endian
  OS/ABI:                            UNIX - GNU
  Type:                              REL (Relocatable file)
  Machine:                           AArch64
## build-cross/httpx_core_tests.o
build-cross/httpx_core_tests.o: ELF 64-bit LSB relocatable, ARM aarch64, version 1 (GNU/Linux), not stripped
  Class:                             ELF64
  Data:                              2's complement, little endian
  OS/ABI:                            UNIX - GNU
  Type:                              REL (Relocatable file)
  Machine:                           AArch64
```
