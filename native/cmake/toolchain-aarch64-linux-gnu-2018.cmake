# 2018-era AArch64 cross toolchain for the Falcon Y02 device build.
#
# Intended environment: a pinned Ubuntu 18.04 container (see
# .github/workflows/native-device-build.yml), whose `g++-aarch64-linux-gnu` is
# GCC 7.5.0 (2018-era GNU toolchain, glibc 2.27 headers). The binary is linked
# against the *device* runtime libraries from native/device-bundle, so the
# GLIBC/GLIBCXX symbols it requires stay at or below the device maxima.
#
# The sysroot is not a vendor bundle: it is assembled inside the container from
# the toolchain's own dev files plus the device-derived bundle overlay, and is
# passed explicitly as HTTPX_SYSROOT (CMakeLists.txt requires
# CMAKE_SYSROOT == HTTPX_SYSROOT).
#
# This file never compiles anything by itself; all use is inside GitHub Actions.
if(NOT DEFINED HTTPX_SYSROOT OR NOT IS_ABSOLUTE "${HTTPX_SYSROOT}")
    message(FATAL_ERROR "Pass an absolute -DHTTPX_SYSROOT=<merged device sysroot> with this toolchain file")
endif()

set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR aarch64)
set(CMAKE_SYSROOT "${HTTPX_SYSROOT}")
set(CMAKE_C_COMPILER aarch64-linux-gnu-gcc)
set(CMAKE_CXX_COMPILER aarch64-linux-gnu-g++)
set(CMAKE_NM aarch64-linux-gnu-nm)
set(CMAKE_READELF aarch64-linux-gnu-readelf)
set(CMAKE_AR aarch64-linux-gnu-ar)
set(CMAKE_RANLIB aarch64-linux-gnu-ranlib)
set(CMAKE_STRIP aarch64-linux-gnu-strip)
set(CMAKE_FIND_ROOT_PATH "${HTTPX_SYSROOT}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
# Compiler-identity checks must not require a complete target runtime; the real
# link is performed (and audited) later with the device provider libraries.
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
