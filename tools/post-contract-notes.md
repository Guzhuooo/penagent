# Falcon flat HTTP contract and security investigation

## Scope and provenance

Latest read-only disassembly findings supplied for this documentation correction concern the existing `libfalcon.so` copy with SHA-256:

```text
91e23dcef405d849e17757656cd2603ecc21cc9d20437bf38937c6b13b664a58
```

The earlier investigation recorded this copy as matching the device. **ADB is currently disconnected; this documentation pass did not re-hash the device, repeat disassembly, execute HTTP/certificate tests, deploy, upload, or compile anything.** Addresses below are virtual addresses in that identified binary, not proof that an unobserved/current firmware is byte-identical.

- Function: `HttpApiExtension::request(const std::string&, const std::string&)`.
- Export: `_ZN16HttpApiExtension7requestERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEES7_`.
- Function address `0x7577f0`, size `0x3ce8` (15592 bytes).
- Flat `http.request` registration site: `0x753728`.

**Conclusion: this flat implementation is statically known to violate production transport requirements, not merely awaiting TLS verification.** Correct JSON POST is plausible from the body control flow, but it does not make this a secure production adapter. Production requires native httpx or another independently validated secure adapter; that requirement follows from transport safety/status limitations, not a claim that Falcon cannot POST.

## 1. JSON POST input contract

The flat call is `$falcon.jsapi['http.request'](JSON.stringify(options), callback)`, preserving the API receiver. The envelope is a JSON string; its relevant fields are `url`, `method`, singular `header`, and `data`.

- With `method: 'POST'` (also lowercase `post`) and `header['Content-Type']: 'application/json'`, non-null **object-valued `data`** is serialized by native `JQuick::Json::dump` into the POST body.
- Already-stringified `data` is serialized again into a JSON string literal, with enclosing quotes and escaping. It is not an object JSON body.
- `body`, `requestBody`, `params`, and `requestMethod` are not input fields read by this function. Null/absent `data` in JSON mode produces an empty body.
- Header JSON mode is selected by the case-sensitive substring `application/json` in an emitted header line. Missing/non-JSON headers use `data.object_items()` and string-valued `key=value` pairs; this is not a raw nested-JSON transport.
- Caller `timeout`, TLS/verification settings, redirect policy, and `signal` are not read or honored by this entry. Nor does this function read `dataType` / `responseType`.

| Address | Operation |
|---|---|
| `0x757a30` | Parse options text with `JQuick::Json::parse`. |
| `0x757a60`–`0x757a74` | Read `url` and `string_value()`. |
| `0x757ab0`–`0x757ac8` | Read singular `header` and `object_items()`. |
| `0x757b64` | Read each header value as string. |
| `0x757bdc`–`0x757bf8` | Test emitted header for `application/json`. |
| `0x75a048`–`0x75a098`, `0x75a7c0`–`0x75a7d0` | Read `method`, recognize `POST` / `post`. |
| `0x75a0a4`–`0x75a0d8`, `0x75a490`–`0x75a4bc` | Read non-null `data`, serialize with `Json::dump`. |
| `0x75a114`, `0x75a12c`, `0x75a144` | Set CURLOPT_POST (47), POSTFIELDS (10015), POSTFIELDSIZE (60). |
| `0x75a53c`–`0x75a558`, `0x75a5d4`–`0x75a5ec` | Non-JSON object-items / string-value form path. |

This is static evidence of the input/body implementation. A corrected object-data request has not acquired new device end-to-end evidence in this pass.

## 2. Statically confirmed security and deadline defects

These options are set before the input envelope is parsed:

| Call site | libcurl option (number) | Value | Consequence |
|---|---|---|---|
| `0x757934` | `CURLOPT_FOLLOWLOCATION` (52) | `1` | Redirect following is enabled; caller `redirect:'error'` cannot enforce the project policy. Do not infer cross-origin credential safety. |
| `0x75794c` | `CURLOPT_SSL_VERIFYPEER` (64) | `0` | Certificate-chain verification disabled. |
| `0x757964` | `CURLOPT_SSL_VERIFYHOST` (81) | `0` | TLS hostname verification disabled. |
| `0x75797c` | `CURLOPT_CONNECTTIMEOUT_MS` (156) | `10000` | Fixed **10-second connection timeout**. |
| `0x757998` | `CURLOPT_TIMEOUT_MS` (155) | `100000` | Fixed **100-second total timeout**. |

The old statement that both connect and total timeout were 10000ms / 10 seconds is **incorrect and superseded**. An app-level 8/15/20-second timer only bounds local waiting; it neither configures that native deadline nor proves native cancellation. A 15-second reporting deadline is shorter than the native 100-second total timeout, so an eventual callback may still arrive after reporting has stopped.

The options reader only consumes `url/header/method/data`; it exposes no caller control for TLS verification, redirect, timeout, or signal. **No abort entry was found for this flat path in the reviewed evidence.** That is a scoped investigation result, not a claim that every Falcon module lacks abort. Logical cancellation must suppress stale work without claiming socket/resource release or reversal of remote billing/effects.

These facts are sufficient to reject this implementation for production credentials and user payloads. They are **not an executed invalid-certificate test**, a live exploit demonstration, or a newly verified device hash. HTTPS URLs, additional JS fields, and a successful local POST cannot repair the underlying disabled checks.

## 3. HTTP status and proxy error contract

- `CURLINFO_RESPONSE_CODE` is obtained at `0x75a19c`; the success branch at `0x75a1a8`–`0x75a1b4` accepts only HTTP **200 or 201**.
- On success, response text is returned as `{result: 'response text'}` (`result` construction at `0x75a980`–`0x75a9ac`). The success envelope has **no actual HTTP status**. A caller cannot distinguish 200 from 201 from this envelope.
- Error reporting includes `{result: {errorMessage: ...}}` with proxy error **3**. That proxy error is **not an HTTP status**.
- Do not fabricate status 200, map proxy error 3 to an HTTP response code, or scrape/regex an error message to manufacture status. Preserve unknown status as null/unknown and use stable controlled transport errors. The production core requires a trustworthy status source, not a value claimed in response JSON.

## 4. Why the old POST probes were invalid

This describes the earlier investigation snapshot, not current line numbers or a claim that current source still has the same defects:

1. The old `probeRequest -> requestRaw` wrapper reconstructed its envelope and only forwarded `opts.body` as `payload.body`. Inputs named `data/requestBody/params` never reached native through that wrapper. The four-field comparison therefore did not test the native data contract.
2. The old probe selected nested `http.request` and sent `headers/body/requestMethod`, which belong to a different presumed contract.
3. The nested framework wrapper returns a Promise and forwards options unchanged to the flat entry with a callback. It does not stringify options or translate body/header fields. JSON-stringifying that immediate Promise produces `{}`; treating it as completion set `settled` too early and suppressed the real result.
4. The old 2500ms reporting deadline, like any JS-only deadline, did not cancel the native request.

Readable supporting framework source from installed `aiot-vue-cli@1.0.32`:

```text
C:\Users\<user>\AppData\Roaming\npm\node_modules\aiot-vue-cli\cli-libs\falcon-jsfm\dist\falcon-js-web.js
```

The earlier read found `$falcon.jsapi -> __JSAPI` around line 802, dotted-name modularization around 612–638, and `_promisefy` around 521–528. Matching device bytecode strings support this interpretation; the CLI source is not claimed to be a byte-identical source reconstruction of device bytecode.

`HttpBridge.httpBridge` in `/etc/miniapp/jsapis/libjsapi_export_core.so` and the separate `jq::JSHttp/Session` module are different implementations. Their strings or contracts cannot repair or establish the flat path's safety, caller options, or third-party exposure.

## 5. Safe next steps and evidence limits

- Keep production fail closed for this flat implementation. Use native httpx or another adapter only after independent verification of TLS peer/hostname checks, redirect rejection/isolation, truthful HTTP status, enforceable deadline/cancellation and resource/size limits.
- A later authorized device POST check may use only fixed synthetic input and a fake key against the controlled local mock, once ADB reconnects. It tests delivery only, not production eligibility. Never use a third-party/production endpoint or real credential to test this insecure path.
- Record only method, UTF-8 byte counts, shape/field/auth-match booleans, controlled status/error codes, elapsed time and local correlation IDs. Do not log options, URLs containing secrets, Authorization, payloads, raw echo, or arbitrary errorMessage text.
- The old standalone helper with payload/echo logging has been removed from this document. It was designed but not executed on-device and is not a safe probe to copy. Its 15-second reporting timer was not physical cancellation.
- Native build/upload/repository operations still require specific authorization and the approved GitHub Actions toolchain path. This correction authorizes none and performs none.

Original supporting-copy hashes from the earlier investigation are retained solely as historical provenance; none was rechecked against a connected device in this pass:

| Historical device path / local copy | Recorded SHA-256 |
|---|---|
| `/usr/lib/libjsapi_proxy.so` / `D:\pendouyin\_recon\elf\libjsapi_proxy.so` | `cb63ece0b7859c2a1c340de09fb3ed8c563ae8819c36e8a3e02f1545dcc05a43` |
| `/etc/miniapp/resources/framework/js-framework.min.bin` / `D:\pendouyin\_recon\js-framework.min.bin` | `49accd22a398aed0ff41b2e04bcb785c40b17f8a2541d447d87823ce68d6c9c0` |
| `/etc/miniapp/resources/framework/jsfm-nvue.js.bin` / `D:\pendouyin\_recon\jsfm-nvue.js.bin` | `2a1ed2dc7696c4c6820cf493d7e17ea770d6637482bfeac87446a598302a6586` |

SDK `native/sdk/iot-miniapp-sdk/include/jsapis/ExtensionProxyBase.h` describes `(callbackid, params)` strings and JSON-text callbacks; it does not define or override the HTTP security/options schema above.
