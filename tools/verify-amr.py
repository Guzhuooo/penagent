"""Read-only validation of CLI-generated AMRs; never creates a package."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile

NATIVE_LIBRARY = "libs/libjsapi_httpx.so"
AARCH64_EM = 183


def verify(path, package, native_sha256=None):
    source = json.loads(package.read_text(encoding="utf-8"))
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("duplicate archive entry")
        for name in names:
            parts = PurePosixPath(name).parts
            if name.startswith("/") or ".." in parts or "\\" in name:
                raise ValueError("unsafe archive path")
        manifest = json.loads(archive.read("manifest.json"))
        for field in ("appid", "version"):
            if manifest.get(field) != source.get(field):
                raise ValueError("manifest/package mismatch: " + field)
        cert = manifest.get("cert")
        if not isinstance(cert, dict) or not cert:
            raise ValueError("missing resource certificate")
        for name, record in cert.items():
            data = archive.read(name)
            if len(data) != record.get("size"):
                raise ValueError("resource size mismatch: " + name)
            if hashlib.md5(data).hexdigest() != record.get("md5"):
                raise ValueError("resource digest mismatch: " + name)
        for required in ("app.js.bin", "index.js.bin", "settings.js.bin", "probe.js.bin", "tools.js.bin", "workspace.js.bin"):
            if required not in cert:
                raise ValueError("missing entry: " + required)
        if manifest.get("icon") not in names:
            raise ValueError("missing icon")
        scripts = {name for name in names if name.endswith((".js", ".js.bin"))}
        if scripts - set(cert):
            raise ValueError("uncertified script")
        libraries = [name for name in names if name.endswith(".so")]
        native_sha = None
        if libraries:
            if native_sha256 is None:
                raise ValueError("native library is not enabled/verified for this release")
            if libraries != [NATIVE_LIBRARY]:
                raise ValueError("unexpected native library set: " + repr(libraries))
            data = archive.read(NATIVE_LIBRARY)
            native_sha = hashlib.sha256(data).hexdigest()
            if native_sha != native_sha256:
                raise ValueError("native library SHA-256 mismatch")
            if len(data) < 64 or data[:4] != b"\x7fELF" or data[4] != 2 or data[5] != 1:
                raise ValueError("native library is not ELF64 little-endian")
            machine = int.from_bytes(data[18:20], "little")
            if machine != AARCH64_EM:
                raise ValueError("native library is not AArch64")
        return {
            "appid": manifest["appid"], "version": manifest["version"],
            "quickjs": manifest.get("quickjs"), "resources": len(cert),
            "archiveBytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "nativeLibraries": len(libraries), "nativeLibrary": NATIVE_LIBRARY if libraries else None,
            "nativeSha256": native_sha, "manifestVerified": True,
            "hardwareAcceptance": "pending",
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("amr", type=Path)
    parser.add_argument("--package", type=Path, default=Path(__file__).resolve().parents[1] / "app" / "package.json")
    parser.add_argument("--native-sha256", default=None, help="expected SHA-256 of libs/libjsapi_httpx.so; required when the AMR contains a native library")
    args = parser.parse_args()
    print(json.dumps(verify(args.amr, args.package, args.native_sha256), ensure_ascii=False, indent=2))
