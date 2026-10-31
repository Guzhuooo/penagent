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
# CMake's compiler-ABI detection re-runs this toolchain file inside a try_compile
# sub-project, where the parent's -DHTTPX_SYSROOT cache entry is not guaranteed to
# be forwarded. Resolve the sysroot from the cache variable, the environment (set
# by native/cmake/device-build-2018.sh) and finally CMAKE_SYSROOT.
if(DEFINED HTTPX_SYSROOT AND IS_ABSOLUTE "${HTTPX_SYSROOT}")
    set(_httpx_sysroot "${HTTPX_SYSROOT}")
elseif(DEFINED ENV{HTTPX_SYSROOT} AND EXISTS "$ENV{HTTPX_SYSROOT}")
    set(_httpx_sysroot "$ENV{HTTPX_SYSROOT}")
elseif(DEFINED CMAKE_SYSROOT AND IS_ABSOLUTE "${CMAKE_SYSROOT}")
    set(_httpx_sysroot "${CMAKE_SYSROOT}")
else()
    message(FATAL_ERROR "Pass an absolute -DHTTPX_SYSROOT=<merged device sysroot> (or set HTTPX_SYSROOT in the environment) with this toolchain file")
endif()
if(NOT IS_DIRECTORY "${_httpx_sysroot}")
    message(FATAL_ERROR "HTTPX_SYSROOT is not a directory: ${_httpx_sysroot}")
endif()

set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR aarch64)
set(CMAKE_SYSROOT "${_httpx_sysroot}")
set(CMAKE_C_COMPILER aarch64-linux-gnu-gcc)
set(CMAKE_CXX_COMPILER aarch64-linux-gnu-g++)
set(CMAKE_NM aarch64-linux-gnu-nm)
set(CMAKE_READELF aarch64-linux-gnu-readelf)
set(CMAKE_AR aarch64-linux-gnu-ar)
set(CMAKE_RANLIB aarch64-linux-gnu-ranlib)
set(CMAKE_STRIP aarch64-linux-gnu-strip)
set(CMAKE_FIND_ROOT_PATH "${_httpx_sysroot}")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
# Compiler-identity checks must not require a complete target runtime; the real
# link is performed (and audited) later with the device provider libraries.
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
