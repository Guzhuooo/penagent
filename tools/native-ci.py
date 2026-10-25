#!/usr/bin/env python3
"""Fail-closed native CI driver. Standard library only; never prints raw tool output."""
import argparse
import fnmatch
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tarfile
from urllib.parse import urlsplit

ARTIFACTS = ["libjsapi_httpx.so", "manifest.json", "SHA256SUMS", "build.log",
             "link-command.json", "elf-report.json"]
SHA = re.compile(r"[0-9a-f]{64}\Z")
TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+:/@ -]{0,199}\Z")


class Denied(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Denied(code)


def digest(path):
    value = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def load(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "JSON_DUPLICATE_KEY")
            result[key] = value
        return result
    require(Path(path).stat().st_size <= 4 * 1024 * 1024, "JSON_SIZE")
    return json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=unique)


def safe_relative(value):
    require(isinstance(value, str) and bool(value) and
            re.fullmatch(r"[A-Za-z0-9_./+\-]+", value), "PATH_FORMAT")
    path = PurePosixPath(value)
    require(not path.is_absolute() and not any(x in ("", ".", "..") for x in value.split("/")),
            "PATH_ESCAPE")
    return path


def inside(root, value):
    path = (Path(root) / safe_relative(value)).resolve()
    require(path.is_relative_to(Path(root).resolve()) and path.exists(), "PATH_MISSING_OR_ESCAPE")
    return path


def validate_url(url, sha):
    require(isinstance(sha, str) and SHA.fullmatch(sha), "BUNDLE_SHA_REQUIRED")
    parsed = urlsplit(url)
    require(parsed.scheme == "https" and parsed.hostname and parsed.username is None and
            parsed.password is None and parsed.port in (None, 443) and not parsed.query and
            not parsed.fragment, "BUNDLE_URL_FORMAT")
    require(re.fullmatch(r"[a-z0-9.-]+", parsed.hostname) and
            "." in parsed.hostname and not parsed.hostname.endswith(".") and
            not re.fullmatch(r"[0-9.]+", parsed.hostname), "BUNDLE_HOST_FORMAT")
    # Content-addressed path, not a moving release/tag URL or a signed URL.
    require(parsed.path == "/sha256/" + sha + "/bundle.tar.xz", "BUNDLE_URL_NOT_IMMUTABLE")
    return parsed


def validate_policy(policy, event, url, sha, tracked):
    require(policy.get("schema_version") == 1 and policy.get("enabled") is True,
            "POLICY_DISABLED_PENDING_USER_AUTHORIZATION")
    auth = policy["authorization"]
    repo = event.get("repository", {})
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", auth["repository"] or ""),
            "REPOSITORY_AUTHORIZATION_REQUIRED")
    require(auth["visibility"] in ("public", "private", "internal") and
            repo.get("full_name") == auth["repository"] and
            repo.get("visibility") == auth["visibility"], "REPOSITORY_AUTHORIZATION_MISMATCH")
    require(re.fullmatch(r"refs/heads/[A-Za-z0-9_./-]+", auth["ref"] or "") and
            event.get("ref") == auth["ref"], "REF_NOT_APPROVED")
    require(TOKEN.fullmatch(auth["approval_reference"] or ""), "APPROVAL_REFERENCE_REQUIRED")
    require(auth["artifact_upload_scope"] == ARTIFACTS, "ARTIFACT_SCOPE_NOT_APPROVED")
    scope = auth["source_upload_scope"]
    require(isinstance(scope, list) and scope and tracked, "SOURCE_SCOPE_REQUIRED")
    for pattern in scope:
        require(isinstance(pattern, str), "SOURCE_SCOPE_FORMAT")
        safe_relative(pattern.replace("*", "x"))
        require(pattern not in ("*", "**", "**/*"), "SOURCE_SCOPE_TOO_BROAD")
    require(all(any(fnmatch.fnmatchcase(name, pattern) for pattern in scope) for name in tracked),
            "SOURCE_OUTSIDE_APPROVED_SCOPE")
    bundle = policy["bundle"]
    validate_url(url, sha)
    require(url == bundle["url"] and sha == bundle["sha256"] and
            SHA.fullmatch(bundle["manifest_sha256"] or ""), "BUNDLE_NOT_APPROVED")
    for key, ceiling in (("max_download_bytes", 2**31), ("max_extracted_bytes", 6 * 2**30)):
        require(type(bundle[key]) is int and 0 < bundle[key] <= ceiling, "BUNDLE_LIMIT_INVALID")


def public_addresses(host):
    addresses = sorted({entry[4][0] for entry in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})
    require(addresses and all(ipaddress.ip_address(ip).is_global for ip in addresses),
            "BUNDLE_HOST_NOT_PUBLIC")
    return addresses


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, address):
        super().__init__(host, timeout=60, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        # Connect only to the already checked public address; retain hostname TLS verification.
        raw = socket.create_connection((self.address, 443), timeout=self.timeout)
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)


def download(url, sha, destination, limit):
    parsed = validate_url(url, sha)
    connection = PinnedHTTPS(parsed.hostname, public_addresses(parsed.hostname)[0])
    try:
        connection.request("GET", parsed.path, headers={"Accept": "application/octet-stream"})
        response = connection.getresponse()
        require(response.status == 200, "BUNDLE_HTTP_STATUS_OR_REDIRECT")
        length = response.getheader("Content-Length")
        if length is not None:
            require(length.isdigit() and int(length) <= limit, "BUNDLE_DOWNLOAD_SIZE")
        total = 0
        with open(destination, "xb") as stream:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                require(total <= limit, "BUNDLE_DOWNLOAD_SIZE")
                stream.write(chunk)
    finally:
        connection.close()
    require(digest(destination) == sha, "BUNDLE_SHA_MISMATCH")


def extract(archive, destination, limit):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    total, count, seen = 0, 0, set()
    with tarfile.open(archive, "r:xz") as source:
        for member in source:
            count += 1
            require(count <= 100000, "BUNDLE_MEMBER_LIMIT")
            relative = safe_relative(member.name)
            require(member.name not in seen, "BUNDLE_DUPLICATE_PATH")
            seen.add(member.name)
            # No symlinks, hardlinks, device nodes, sparse files, ownership or setuid restoration.
            require((member.isfile() or member.isdir()) and not member.issparse(), "BUNDLE_MEMBER_TYPE")
            target = destination / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            total += member.size
            require(total <= limit, "BUNDLE_EXTRACTED_SIZE")
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as reader, open(target, "xb") as writer:
                shutil.copyfileobj(reader, writer)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)


def tree_sha(root):
    """SHA256 of sorted UTF-8 'file-sha256  relative/path\\n' records (regular files only)."""
    result = hashlib.sha256()
    for path in sorted(Path(root).rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        require(not path.is_symlink(), "TREE_SYMLINK")
        if path.is_file():
            result.update((digest(path) + "  " + path.relative_to(root).as_posix() + "\n").encode())
    return result.hexdigest()


def command(argv, cwd=None, timeout=900):
    # Deliberately never relay stdout/stderr or exception text: compilers can echo source/secrets.
    # Do not inherit credentials, compiler injection variables, package search paths,
    # LD_PRELOAD/LD_LIBRARY_PATH or user CMake configuration from the runner.
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C",
                   "HOME": os.environ.get("RUNNER_TEMP", "/tmp"), "TMPDIR": "/tmp",
                   "GITHUB_ACTIONS": os.environ.get("GITHUB_ACTIONS", "false")}
    result = subprocess.run([str(x) for x in argv], cwd=cwd, capture_output=True,
                            timeout=timeout, check=False, env=environment)
    require(result.returncode == 0, "TOOL_FAILED")
    require(len(result.stdout) <= 16 * 1024 * 1024, "TOOL_OUTPUT_LIMIT")
    return result.stdout.decode("utf-8", errors="strict")


def checked_file(root, record):
    path = inside(root, record["path"])
    require(path.is_file() and SHA.fullmatch(record["sha256"]) and
            digest(path) == record["sha256"], "FILE_SHA_MISMATCH")
    return path


def validate_manifest(root, manifest):
    require(manifest["schema_version"] == 1, "MANIFEST_SCHEMA")
    require(manifest["profile"] == "y02-4.9.7" and
            manifest["abi"]["machine"] == "AArch64" and manifest["abi"]["class"] == "ELF64" and
            manifest["abi"]["endian"] == "little" and manifest["abi"]["libc"] == "glibc",
            "UNSUPPORTED_PROFILE_ABI")
    for key in ("libc_version", "libstdcxx_version", "curl_version", "tls_version"):
        require(TOKEN.fullmatch(manifest["abi"][key]), "ABI_VERSION_REQUIRED")
    # This source currently binds to this curl header ABI. It is not a compatibility claim.
    require(manifest["abi"]["curl_version"] == "7.79.1", "CURL_SOURCE_CONTRACT")
    for key in ("toolchain", "sdk", "sysroot"):
        record = manifest[key]
        require(TOKEN.fullmatch(record["revision"]), "COMPONENT_REVISION_REQUIRED")
        source = urlsplit(record["source_url"])
        require(source.scheme == "https" and source.hostname and source.username is None and
                source.password is None and not source.query and not source.fragment and
                SHA.fullmatch(record["source_sha256"]), "COMPONENT_SOURCE_SHA_REQUIRED")
        require(SHA.fullmatch(record["tree_sha256"]), "COMPONENT_SHA_REQUIRED")
        path = inside(root, record["path"])
        require(path.is_dir() and tree_sha(path) == record["tree_sha256"], "COMPONENT_TREE_SHA_MISMATCH")
    tools = {}
    for name in ("cmake", "ninja", "file", "cc", "cxx", "nm", "readelf", "host_cc", "host_cxx"):
        record = manifest["tools"][name]
        tools[name] = checked_file(root, record)
        require(isinstance(record["version_line"], str) and 0 < len(record["version_line"]) <= 200,
                "TOOL_VERSION_REQUIRED")
        require(command([tools[name], "--version"]).splitlines()[0] == record["version_line"],
                "TOOL_VERSION_MISMATCH")
    for name in ("cc", "cxx", "host_cc", "host_cxx"):
        triple = manifest["tools"][name]["target_triple"]
        pattern = r"aarch64[A-Za-z0-9_-]*linux[A-Za-z0-9_-]*gnu" if not name.startswith("host") else r"x86_64[A-Za-z0-9_-]*linux[A-Za-z0-9_-]*gnu"
        require(re.fullmatch(pattern, triple) and command([tools[name], "-dumpmachine"]).strip() == triple,
                "COMPILER_TRIPLE_MISMATCH")
    checked_file(root, manifest["ctest"])
    for name in ("curl_library", "host_curl_library"):
        checked_file(root, manifest[name])
    for name in ("curl_include", "host_curl_include"):
        require(inside(root, manifest[name]).is_dir(), "CURL_HEADERS_REQUIRED")
    sysroot = inside(root, manifest["sysroot"]["path"])
    for name in ("curl_include",):
        require(inside(root, manifest[name]).is_relative_to(sysroot), "TARGET_CURL_OUTSIDE_SYSROOT")
    require(inside(root, manifest["curl_library"]["path"]).is_relative_to(sysroot), "TARGET_CURL_OUTSIDE_SYSROOT")
    require(manifest["target_libraries"] and manifest["falcon_host_libraries"], "TARGET_EXPORT_EVIDENCE_REQUIRED")
    for record in manifest["target_libraries"] + manifest["falcon_host_libraries"]:
        checked_file(root, record)
    curl_providers = [record for record in manifest["target_libraries"] if record["soname"] == "libcurl.so.4"]
    require(len(curl_providers) == 1 and curl_providers[0]["sha256"] == manifest["curl_library"]["sha256"],
            "CURL_PROVIDER_NOT_LINKED_LIBRARY")
    toolchain_root = inside(root, manifest["toolchain"]["path"])
    require(all(tools[name].is_relative_to(toolchain_root) for name in ("cc", "cxx", "nm", "readelf")),
            "TARGET_TOOL_OUTSIDE_TOOLCHAIN")
    return tools


def symbols(output, undefined=False):
    result = []
    for line in output.splitlines():
        parts = line.split()
        require(len(parts) >= 2, "NM_OUTPUT_FORMAT")
        name, kind = parts[:2]
        # Weak undefined symbols are optional at ELF load; do not silently waive them here.
        result.append((name.replace("@@", "@"), kind))
    return result


def audit(root, manifest, tools, artifact):
    def inspect(flag):
        return command([tools["readelf"], flag, artifact])
    file_text = command([tools["file"], "-b", artifact]).strip()
    header, program, dynamic, versions = [inspect(x) for x in ("-h", "-l", "-d", "--version-info")]
    require("ELF 64-bit LSB shared object" in file_text and "ARM aarch64" in file_text,
            "FILE_ABI_MISMATCH")
    require(re.search(r"Class:\s+ELF64", header) and re.search(r"Data:.*little endian", header) and
            re.search(r"Machine:\s+AArch64", header) and re.search(r"Type:\s+DYN", header), "ELF_ABI_MISMATCH")
    require(not re.search(r"\bINTERP\b", program), "SHARED_LIBRARY_HAS_INTERPRETER")
    require(not re.search(r"\((?:RPATH|RUNPATH)\)", dynamic), "ELF_SEARCH_PATH_FORBIDDEN")
    require("(TEXTREL)" not in dynamic, "ELF_TEXT_RELOCATION")
    needed = sorted(re.findall(r"\(NEEDED\).*\[([^\]]+)\]", dynamic))
    require("libcurl.so.4" in needed and len(needed) == len(set(needed)), "ELF_CURL_DEPENDENCY_REQUIRED")
    available, providers, library_exports = set(), {}, {}
    for record in manifest["target_libraries"] + manifest["falcon_host_libraries"]:
        library = checked_file(root, record)
        library_header = command([tools["readelf"], "-h", library])
        require(re.search(r"Class:\s+ELF64", library_header) and
                re.search(r"Data:.*little endian", library_header) and
                re.search(r"Machine:\s+AArch64", library_header), "PROVIDER_ABI_MISMATCH")
        exports = set()
        raw = command([tools["nm"], "-D", "-P", "--defined-only", library])
        for symbol, kind in symbols(raw):
            if kind in ("T", "W", "D", "B", "R", "V", "i", "u", "A"):
                exports.add(symbol)
        # @@ default versions also satisfy unversioned imports; @ non-default ones do not.
        for line in raw.splitlines():
            parts = line.split()
            if len(parts) >= 2 and "@@" in parts[0] and parts[1] in ("T", "W", "D", "B", "R", "V", "i", "u", "A"):
                exports.add(parts[0].split("@@")[0])
        if record in manifest["target_libraries"]:
            soname = record["soname"]
            require(re.fullmatch(r"[A-Za-z0-9_.+-]+", soname) and soname not in providers,
                    "PROVIDER_SONAME_INVALID")
            lib_dynamic = command([tools["readelf"], "-d", library])
            require(re.findall(r"\(SONAME\).*\[([^\]]+)\]", lib_dynamic) == [soname], "PROVIDER_SONAME_MISMATCH")
            providers[soname] = record["sha256"]
            library_exports[soname] = exports
        else:
            # Falcon host exports are an exact approved subset, not every symbol in its ELF.
            approved = record["approved_symbols"]
            require(isinstance(approved, list) and approved and len(approved) == len(set(approved)) and
                    set(approved) <= exports, "FALCON_APPROVED_EXPORTS_INVALID")
            available.update(approved)
    require(set(needed) <= set(providers), "UNAPPROVED_NEEDED_LIBRARY")
    for soname in needed:
        available.update(library_exports[soname])
    defined = dict(symbols(command([tools["nm"], "-D", "-P", "--defined-only", artifact])))
    require(defined.get("custom_init_jsapis") == "T", "ENTRY_POINT_MISSING")
    imports = symbols(command([tools["nm"], "-D", "-P", "--undefined-only", artifact]), True)
    require(all(name in available for name, _ in imports), "UNSATISFIED_EXACT_TARGET_SYMBOL")
    # No regex exemptions, version ceilings, or weak-symbol escape hatch.
    return {"schema_version": 1, "profile": manifest["profile"], "needed": needed,
            "provider_sha256": {name: providers[name] for name in needed},
            "imports": sorted(name for name, _ in imports),
            "required_versions": sorted(set(re.findall(r"Name:\s+([A-Za-z0-9_.]+)", versions))),
            "elf": "ELF64 little-endian AArch64 DYN; no PT_INTERP/RPATH/RUNPATH/TEXTREL",
            "device_compatibility": "unverified; exact supplied exports only"}


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def cmake_string(value):
    require(not any(c in str(value) for c in ('"', ';', '\n', '\r', '$', '\\')), "CMAKE_PATH_FORMAT")
    return '"' + str(value) + '"'


def run_build(repo, work, root, manifest, tools, policy, source_sha):
    require(os.environ.get("GITHUB_ACTIONS") == "true" and sys.platform == "linux",
            "COMPILE_ONLY_IN_GITHUB_ACTIONS")
    output = work / "artifact"
    output.mkdir()
    log = []
    def stage(name, argv, cwd=None):
        command(argv, cwd)
        log.append(name + " exit=0")
    host = work / "host-build"
    stage("host-configure", [tools["cmake"], "-S", repo / "native", "-B", host, "-G", "Ninja",
          "-DHTTPX_BUILD_PLUGIN=OFF", "-DHTTPX_BUILD_TESTS=ON", "-DCMAKE_BUILD_TYPE=Release",
          "-DCMAKE_MAKE_PROGRAM=" + str(tools["ninja"]),
          "-DCMAKE_C_COMPILER=" + str(tools["host_cc"]), "-DCMAKE_CXX_COMPILER=" + str(tools["host_cxx"]),
          "-DCURL_NO_CURL_CMAKE=TRUE", "-DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF",
          "-DCURL_INCLUDE_DIR=" + str(inside(root, manifest["host_curl_include"])),
          "-DCURL_LIBRARY_RELEASE=" + str(inside(root, manifest["host_curl_library"]["path"]))])
    stage("host-build", [tools["cmake"], "--build", host, "--parallel", "2"])
    # CTest is located alongside the approved CMake, and separately hash checked.
    ctest = checked_file(root, manifest["ctest"])
    stage("core-native-tests-ci-only", [ctest, "--test-dir", host, "--output-on-failure", "--timeout", "45"])
    toolchain = work / "aarch64-toolchain.cmake"
    settings = {"CMAKE_SYSTEM_NAME": "Linux", "CMAKE_SYSTEM_PROCESSOR": "aarch64",
                "CMAKE_SYSROOT": str(inside(root, manifest["sysroot"]["path"])),
                "CMAKE_C_COMPILER": str(tools["cc"]), "CMAKE_CXX_COMPILER": str(tools["cxx"]),
                "CMAKE_NM": str(tools["nm"]), "CMAKE_READELF": str(tools["readelf"]),
                "CMAKE_FIND_ROOT_PATH_MODE_PROGRAM": "NEVER", "CMAKE_FIND_ROOT_PATH_MODE_LIBRARY": "ONLY",
                "CMAKE_FIND_ROOT_PATH_MODE_INCLUDE": "ONLY", "CMAKE_FIND_ROOT_PATH_MODE_PACKAGE": "ONLY"}
    toolchain.write_text("\n".join("set(" + key + " " + cmake_string(value) + ")" for key, value in settings.items()) + "\n", encoding="utf-8")
    target = work / "target-build"
    stage("aarch64-configure", [tools["cmake"], "-S", repo / "native", "-B", target, "-G", "Ninja",
          "-DCMAKE_TOOLCHAIN_FILE=" + str(toolchain), "-DHTTPX_BUILD_PLUGIN=ON", "-DHTTPX_BUILD_TESTS=OFF",
          "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_MAKE_PROGRAM=" + str(tools["ninja"]),
          "-DHTTPX_SDK_DIR=" + str(inside(root, manifest["sdk"]["path"])),
          "-DHTTPX_CURL_INCLUDE_DIR=" + str(inside(root, manifest["curl_include"])),
          "-DHTTPX_CURL_LIBRARY=" + str(inside(root, manifest["curl_library"]["path"]))])
    stage("aarch64-build", [tools["cmake"], "--build", target, "--parallel", "2"])
    # Preserve the exact link argv, replacing only ephemeral directory prefixes.
    commands = command([tools["ninja"], "-C", target, "-t", "commands", "jsapi_httpx"])
    links = [line for line in commands.splitlines() if "-shared" in line and "libjsapi_httpx.so" in line]
    require(len(links) == 1, "LINK_COMMAND_NOT_UNIQUE")
    link = links[0].replace(str(work), "<CI_WORK>").replace(str(repo), "<SOURCE>")
    write_json(output / "link-command.json", {"command": link})
    artifact = target / "libjsapi_httpx.so"
    report = audit(root, manifest, tools, artifact)
    log.append("target-elf-exact-export-audit exit=0")
    shutil.copyfile(artifact, output / ARTIFACTS[0])
    write_json(output / "elf-report.json", report)
    write_json(output / "manifest.json", {"schema_version": 1, "source_revision": source_sha,
        "profile": manifest["profile"], "abi": manifest["abi"],
        "bundle_sha256": policy["bundle"]["sha256"],
        "bundle_manifest_sha256": policy["bundle"]["manifest_sha256"],
        "components": {key: {field: manifest[key][field] for field in
                       ("revision", "source_sha256", "tree_sha256")} for key in ("toolchain", "sdk", "sysroot")},
        "tools": {key: {field: record[field] for field in
                  ("sha256", "version_line", "target_triple") if field in record}
                  for key, record in manifest["tools"].items() if key in tools},
        "authorization_reference": policy["authorization"]["approval_reference"],
        "compatibility": "NOT VERIFIED ON DEVICE", "raw_logs": "not retained; controlled stage log only"})
    (output / "build.log").write_text("\n".join(log) + "\n", encoding="utf-8")
    (output / "SHA256SUMS").write_text("".join(digest(output / name) + "  " + name + "\n"
        for name in ARTIFACTS if name != "SHA256SUMS"), encoding="utf-8")
    require(sorted(x.name for x in output.iterdir()) == sorted(ARTIFACTS), "ARTIFACT_SCOPE_MISMATCH")
    require(digest(output / ARTIFACTS[0]) == digest(artifact), "ARTIFACT_COPY_SHA_MISMATCH")
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--work", required=True)
    args = parser.parse_args()
    require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
            and sys.platform == "linux", "MANUAL_GITHUB_ACTIONS_ONLY")
    repo, work = Path(args.repo).resolve(), Path(args.work).resolve()
    policy = load(repo / "native/ci-policy.json")
    event = load(os.environ["GITHUB_EVENT_PATH"])
    url, sha = event.get("inputs", {}).get("bundle_url", ""), event.get("inputs", {}).get("bundle_sha256", "")
    tracked = command(["git", "-C", repo, "ls-files", "-z"]).rstrip("\0").split("\0")
    validate_policy(policy, event, url, sha, tracked)
    source_sha = command(["git", "-C", repo, "rev-parse", "HEAD"]).strip()
    require(re.fullmatch(r"[0-9a-f]{40}", source_sha) and source_sha == os.environ.get("GITHUB_SHA"),
            "SOURCE_REVISION_MISMATCH")
    require(not work.exists() and not work.is_relative_to(repo), "CLEAN_EXTERNAL_WORK_REQUIRED")
    work.mkdir(parents=True)
    print("native-ci: approved policy gate passed", flush=True)
    archive = work / "bundle.tar.xz"
    download(url, sha, archive, policy["bundle"]["max_download_bytes"])
    root = work / "bundle"
    extract(archive, root, policy["bundle"]["max_extracted_bytes"])
    require(digest(root / "manifest.json") == policy["bundle"]["manifest_sha256"], "MANIFEST_SHA_MISMATCH")
    manifest = load(root / "manifest.json")
    tools = validate_manifest(root, manifest)
    print("native-ci: bundle provenance and tool identity verified", flush=True)
    output = run_build(repo, work, root, manifest, tools, policy, source_sha)
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
        stream.write("artifact_dir=" + str(output) + "\n")
    print("native-ci: CI stages completed; device compatibility remains unverified", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Denied as error:
        print("native-ci: " + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # URLs, event fields, tar filenames, raw stderr and environment values stay out of logs.
        print("native-ci: VALIDATION_OR_TOOL_ERROR (raw details intentionally withheld)", file=sys.stderr)
        sys.exit(1)
