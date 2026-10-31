#!/usr/bin/env python3
"""Fail-closed ELF/Audit checks for the device plugin built in GitHub Actions.

This script runs on the GitHub-hosted runner (host Python + host GNU readelf) after
the container build; it never compiles anything. It verifies:

  1. the extracted device bundle matches its manifest.json (every file SHA-256,
     SDK tree hash, curl 7.79.1 header pin, alias targets);
  2. the artifact is ELF64/little-endian/AArch64 DYN with no PT_INTERP,
     RPATH/RUNPATH or TEXTREL;
  3. every DT_NEEDED entry has a device provider library in the bundle whose
     SHA-256 and SONAME match the manifest;
  4. every required GLIBC/GLIBCXX/CXXABI/GCC version symbol is actually defined
     by those providers and is not newer than the recorded device maxima;
  5. the module keeps its `custom_init_jsapis` entry point and libcurl.so.4
     dependency (three-name contract: libjsapi_httpx.so / loader httpx / import httpx).

A mismatch anywhere is a hard failure. Success is a static, bundle-scoped
result only: it does NOT prove device loading, TLS trust, cancellation or runtime
compatibility.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

VERSION_FAMILIES = ("GLIBC_", "GLIBCXX_", "CXXABI_", "GCC_")


def fail(message):
    print("AUDIT FAILED: " + message, file=sys.stderr)
    raise SystemExit(1)


def sha256_file(path):
    value = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def tree_sha(root):
    value = hashlib.sha256()
    for path in sorted(Path(root).rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        if path.is_file():
            value.update((sha256_file(path) + "  " + path.relative_to(root).as_posix() + "\n").encode())
    return value.hexdigest()


class Readelf:
    def __init__(self):
        self.binary = shutil.which("readelf")
        if not self.binary:
            fail("host readelf is not available")

    def run(self, *arguments):
        result = subprocess.run([self.binary, "-W", *arguments], capture_output=True, text=True,
                                encoding="utf-8", errors="replace", check=False)
        if result.returncode != 0:
            fail("readelf %s failed: %s" % (" ".join(arguments), result.stderr.strip()))
        return result.stdout


def verify_bundle(bundle, report):
    manifest_path = bundle / "manifest.json"
    if not manifest_path.is_file():
        fail("bundle manifest.json missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    report["bundle"] = {"manifest_sha256": sha256_file(manifest_path),
                        "profile": manifest.get("profile")}
    for relative, record in sorted(manifest["files"].items()):
        path = bundle / relative
        if not path.is_file():
            fail("bundle file missing: " + relative)
        digest = sha256_file(path)
        if digest != record["sha256"]:
            fail("bundle file SHA-256 mismatch: " + relative)
    sdk_tree = manifest["sdk"]["tree_sha256"]
    if tree_sha(bundle / "sdk") != sdk_tree:
        fail("bundle SDK tree hash mismatch")
    curlver = (bundle / "sysroot/usr/include/curl/curlver.h").read_text(encoding="utf-8")
    if manifest["curl_headers"]["version_num"].lower() not in curlver.lower():
        fail("bundle curl headers are not pinned to " + manifest["curl_headers"]["version_num"])
    for alias in manifest["aliases"]:
        if not (bundle / "sysroot/lib" / alias["target"]).is_file():
            fail("bundle alias target missing: " + alias["target"])
    report["bundle"]["verified_files"] = len(manifest["files"])
    return manifest


def parse_needed(text):
    return re.findall(r"\(NEEDED\).*?\[([^\]]+)\]", text)


def parse_soname(text):
    match = re.search(r"\(SONAME\).*?\[([^\]]+)\]", text)
    return match.group(1) if match else None


def version_definitions(text):
    """Defined version names from a `readelf --version-info` definition section."""
    names = []
    in_definitions = False
    for line in text.splitlines():
        if "Version definition section" in line:
            in_definitions = True
            continue
        if "Version needs section" in line or "Version symbols section" in line:
            in_definitions = False
            continue
        if in_definitions:
            match = re.search(r"Name: (\S+)", line)
            if match:
                names.append(match.group(1))
    return names


def version_requirements(text):
    """Required version names per needed file from `readelf --version-info`."""
    requirements = {}
    current = None
    in_needs = False
    for line in text.splitlines():
        if "Version needs section" in line:
            in_needs = True
            continue
        if "Version definition section" in line or "Version symbols section" in line:
            in_needs = False
            continue
        if not in_needs:
            continue
        file_match = re.search(r"File: (\S+)", line)
        if file_match:
            current = file_match.group(1)
            requirements.setdefault(current, [])
            continue
        name_match = re.search(r"Name: (\S+)", line)
        if name_match and current is not None:
            requirements[current].append(name_match.group(1))
    return requirements


def numeric(version):
    suffix = version.split("_", 1)[1] if "_" in version else version
    return tuple(int(part) for part in suffix.split(".") if part.isdigit())


def dynamic_symbols(text):
    defined, undefined = [], []
    for line in text.splitlines():
        match = re.match(r"\s*\d+:\s+([0-9a-fA-F]+)\s+\d+\s+(\w+)\s+(\w+)\s+(\S+)\s+(\S+)\s+(.*)$", line)
        if not match:
            continue
        _, _, kind, _, _, name = match.groups()
        match_section = re.search(r"^\s*\d+:\s+[0-9a-fA-F]+\s+\d+\s+\w+\s+\w+\s+([A-Za-z0-9_.]+)", line)
        if kind == "UND":
            undefined.append(name)
        elif kind in ("FUNC", "OBJECT") and match_section:
            defined.append(name)
    return defined, undefined


def audit(manifest, bundle, artifact, report):
    readelf = Readelf()
    if not artifact.is_file():
        fail("artifact missing: " + str(artifact))
    artifact_sha = sha256_file(artifact)
    header = readelf.run("-h", str(artifact))
    if not re.search(r"Class:\s+ELF64", header):
        fail("not ELF64")
    if not re.search(r"Data:.*little endian", header):
        fail("not little-endian")
    if not re.search(r"Machine:\s+AArch64", header):
        fail("not AArch64")
    if not re.search(r"Type:\s+DYN", header):
        fail("not a shared object (DYN)")
    program = readelf.run("-l", str(artifact))
    if re.search(r"\bINTERP\b", program):
        fail("shared library has PT_INTERP")
    dynamic = readelf.run("-d", str(artifact))
    for forbidden in ("(RPATH)", "(RUNPATH)"):
        if forbidden in dynamic:
            fail("forbidden " + forbidden)
    if "(TEXTREL)" in dynamic:
        fail("forbidden TEXTREL")
    needed = parse_needed(dynamic)
    soname = parse_soname(dynamic)
    if "libcurl.so.4" not in needed:
        fail("libcurl.so.4 missing from DT_NEEDED")
    if "libfalcon.so" in needed:
        fail("plugin must not link Falcon host libfalcon.so directly")

    providers = {}
    for library in manifest["libraries"]:
        providers[library["soname"]] = library
    provider_reports = {}
    provided_versions = set()
    for name in needed:
        if name not in providers:
            fail("DT_NEEDED %s has no device provider in the bundle" % name)
        record = providers[name]
        path = bundle / record["path"]
        digest = sha256_file(path)
        if digest != record["sha256"]:
            fail("provider SHA-256 mismatch for " + name)
        provider_dynamic = readelf.run("-d", str(path))
        if parse_soname(provider_dynamic) != name:
            fail("provider SONAME mismatch for " + name)
        provided_versions.update(version_definitions(readelf.run("--version-info", str(path))))
        provider_reports[name] = {"sha256": digest, "device_path": record["device_path"]}

    symbols = readelf.run("--dyn-syms", str(artifact))
    defined, undefined = dynamic_symbols(symbols)
    if "custom_init_jsapis" not in defined:
        fail("custom_init_jsapis entry point is not exported")

    requirements = version_requirements(readelf.run("--version-info", str(artifact)))
    maxima = manifest.get("maximum_version_symbols", {})
    missing, too_new = [], []
    for library, names in sorted(requirements.items()):
        for name in names:
            if name not in provided_versions:
                missing.append("%s@%s" % (name, library))
            for family in VERSION_FAMILIES:
                if name.startswith(family) and maxima.get(family.rstrip("_")):
                    if numeric(name) > numeric(maxima[family.rstrip("_")]):
                        too_new.append("%s > %s" % (name, maxima[family.rstrip("_")]))
    if missing:
        fail("required version symbols are not defined by device providers: " + ", ".join(missing))
    if too_new:
        fail("required version symbols exceed the device maxima: " + ", ".join(too_new))

    falcon_undefined = [name for name in undefined if not name.startswith(("GLIBC_", "GLIBCXX_", "CXXABI_", "GCC_"))
                        and "@" not in name and not name.startswith(("_ITM_", "__gmon", "__cxa_finalize"))]
    report.update({
        "artifact": {
            "path": artifact.name,
            "sha256": artifact_sha,
            "size": artifact.stat().st_size,
            "elf": "ELF64 little-endian AArch64 DYN",
            "soname": soname,
        },
        "needed": needed,
        "providers": provider_reports,
        "version_requirements": requirements,
        "provider_defined_versions": sorted(provided_versions),
        "device_maxima": maxima,
        "entry_point": "custom_init_jsapis (exported)",
        "unresolved_imports": {
            "count": len(undefined),
            "unversioned_sample": sorted(set(falcon_undefined))[:20],
            "note": "unversioned imports are expected Falcon host exports resolved at load time; "
                    "this audit cannot prove they exist on the device runtime",
        },
        "checks": [
            "bundle manifest and file SHA-256 verified",
            "ELF64 little-endian AArch64 DYN",
            "no PT_INTERP / RPATH / RUNPATH / TEXTREL",
            "custom_init_jsapis exported",
            "every DT_NEEDED resolved to a bundle provider with matching SHA-256 and SONAME",
            "required GLIBC/GLIBCXX/CXXABI/GCC <= device maxima and defined by providers",
        ],
        "device_compatibility": "NOT VERIFIED ON DEVICE: not installed into an AMR, not loaded, "
                                "no TLS/cancellation/runtime evidence",
    })
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--artifact", default="")
    parser.add_argument("--out", required=True)
    arguments = parser.parse_args()
    bundle = Path(arguments.bundle).resolve()
    report = {"schema_version": 1, "tool": "native/cmake/audit_device_elf.py"}
    manifest = verify_bundle(bundle, report)
    print("bundle verified: %d files, SDK tree and curl %s pin match" % (
        report["bundle"]["verified_files"], manifest["curl_headers"]["version"]))
    if arguments.artifact:
        report = audit(manifest, bundle, Path(arguments.artifact).resolve(), report)
        print("artifact audited: %s" % report["artifact"]["sha256"])
    Path(arguments.out).write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print("wrote " + arguments.out)


if __name__ == "__main__":
    main()
