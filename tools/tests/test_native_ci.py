"""Pure Python contract tests: never download, configure, compile, link or run CTest."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("native_ci", ROOT / "tools/native-ci.py")
ci = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ci)


def approved_policy():
    sha = "a" * 64
    return {"schema_version": 1, "enabled": True,
        "authorization": {"repository": "approved/penagent", "visibility": "private",
            "ref": "refs/heads/native-review", "approval_reference": "user-approval-test-fixture",
            "source_upload_scope": ["native/*", "tools/*", ".github/workflows/native-manual.yml"],
            "artifact_upload_scope": ci.ARTIFACTS.copy()},
        "bundle": {"url": "https://bundles.example.org/sha256/" + sha + "/bundle.tar.xz",
            "sha256": sha, "manifest_sha256": "b" * 64,
            "max_download_bytes": 1024, "max_extracted_bytes": 2048}}


def approved_event():
    return {"repository": {"full_name": "approved/penagent", "visibility": "private"},
            "ref": "refs/heads/native-review"}


class PolicyTests(unittest.TestCase):
    def validate(self, policy=None, event=None, files=None):
        policy = approved_policy() if policy is None else policy
        ci.validate_policy(policy, approved_event() if event is None else event,
            approved_policy()["bundle"]["url"], "a" * 64,
            ["native/CMakeLists.txt", "tools/native-ci.py", ".github/workflows/native-manual.yml"]
            if files is None else files)

    def test_disabled_policy_fails_closed(self):
        policy = approved_policy()
        policy["enabled"] = False
        with self.assertRaisesRegex(ci.Denied, "POLICY_DISABLED"):
            self.validate(policy)

    def test_explicit_approved_fixture(self):
        self.validate()

    def test_missing_repo_or_approval_fails(self):
        for key in ("repository", "visibility", "ref", "approval_reference"):
            with self.subTest(key=key), self.assertRaises(ci.Denied):
                policy = approved_policy()
                policy["authorization"][key] = ""
                self.validate(policy)

    def test_repository_visibility_and_ref_must_match(self):
        for event in ({"repository": {"full_name": "wrong/repo", "visibility": "private"}, "ref": "refs/heads/native-review"},
                      {"repository": {"full_name": "approved/penagent", "visibility": "public"}, "ref": "refs/heads/native-review"},
                      {"repository": approved_event()["repository"], "ref": "refs/heads/wrong"}):
            with self.subTest(event=event), self.assertRaises(ci.Denied):
                self.validate(event=event)

    def test_sources_outside_scope_fail(self):
        with self.assertRaisesRegex(ci.Denied, "SOURCE_OUTSIDE"):
            self.validate(files=["unapproved-sdk/private.h"])

    def test_missing_or_overbroad_scopes_fail(self):
        for scope in ([], ["**"], ["**/*"], ["*"]):
            policy = approved_policy()
            policy["authorization"]["source_upload_scope"] = scope
            with self.subTest(scope=scope), self.assertRaises(ci.Denied):
                self.validate(policy)
        policy = approved_policy()
        policy["authorization"]["artifact_upload_scope"].append("bundle.tar.xz")
        with self.assertRaisesRegex(ci.Denied, "ARTIFACT_SCOPE"):
            self.validate(policy)

    def test_digest_or_manifest_approval_mismatch(self):
        for key in ("url", "sha256", "manifest_sha256"):
            policy = approved_policy()
            policy["bundle"][key] = ""
            with self.subTest(key=key), self.assertRaises(ci.Denied):
                self.validate(policy)

    def test_non_ci_build_is_denied_before_any_tool(self):
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}), patch.object(ci, "command") as tool:
            with self.assertRaisesRegex(ci.Denied, "COMPILE_ONLY"):
                ci.run_build(None, None, None, None, None, None, None)
            tool.assert_not_called()


class SourceTests(unittest.TestCase):
    def test_credentials_queries_redirects_mutable_paths_and_wrong_sha_rejected(self):
        base = approved_policy()["bundle"]["url"]
        invalid = [base.replace("https:", "http:"), base + "?token=sentinel-secret",
                   base + "#secret", base.replace("bundles.", "user:secret@bundles."),
                   base.replace("/sha256/", "/releases/latest/"), base.replace("a" * 64, "b" * 64),
                   base.replace("bundles.example.org", "127.0.0.1"),
                   base.replace("bundles.example.org", "example.org:444")]
        for url in invalid:
            with self.subTest(url=url), self.assertRaises(ci.Denied):
                ci.validate_url(url, "a" * 64)

    def test_private_dns_is_rejected(self):
        for address in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "192.168.1.1"):
            with patch.object(ci.socket, "getaddrinfo", return_value=[(None, None, None, None, (address, 443))]):
                with self.subTest(address=address), self.assertRaises(ci.Denied):
                    ci.public_addresses("bundles.example.org")

    def test_duplicate_json_key_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.json"
            path.write_text('{"enabled":false,"enabled":true}', encoding="utf-8")
            with self.assertRaisesRegex(ci.Denied, "DUPLICATE"):
                ci.load(path)

    def test_tar_safely_extracted_and_modes_sanitized(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "bundle.tar.xz"
            with tarfile.open(archive, "w:xz") as stream:
                member = tarfile.TarInfo("tools/compiler")
                member.mode = 0o6755
                member.size = 3
                stream.addfile(member, io.BytesIO(b"abc"))
            destination = Path(directory) / "out"
            ci.extract(archive, destination, 10)
            self.assertEqual((destination / "tools/compiler").read_bytes(), b"abc")
            if os.name != "nt":
                self.assertEqual((destination / "tools/compiler").stat().st_mode & 0o7777, 0o755)
            self.assertEqual(ci.tree_sha(destination), hashlib.sha256(
                (hashlib.sha256(b"abc").hexdigest() + "  tools/compiler\n").encode()).hexdigest())

    def test_tar_path_link_special_duplicate_and_bomb_rejected(self):
        for name, kind, duplicate, limit in (("../outside", tarfile.REGTYPE, False, 10),
                ("/absolute", tarfile.REGTYPE, False, 10), ("a/../../outside", tarfile.REGTYPE, False, 10),
                ("escape", tarfile.SYMTYPE, False, 10), ("escape", tarfile.LNKTYPE, False, 10),
                ("device", tarfile.CHRTYPE, False, 10), ("file", tarfile.REGTYPE, True, 10),
                ("file", tarfile.REGTYPE, False, 1)):
            with self.subTest(name=name, kind=kind, duplicate=duplicate, limit=limit):
                with tempfile.TemporaryDirectory() as directory:
                    archive = Path(directory) / "bundle.tar.xz"
                    with tarfile.open(archive, "w:xz") as stream:
                        for _ in range(2 if duplicate else 1):
                            member = tarfile.TarInfo(name)
                            member.type, member.linkname = kind, "../../outside"
                            member.size = 3 if kind == tarfile.REGTYPE else 0
                            stream.addfile(member, io.BytesIO(b"abc") if member.size else None)
                    with self.assertRaises(ci.Denied):
                        ci.extract(archive, Path(directory) / "out", limit)

    def test_download_rejects_redirect_sha_mismatch_and_size(self):
        class Response:
            def __init__(self, status, content):
                self.status, self.content = status, content
            def getheader(self, name):
                return str(len(self.content))
            def read(self, size):
                content, self.content = self.content[:size], self.content[size:]
                return content
        class Connection:
            def __init__(self, response):
                self.response = response
            def request(self, *args, **kwargs):
                pass
            def getresponse(self):
                return self.response
            def close(self):
                pass
        url = approved_policy()["bundle"]["url"]
        for response, limit, code in ((Response(302, b"redirect"), 100, "HTTP_STATUS_OR_REDIRECT"),
                                      (Response(200, b"abc"), 100, "SHA_MISMATCH"),
                                      (Response(200, b"abc"), 1, "DOWNLOAD_SIZE")):
            with tempfile.TemporaryDirectory() as directory, self.subTest(code=code):
                with patch.object(ci, "public_addresses", return_value=["8.8.8.8"]), \
                     patch.object(ci, "PinnedHTTPS", return_value=Connection(response)):
                    with self.assertRaisesRegex(ci.Denied, code):
                        ci.download(url, "a" * 64, Path(directory) / "download", limit)

    def test_tool_output_is_not_logged_on_failure(self):
        result = ci.subprocess.CompletedProcess([], 1, b"SENTINEL_PAYLOAD", b"SENTINEL_SECRET")
        with patch.object(ci.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(ci.Denied, "^TOOL_FAILED$"):
                ci.command(["fixture-only-not-executed"])


class AuditTests(unittest.TestCase):
    def fixture(self, root):
        names = ["libcurl.so.4", "libc.so.6", "libstdc++.so.6"]
        records = []
        for name in names + ["falcon"]:
            (root / name).write_bytes(b"synthetic-not-an-ELF")
            records.append({"path": name, "sha256": ci.digest(root / name), "soname": name})
        records[-1]["approved_symbols"] = ["JS_Fixture"]
        return {"profile": "y02-4.9.7", "target_libraries": records[:-1],
                "falcon_host_libraries": records[-1:]}

    def execute(self, undefined="curl_easy_init U\nmemcpy@GLIBC_2.17 U\nJS_Fixture U\n",
                needed=None, header=None, program=None, dynamic_suffix="", approved=None):
        header = header or "Class: ELF64\nData: 2's complement, little endian\nMachine: AArch64\nType: DYN\n"
        needed = ["libcurl.so.4", "libc.so.6"] if needed is None else needed
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = self.fixture(root)
            if approved is not None:
                manifest["falcon_host_libraries"][0]["approved_symbols"] = approved
            tools = {"file": "file", "readelf": "readelf", "nm": "nm"}
            def fake(argv, *args, **kwargs):
                name = str(argv[-1])
                if argv[0] == "file":
                    return "ELF 64-bit LSB shared object, ARM aarch64\n"
                if argv[0] == "readelf":
                    if argv[1] == "-h":
                        return header
                    if argv[1] == "-l":
                        return "LOAD\n" if program is None else program
                    if argv[1] == "--version-info":
                        return "Name: GLIBC_2.17\n"
                    if name.endswith("module.so"):
                        return "\n".join("(NEEDED) [" + x + "]" for x in needed) + dynamic_suffix
                    return "(SONAME) [" + Path(name).name + "]\n"
                if "--undefined-only" in argv:
                    return undefined
                if name.endswith("module.so"):
                    return "custom_init_jsapis T 100 10\n"
                if name.endswith("libcurl.so.4"):
                    return "curl_easy_init@@CURL_OPENSSL_4 T 100 10\n"
                if name.endswith("libc.so.6"):
                    return "memcpy@@GLIBC_2.17 T 100 10\n"
                if name.endswith("libstdc++.so.6"):
                    return "cpp_export@@GLIBCXX_3.4 T 100 10\n"
                return "JS_Fixture T 100 10\nJS_Unapproved T 200 10\n"
            with patch.object(ci, "command", side_effect=fake):
                return ci.audit(root, manifest, tools, root / "module.so")

    def test_exact_supplied_exports_allow_fixture_only(self):
        self.assertEqual(self.execute()["needed"], ["libc.so.6", "libcurl.so.4"])

    def test_glibc_glibcxx_weak_and_falcon_no_blanket_exemptions(self):
        for imports in ("memcpy@GLIBC_99.0 U\n", "cpp_export@GLIBCXX_99.0 U\n",
                        "JS_Unapproved U\n", "_ITM_registerTMCloneTable w\n", "unknown U\n"):
            with self.subTest(imports=imports), self.assertRaisesRegex(ci.Denied, "UNSATISFIED"):
                self.execute(undefined=imports)

    def test_export_from_non_needed_library_does_not_satisfy_import(self):
        with self.assertRaisesRegex(ci.Denied, "UNSATISFIED"):
            self.execute(undefined="cpp_export@GLIBCXX_3.4 U\n")

    def test_needed_library_interpreter_and_search_paths_rejected(self):
        for options in ({"needed": ["libcurl.so.4", "libunapproved.so"]},
                        {"program": "INTERP"}, {"dynamic_suffix": "\n(RPATH) [/tmp]"},
                        {"dynamic_suffix": "\n(RUNPATH) [/tmp]"}, {"dynamic_suffix": "\n(TEXTREL)"},
                        {"header": "Class: ELF32\nMachine: ARM\n"}):
            with self.subTest(options=options), self.assertRaises(ci.Denied):
                self.execute(**options)

    def test_falcon_allowlist_must_exist_in_exact_provider(self):
        with self.assertRaisesRegex(ci.Denied, "FALCON_APPROVED"):
            self.execute(approved=["Invented_Export"])


class StaticWorkflowTests(unittest.TestCase):
    def test_only_manual_trigger_and_actions_full_sha(self):
        text = (ROOT / ".github/workflows/native-manual.yml").read_text(encoding="utf-8")
        self.assertIn("  workflow_dispatch:", text)
        self.assertNotRegex(text, r"(?m)^  (push|pull_request|pull_request_target|schedule|workflow_call):")
        uses = ci.re.findall(r"uses: ([^\s]+)", text)
        self.assertEqual(len(uses), 2)
        for action in uses:
            self.assertRegex(action, r"^actions/[a-z-]+@[0-9a-f]{40}$")
        self.assertIn("persist-credentials: false", text)
        self.assertNotRegex(text, r"\$\{\{\s*secrets\.")
        self.assertIn("environment: native-reviewed", text)
        self.assertNotIn("${{ inputs.", text)
        self.assertNotIn("BUNDLE_URL:", text)

    def test_cmake_guard_precedes_project_and_no_blanket_import_waivers(self):
        text = (ROOT / "native/CMakeLists.txt").read_text(encoding="utf-8")
        self.assertLess(text.index('"$ENV{GITHUB_ACTIONS}"'), text.index("project(jsapi_httpx"))
        audit = (ROOT / "native/cmake/CheckHttpxElf.cmake").read_text(encoding="utf-8")
        self.assertNotIn("GLIBC_2.36", audit)
        self.assertNotIn('base MATCHES "^', audit)
        self.assertIn("exact target exports still require", audit)


if __name__ == "__main__":
    unittest.main()
