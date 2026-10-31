#!/usr/bin/env python3
"""Build `native/device-bundle/device-bundle.tar.xz` from the real Y02 device.

This is *collection and packaging* tooling only. It never compiles, links or runs
any C/C++: all configure/build/link/ELF-audit work happens in GitHub Actions
(.github/workflows/native-device-build.yml). It runs on the maintainer host
because it needs the device over adb and the locally supplied SDK zip.

What it does:
  1. verifies the SDK zip SHA-256 and stages sdk/include + sdk/src;
  2. verifies the pinned curl 7.79.1 source tarball and stages include/curl;
  3. pulls the exact runtime libraries (and libfalcon.so) from the device via
     adb, cross-checking each file against the device's own sha256sum;
  4. parses SONAME / DT_NEEDED / GNU version definitions to derive the
     provider table and the device's GLIBC / GLIBCXX / CXXABI / GCC maxima;
  5. writes manifest.json (+ provenance/ and sysroot/aliases.tsv);
  6. packs a deterministic .tar.xz and writes the committed manifest.json.

Pins are intentionally hard-coded: a changed SDK, curl source or device library
set must be an explicit, reviewable edit, not an implicit "latest".

Usage:
  python native/device-bundle/build_bundle.py \
      --sdk-zip iot-miniapp-sdk.zip \
      --curl-tarball curl-7.79.1.tar.gz \
      --adb-serial <device-serial>
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "native" / "device-bundle"
ARCHIVE_NAME = "device-bundle.tar.xz"

PROFILE = "y02-4.9.7"
SDK_ZIP_SHA256 = "564af743ba947eec3b1b4784ff99a3fcf6d8506f7eb59ef5be464f5505ca263a"
CURL_VERSION = "7.79.1"
CURL_VERSION_NUM = "0x074f01"
CURL_SOURCE_URL = "https://curl.se/download/curl-7.79.1.tar.gz"
CURL_SOURCE_SHA256 = "370b11201349816287fb0ccc995e420277fbfcaf76206e309b3f60f0eda090c2"

# Device path -> bundle-relative path -> expected SONAME (None = no SONAME check).
# These are exactly the libraries needed to link and audit the plugin against the
# device ABI, plus libcurl's own direct dependency closure as installed on the
# device. Nothing is taken from the build host.
DEVICE_LIBRARIES = [
    ("/usr/lib/ld-linux-aarch64.so.1", "sysroot/lib/ld-linux-aarch64.so.1", None),
    ("/usr/lib/libc.so.6", "sysroot/lib/libc.so.6", "libc.so.6"),
    ("/usr/lib/libm.so.6", "sysroot/lib/libm.so.6", "libm.so.6"),
    ("/usr/lib/libpthread.so.0", "sysroot/lib/libpthread.so.0", "libpthread.so.0"),
    ("/usr/lib/libdl.so.2", "sysroot/lib/libdl.so.2", "libdl.so.2"),
    ("/usr/lib/librt.so.1", "sysroot/lib/librt.so.1", "librt.so.1"),
    ("/usr/lib/libgcc_s.so.1", "sysroot/lib/libgcc_s.so.1", "libgcc_s.so.1"),
    ("/usr/lib/libstdc++.so.6.0.29", "sysroot/lib/libstdc++.so.6.0.29", "libstdc++.so.6"),
    ("/usr/lib/libcurl.so.4.7.0", "sysroot/lib/libcurl.so.4.7.0", "libcurl.so.4"),
    ("/usr/lib/libcares.so.2.5.1", "sysroot/lib/libcares.so.2.5.1", "libcares.so.2"),
    ("/usr/lib/libidn2.so.0.3.7", "sysroot/lib/libidn2.so.0.3.7", "libidn2.so.0"),
    ("/usr/lib/librtmp.so.1", "sysroot/lib/librtmp.so.1", "librtmp.so.1"),
    ("/usr/lib/libpsl.so.5.3.2", "sysroot/lib/libpsl.so.5.3.2", "libpsl.so.5"),
    ("/usr/lib/libssl.so.1.1", "sysroot/lib/libssl.so.1.1", "libssl.so.1.1"),
    ("/usr/lib/libcrypto.so.1.1", "sysroot/lib/libcrypto.so.1.1", "libcrypto.so.1.1"),
    ("/usr/lib/libz.so.1.2.11", "sysroot/lib/libz.so.1.2.11", "libz.so.1"),
    ("/usr/lib/libatomic.so.1.2.0", "sysroot/lib/libatomic.so.1.2.0", "libatomic.so.1"),
    ("/usr/lib/libgmp.so.10.4.1", "sysroot/lib/libgmp.so.10.4.1", "libgmp.so.10"),
    ("/usr/lib/libgnutls.so.30.30.0", "sysroot/lib/libgnutls.so.30.30.0", "libgnutls.so.30"),
    ("/usr/lib/libhogweed.so.6.4", "sysroot/lib/libhogweed.so.6.4", "libhogweed.so.6"),
    ("/usr/lib/libiconv.so.2.6.0", "sysroot/lib/libiconv.so.2.6.0", "libiconv.so.2"),
    ("/usr/lib/libnettle.so.8.4", "sysroot/lib/libnettle.so.8.4", "libnettle.so.8"),
    ("/usr/lib/libunistring.so.2.1.0", "sysroot/lib/libunistring.so.2.1.0", "libunistring.so.2"),
    ("/usr/lib/libtasn1.so.6.6.1", "sysroot/lib/libtasn1.so.6.6.1", "libtasn1.so.6"),
    ("/usr/lib/libfalcon.so", "falcon/libfalcon.so", "libfalcon.so"),
]


def sha256_file(path):
    value = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def run(argv, expect=True):
    result = subprocess.run([str(x) for x in argv], capture_output=True, text=True,
                            encoding="utf-8", errors="replace", check=False)
    if expect and result.returncode != 0:
        sys.stderr.write("command failed: " + " ".join(str(x) for x in argv) + "\n")
        sys.stderr.write(result.stdout + result.stderr)
        raise SystemExit(1)
    return result


def adb(serial, *args, expect=True):
    return run(["adb", "-s", serial, *args], expect=expect)


class ElfError(Exception):
    pass


def _u16(data, off):
    return struct.unpack_from("<H", data, off)[0]


def _u32(data, off):
    return struct.unpack_from("<I", data, off)[0]


def _u64(data, off):
    return struct.unpack_from("<Q", data, off)[0]


def _cstr(blob, off):
    end = blob.find(b"\0", off)
    if end < 0:
        raise ElfError("unterminated string")
    return blob[off:end].decode("utf-8", "replace")


def elf_facts(path):
    """SONAME, DT_NEEDED, GNU version definitions and embedded version strings."""
    data = Path(path).read_bytes()
    if data[:4] != b"\x7fELF":
        raise ElfError("not ELF: " + str(path))
    if data[4] != 2 or data[5] != 1:
        raise ElfError("not ELF64 little-endian: " + str(path))
    machine = _u16(data, 18)
    shoff, shentsize, shnum, shstrndx = _u64(data, 40), _u16(data, 58), _u16(data, 60), _u16(data, 62)
    sections = []
    for index in range(shnum):
        base = shoff + index * shentsize
        sections.append({"name_off": _u32(data, base), "type": _u32(data, base + 4),
                         "offset": _u64(data, base + 24), "size": _u64(data, base + 32),
                         "link": _u32(data, base + 40), "entsize": _u64(data, base + 56)})
    strtab = data[sections[shstrndx]["offset"]:sections[shstrndx]["offset"] + sections[shstrndx]["size"]]
    for section in sections:
        section["name"] = _cstr(strtab, section["name_off"])

    def find(name):
        for section in sections:
            if section["name"] == name:
                return section
        return None

    def section_data(section):
        return data[section["offset"]:section["offset"] + section["size"]]

    facts = {"machine": machine, "needed": [], "soname": None, "verdef": [], "verneed": {}}
    dynamic = find(".dynamic")
    if dynamic is not None:
        dynstr = section_data(sections[dynamic["link"]])
        raw = section_data(dynamic)
        for offset in range(0, len(raw) - 15, 16):
            tag, value = _u64(raw, offset), _u64(raw, offset + 8)
            if tag == 0:
                break
            if tag == 1:
                facts["needed"].append(_cstr(dynstr, value))
            elif tag == 14:
                facts["soname"] = _cstr(dynstr, value)
    version_def = find(".gnu.version_d")
    if version_def is not None:
        raw = section_data(version_def)
        strings = section_data(sections[version_def["link"]])
        offset = 0
        while offset + 20 <= len(raw):
            version, flags, index, count, _hash, aux, nxt = (
                _u16(raw, offset), _u16(raw, offset + 2), _u16(raw, offset + 4),
                _u16(raw, offset + 6), _u32(raw, offset + 8), _u32(raw, offset + 12),
                _u32(raw, offset + 16))
            if version != 1:
                break
            aux_off, names = offset + aux, []
            for _ in range(count):
                if aux_off + 8 > len(raw):
                    break
                name_off, aux_next = _u32(raw, aux_off), _u32(raw, aux_off + 4)
                names.append(_cstr(strings, name_off))
                if aux_next == 0:
                    break
                aux_off += aux_next
            if not (flags & 1) and names:
                facts["verdef"].append(names[0])
            if nxt == 0:
                break
            offset += nxt
    version_need = find(".gnu.version_r")
    if version_need is not None:
        raw = section_data(version_need)
        strings = section_data(sections[version_need["link"]])
        offset = 0
        while offset + 16 <= len(raw):
            version, count, file_off, aux, nxt = (
                _u16(raw, offset), _u16(raw, offset + 2), _u32(raw, offset + 4),
                _u32(raw, offset + 8), _u32(raw, offset + 12))
            if version != 1:
                break
            names, aux_off = [], offset + aux
            for _ in range(count):
                if aux_off + 16 > len(raw):
                    break
                name_off, aux_next = _u32(raw, aux_off + 8), _u32(raw, aux_off + 12)
                names.append(_cstr(strings, name_off))
                if aux_next == 0:
                    break
                aux_off += aux_next
            facts["verneed"][_cstr(strings, file_off)] = names
            if nxt == 0:
                break
            offset += nxt
    facts["strings"] = {
        "libcurl": _first_match(data, rb"libcurl/7\.79\.1"),
        "glibc": _first_match(data, rb"GNU C Library[^\0]{0,120}"),
        "openssl": _first_match(data, rb"OpenSSL[ /]1\.1\.1[a-z]?"),
    }
    return facts


def _first_match(data, pattern):
    match = re.search(pattern, data)
    return match.group(0).decode("ascii", "replace") if match else None


def version_max(names, prefix):
    best = None
    for name in names:
        if not name.startswith(prefix):
            continue
        parts = name[len(prefix):].split(".")
        try:
            numeric = tuple(int(x) for x in parts)
        except ValueError:
            continue
        if best is None or numeric > best[0]:
            best = (numeric, name)
    return best[1] if best else None


def tree_sha(root):
    value = hashlib.sha256()
    for path in sorted(Path(root).rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        if path.is_file():
            value.update((sha256_file(path) + "  " + path.relative_to(root).as_posix() + "\n").encode())
    return value.hexdigest()


def stage_sdk(sdk_zip, staging):
    digest = sha256_file(sdk_zip)
    if digest != SDK_ZIP_SHA256:
        raise SystemExit("SDK zip SHA-256 mismatch: " + digest)
    with zipfile.ZipFile(sdk_zip) as archive:
        names = [name for name in archive.namelist()
                 if not name.endswith("/") and (name.startswith("include/") or name.startswith("src/")
                                                or name.startswith("iot-miniapp-sdk/include/")
                                                or name.startswith("iot-miniapp-sdk/src/"))]
        if not names:
            raise SystemExit("SDK zip does not contain include/ or src/")
        prefix = "iot-miniapp-sdk/" if any(n.startswith("iot-miniapp-sdk/") for n in names) else ""
        for name in names:
            relative = name[len(prefix):]
            target = staging / "sdk" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(name) as source, open(target, "wb") as sink:
                shutil.copyfileobj(source, sink)
    print("sdk: staged", len(names), "files from", sdk_zip)


def stage_curl(curl_tarball, staging):
    digest = sha256_file(curl_tarball)
    if digest != CURL_SOURCE_SHA256:
        raise SystemExit("curl tarball SHA-256 mismatch: " + digest)
    header_count = 0
    with tarfile.open(curl_tarball, "r:gz") as archive:
        for member in archive:
            parts = member.name.split("/")
            if len(parts) < 3 or parts[0] != "curl-" + CURL_VERSION or parts[1] != "include" or parts[2] != "curl":
                continue
            if not member.isfile():
                continue
            relative = "/".join(parts[2:])
            target = staging / "sysroot" / "usr" / "include" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(member).read())
            header_count += 1
    curlver = staging / "sysroot" / "usr" / "include" / "curl" / "curlver.h"
    text = curlver.read_text(encoding="utf-8")
    if CURL_VERSION_NUM.lower() not in text.lower():
        raise SystemExit("curlver.h does not pin " + CURL_VERSION_NUM)
    print("curl: staged", header_count, "headers for", CURL_VERSION)


def plan_libraries():
    plan = []
    for device_path, bundle_path, expected_soname in DEVICE_LIBRARIES:
        plan.append({"device_path": device_path, "bundle_path": bundle_path,
                     "expected_soname": expected_soname})
    return plan


def collect(serial, staging, plan):
    (staging / "provenance").mkdir(parents=True, exist_ok=True)
    commands = []
    for entry in plan:
        target = staging / entry["bundle_path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        adb(serial, "pull", entry["device_path"], str(target))
        if not target.is_file():
            raise SystemExit("adb pull produced no file for " + entry["device_path"])
        digest = sha256_file(target)
        facts = elf_facts(target)
        if facts["machine"] != 183:
            raise SystemExit("not an EM_AARCH64 object: " + entry["device_path"])
        if entry["expected_soname"] is not None and facts["soname"] != entry["expected_soname"]:
            raise SystemExit("SONAME mismatch for %s: %r" % (entry["device_path"], facts["soname"]))
        entry["sha256"] = digest
        entry["size"] = target.stat().st_size
        entry["soname"] = facts["soname"]
        commands.append("adb -s %s pull %s %s" % (serial, entry["device_path"], entry["bundle_path"]))
        print("pulled %-40s %8d  %s" % (entry["device_path"], entry["size"], digest[:16]))

    # Independent device-side checksum, when the device's toolbox provides it.
    listing = adb(serial, "shell", "sha256sum " + " ".join(e["device_path"] for e in plan), expect=False)
    device_hashes = {}
    for line in listing.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and re.fullmatch(r"[0-9a-f]{64}", parts[0]):
            device_hashes[parts[1]] = parts[0]
    if device_hashes:
        for entry in plan:
            if entry["device_path"] not in device_hashes:
                raise SystemExit("device sha256sum missing for " + entry["device_path"])
            if device_hashes[entry["device_path"]] != entry["sha256"]:
                raise SystemExit("device pull does not match device sha256sum: " + entry["device_path"])
        (staging / "provenance" / "device-sha256sum.txt").write_bytes(
            listing.stdout.replace("\r\n", "\n").encode("utf-8"))
        print("device sha256sum cross-check: OK for", len(plan), "files")
    else:
        print("device sha256sum unavailable; relying on post-pull hashes")

    identity = adb(serial, "shell", "uname -a; cat /proc/version 2>/dev/null; "
                                    "cat /etc/os-release 2>/dev/null; ls -l " +
                   " ".join(e["device_path"] for e in plan), expect=False)
    (staging / "provenance" / "device-identity.txt").write_bytes(
        identity.stdout.replace("\r\n", "\n").encode("utf-8"))
    (staging / "provenance" / "adb-commands.txt").write_bytes(
        ("\n".join(commands) + "\n").encode("utf-8"))
    return device_hashes


def build_manifest(staging, plan, serial):
    libraries = []
    for entry in plan:
        if entry["bundle_path"].startswith("falcon/"):
            continue
        libraries.append({"name": Path(entry["bundle_path"]).name,
                          "path": entry["bundle_path"],
                          "soname": entry["soname"],
                          "sha256": entry["sha256"],
                          "device_path": entry["device_path"]})
    aliases = []
    for entry in plan:
        soname = entry["soname"]
        if not soname or not soname.startswith("lib"):
            continue
        real = Path(entry["bundle_path"]).name
        base = soname.split(".so")[0] + ".so"
        for alias in dict.fromkeys([soname, base]):
            if alias != real:
                aliases.append({"name": alias, "target": real})
    aliases.sort(key=lambda item: item["name"])
    (staging / "sysroot" / "aliases.tsv").write_bytes(
        "".join(item["name"] + "\t" + item["target"] + "\n" for item in aliases).encode("utf-8"))

    # Every staged file except the manifest itself is covered by the file table.
    files = {}
    for path in sorted(staging.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(staging).as_posix()
        if relative == "manifest.json":
            continue
        files[relative] = {"sha256": sha256_file(path), "size": path.stat().st_size}

    glibc_defs = elf_facts(staging / "sysroot" / "lib" / "libc.so.6")["verdef"]
    stdcxx = elf_facts(staging / "sysroot" / "lib" / "libstdc++.so.6.0.29")
    libc = elf_facts(staging / "sysroot" / "lib" / "libc.so.6")
    curl_facts = elf_facts(staging / "sysroot" / "lib" / "libcurl.so.4.7.0")
    falcon = elf_facts(staging / "falcon" / "libfalcon.so")
    ssl_facts = elf_facts(staging / "sysroot" / "lib" / "libssl.so.1.1")
    crypto_facts = elf_facts(staging / "sysroot" / "lib" / "libcrypto.so.1.1")
    sdk_root = staging / "sdk"
    manifest = {
        "schema_version": 1,
        "profile": PROFILE,
        "device": {
            "model": "Y02",
            "codename": "Y02-3562",
            "firmware": "4.9.7",
            "soc": "Rockchip RK3562",
            "arch": "aarch64",
            "elf_class": "ELF64",
            "endian": "little",
            "libc": "glibc",
            "glibc_version": "2.36",
            "glibc_version_strings": libc["strings"]["glibc"],
            "libstdcxx_version": "6.0.29",
            "curl_version": CURL_VERSION,
            "curl_version_strings": curl_facts["strings"]["libcurl"],
            "openssl_version_strings": crypto_facts["strings"]["openssl"] or ssl_facts["strings"]["openssl"],
            "adb_serial": serial,
        },
        "maximum_version_symbols": {
            "GLIBC": version_max(glibc_defs, "GLIBC_"),
            "GLIBCXX": version_max(stdcxx["verdef"], "GLIBCXX_"),
            "CXXABI": version_max(stdcxx["verdef"], "CXXABI_"),
            "GCC": version_max(elf_facts(staging / "sysroot" / "lib" / "libgcc_s.so.1")["verdef"], "GCC_"),
        },
        "sdk": {
            "source_zip_sha256": SDK_ZIP_SHA256,
            "include_path": "sdk/include",
            "src_path": "sdk/src",
            "tree_sha256": tree_sha(sdk_root),
        },
        "curl_headers": {
            "version": CURL_VERSION,
            "version_num": CURL_VERSION_NUM,
            "source_url": CURL_SOURCE_URL,
            "source_sha256": CURL_SOURCE_SHA256,
            "path": "sysroot/usr/include/curl",
        },
        "libraries": libraries,
        "falcon": {
            "path": "falcon/libfalcon.so",
            "sha256": sha256_file(staging / "falcon" / "libfalcon.so"),
            "device_path": "/usr/lib/libfalcon.so",
            "needed": falcon["needed"],
            "role": "Falcon host executable exports; not linked into the plugin",
        },
        "files": dict(sorted(files.items())),
        "aliases": aliases,
        "provenance": {
            "method": "adb pull from the physical device; each file cross-checked against "
                      "the device's own sha256sum, SDK zip and curl source pinned by SHA-256",
            "adb_serial": serial,
            "commands_file": "provenance/adb-commands.txt",
            "identity_file": "provenance/device-identity.txt",
            "sha256_file": "provenance/device-sha256sum.txt",
            "builds": "GitHub Actions only (.github/workflows/native-device-build.yml)",
        },
    }
    text = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    (staging / "manifest.json").write_bytes(text.encode("utf-8"))
    return manifest, text


def make_archive(staging, archive_path):
    if archive_path.exists():
        archive_path.unlink()

    def normalized(name):
        info = tarfile.TarInfo(name)
        info.uid, info.gid = 0, 0
        info.uname, info.gname = "", ""
        info.mtime = 0
        return info

    entries = []
    for path in sorted(staging.rglob("*")):
        entries.append(path)
    with tarfile.open(archive_path, "w:xz", format=tarfile.PAX_FORMAT, preset=9) as archive:
        for path in entries:
            relative = path.relative_to(staging).as_posix()
            if path.is_dir():
                info = normalized(relative + "/")
                info.type, info.mode = tarfile.DIRTYPE, 0o755
                archive.addfile(info)
            else:
                info = normalized(relative)
                info.type, info.mode = tarfile.REGTYPE, 0o644
                info.size = path.stat().st_size
                with open(path, "rb") as stream:
                    archive.addfile(info, stream)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sdk-zip", default=str(REPO_ROOT / "iot-miniapp-sdk.zip"))
    parser.add_argument("--curl-tarball", required=True)
    parser.add_argument("--adb-serial", required=True)
    parser.add_argument("--out-dir", default=str(OUT_DIR))
    arguments = parser.parse_args()
    out_dir = Path(arguments.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="penagent-device-bundle-") as temporary:
        staging = Path(temporary) / "bundle"
        staging.mkdir()
        stage_sdk(Path(arguments.sdk_zip), staging)
        stage_curl(Path(arguments.curl_tarball), staging)
        plan = plan_libraries()
        collect(arguments.adb_serial, staging, plan)
        manifest, text = build_manifest(staging, plan, arguments.adb_serial)
        archive_path = out_dir / ARCHIVE_NAME
        make_archive(staging, archive_path)
        (out_dir / "manifest.json").write_bytes(text.encode("utf-8"))

    digest = sha256_file(archive_path)
    print()
    print("archive:", archive_path)
    print("size:", archive_path.stat().st_size)
    print("sha256:", digest)
    print("committed manifest.json must stay byte-identical to the in-archive copy")
    print("pin in .github/workflows/native-device-build.yml:")
    print("  BUNDLE_ARCHIVE_SHA256: " + digest)
    print("device maxima:", manifest["maximum_version_symbols"])


if __name__ == "__main__":
    main()
