#!/bin/bash
# Runs *inside* the pinned ubuntu:18.04 build container only.
#
# All C/C++ configure/compile/link work happens here, inside GitHub Actions.
# This script must never be executed on a developer workstation: native/CMakeLists.txt
# also refuses to configure outside Actions (GITHUB_ACTIONS guard), and the
# container is where the 2018-era GNU cross toolchain exists.
#
# Inputs (all read-only except $SRC/build-device and $OUT):
#   /work   repo checkout (contains native/, .github/, ...)
#   /bundle extracted native/device-bundle/device-bundle.tar.xz
#   /out    artifact output directory
#
# Output: /out/libjsapi_httpx.so, /out/toolchain-identity.txt, build diagnostics
# on stdout (captured as build.log by the workflow).
set -euo pipefail

SRC="${SRC:-/work}"
BUNDLE="${BUNDLE:-/bundle}"
OUT="${OUT:-/out}"
# Keep the assembled sysroot and build tree outside the mounted repo.
SYSROOT="${SYSROOT:-/tmp/ci-sysroot}"
BUILD_DIR="${BUILD_DIR:-/tmp/build-device}"
# Also exported so CMake try_compile sub-projects can re-resolve the sysroot.
export HTTPX_SYSROOT="$SYSROOT"
TOOLCHAIN_ROOT=/usr/aarch64-linux-gnu
EXPECTED_CURL_NUM="0x074f01"

step() { echo; echo "== device-build-2018: $*"; }

step "install the pinned 2018-era Ubuntu 18.04 GNU cross toolchain"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends \
    g++-aarch64-linux-gnu binutils-aarch64-linux-gnu make ca-certificates python3-pip
# Ubuntu 18.04 ships cmake 3.10; native/CMakeLists.txt requires >= 3.18.
python3 -m pip install --no-cache-dir --disable-pip-version-check "${DEVICE_CMAKE_PYPI:-cmake==3.18.4.post1}"
hash -r

step "record toolchain identity and fail closed on an unsupported toolchain"
mkdir -p "$OUT"
{
    echo "container: ubuntu:18.04 (pinned by digest in the workflow)"
    echo "date_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "cmake: $(cmake --version | head -n 1)"
    echo "make: $(make --version | head -n 1)"
    echo "compiler: $(aarch64-linux-gnu-g++ --version | head -n 1)"
    echo "compiler_triple: $(aarch64-linux-gnu-g++ -dumpmachine)"
    echo "compiler_print_sysroot: $(aarch64-linux-gnu-g++ -print-sysroot)"
    echo "linker: $(aarch64-linux-gnu-ld --version | head -n 1)"
    echo "nm: $(aarch64-linux-gnu-nm --version | head -n 1)"
    echo "readelf: $(aarch64-linux-gnu-readelf --version | head -n 1)"
    dpkg-query -W -f='${Package} ${Version}\n' \
        g++-aarch64-linux-gnu binutils-aarch64-linux-gnu libc6-dev-arm64-cross 2>/dev/null || true
} > "$OUT/toolchain-identity.txt"
cat "$OUT/toolchain-identity.txt"

compiler_version="$(aarch64-linux-gnu-g++ --version | head -n 1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)"
compiler_triple="$(aarch64-linux-gnu-g++ -dumpmachine)"
if [[ "$compiler_triple" != "aarch64-linux-gnu" ]]; then
    echo "FAIL-CLOSED: unexpected compiler triple: $compiler_triple" >&2
    exit 1
fi
if [[ ! "$compiler_version" =~ ^(7|8)\. ]]; then
    echo "FAIL-CLOSED: expected a 2018-era GCC 7/8 cross compiler, got '$compiler_version'" >&2
    exit 1
fi
if ! dpkg-query -W -f='${Version}' libc6-dev-arm64-cross 2>/dev/null | grep -q '^2\.27'; then
    echo "FAIL-CLOSED: expected glibc 2.27 cross headers from Ubuntu 18.04" >&2
    exit 1
fi

step "assemble the device sysroot: toolchain dev files + device bundle overlay"
# The bundle carries only device runtime libraries and curl 7.79.1 headers. The
# linker still needs the toolchain's own crt objects and libc headers, so the
# real sysroot is an explicit union of both. Both layouts below are kept because
# Ubuntu's cross gcc resolves some paths as /usr/... and some as
# /usr/aarch64-linux-gnu/... under --sysroot.
rm -rf "$SYSROOT"
mkdir -p "$SYSROOT/usr/include" "$SYSROOT/usr/lib" "$SYSROOT/lib" \
         "$SYSROOT/usr/lib/aarch64-linux-gnu" "$SYSROOT/lib/aarch64-linux-gnu" \
         "$SYSROOT/usr/aarch64-linux-gnu/include" "$SYSROOT/usr/aarch64-linux-gnu/lib"
cp -a "$TOOLCHAIN_ROOT/include/." "$SYSROOT/usr/include/"
cp -a "$TOOLCHAIN_ROOT/include/." "$SYSROOT/usr/aarch64-linux-gnu/include/"
cp -a "$TOOLCHAIN_ROOT/lib/." "$SYSROOT/usr/lib/aarch64-linux-gnu/"
cp -a "$TOOLCHAIN_ROOT/lib/." "$SYSROOT/lib/aarch64-linux-gnu/"

# Device provider libraries overwrite every colliding libc/libm/... name, so the
# link and the ELF audit resolve against the real device ABI, not host copies.
for directory in "$SYSROOT/lib" "$SYSROOT/usr/lib" \
                 "$SYSROOT/lib/aarch64-linux-gnu" "$SYSROOT/usr/lib/aarch64-linux-gnu"; do
    cp -a "$BUNDLE/sysroot/lib/." "$directory/"
done
cp -a "$BUNDLE/sysroot/usr/include/curl" "$SYSROOT/usr/include/curl"

# Sonames and -l aliases exactly as recorded by build_bundle.py.
while IFS=$'\t' read -r alias target; do
    [[ -z "${alias:-}" ]] && continue
    for directory in "$SYSROOT/lib" "$SYSROOT/usr/lib" \
                     "$SYSROOT/lib/aarch64-linux-gnu" "$SYSROOT/usr/lib/aarch64-linux-gnu"; do
        ln -sf "$target" "$directory/$alias"
    done
done < "$BUNDLE/sysroot/aliases.tsv"

if ! grep -q "LIBCURL_VERSION_NUM $EXPECTED_CURL_NUM" "$SYSROOT/usr/include/curl/curlver.h"; then
    echo "FAIL-CLOSED: bundle curl headers are not pinned to $EXPECTED_CURL_NUM" >&2
    exit 1
fi
for library in libc.so.6 libstdc++.so.6.0.29 libcurl.so.4.7.0 libm.so.6; do
    if [[ ! -e "$SYSROOT/lib/$library" ]]; then
        echo "FAIL-CLOSED: device library missing from sysroot: $library" >&2
        exit 1
    fi
done
echo "sysroot assembled at $SYSROOT"
echo "device libraries overlaid: $(find "$SYSROOT/lib" -maxdepth 1 -type f -name '*.so*' | wc -l)"
echo "curl headers: $(ls "$SYSROOT/usr/include/curl" | wc -l) files"

step "configure the AArch64 plugin (HTTPX_BUILD_PLUGIN=ON, HTTPX_BUILD_TESTS=OFF)"
rm -rf "$BUILD_DIR"
# GITHUB_ACTIONS must be visible to the CMake guard inside native/CMakeLists.txt.
export GITHUB_ACTIONS="${GITHUB_ACTIONS:-true}"
cmake -S "$SRC/native" -B "$BUILD_DIR" \
    -DCMAKE_TOOLCHAIN_FILE="$SRC/native/cmake/toolchain-aarch64-linux-gnu-2018.cmake" \
    -DHTTPX_SYSROOT="$SYSROOT" \
    -DHTTPX_SDK_DIR="$BUNDLE/sdk" \
    -DHTTPX_CURL_INCLUDE_DIR="$SYSROOT/usr/include" \
    -DHTTPX_CURL_LIBRARY="$SYSROOT/lib/libcurl.so.4" \
    -DHTTPX_BUILD_PLUGIN=ON \
    -DHTTPX_BUILD_TESTS=OFF \
    -DCMAKE_BUILD_TYPE=Release

step "build libjsapi_httpx.so (CheckHttpxElf.cmake runs as a post-build gate)"
cmake --build "$BUILD_DIR" --parallel 2

artifact="$BUILD_DIR/libjsapi_httpx.so"
if [[ ! -f "$artifact" ]]; then
    echo "FAIL-CLOSED: expected artifact not produced: $artifact" >&2
    exit 1
fi
cp "$artifact" "$OUT/libjsapi_httpx.so"
echo
echo "artifact sha256: $(sha256sum "$OUT/libjsapi_httpx.so" | cut -d' ' -f1)"
echo "artifact size: $(stat -c%s "$OUT/libjsapi_httpx.so")"
echo "--- readelf -h ---"
aarch64-linux-gnu-readelf -h "$OUT/libjsapi_httpx.so" | grep -E 'Class:|Data:|Machine:|Type:'
echo "--- readelf -d (link-time dependencies) ---"
aarch64-linux-gnu-readelf -d "$OUT/libjsapi_httpx.so" | grep -E 'NEEDED|SONAME|RPATH|RUNPATH|TEXTREL' || true

{
    echo
    echo "sysroot_provenance: device-bundle overlay + Ubuntu 18.04 cross dev files"
    echo "device_libraries_overlaid:"
    find "$SYSROOT/lib" -maxdepth 1 -type f | sort | while read -r file; do
        echo "  $(basename "$file") $(sha256sum "$file" | cut -d' ' -f1)"
    done
    echo "curl_headers: $(sha256sum "$SYSROOT/usr/include/curl/curlver.h" | cut -d' ' -f1) curlver.h"
} >> "$OUT/toolchain-identity.txt"

step "build finished"
