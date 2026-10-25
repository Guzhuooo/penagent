# Pure JavaScript harness API

Import `createHarness` from `app/src/core/index.js`. Runtime modules use ECMAScript supported by QuickJS 20200705, without Node, DOM, TextEncoder, Buffer, dynamic code execution, or platform globals. Node tests do not establish device compatibility.

```js
const harness = createHarness({ requestJson, getJson, setJson, deviceInfo, execPreset, headProbe });
const settings = await harness.loadSettings(); // baseUrl/model start empty; open settings first
// Save user-supplied baseUrl/model before sending; blank/partial settings may be saved.
const session = harness.createSession('Conversation');
session.messages.push({ role: 'user', content: 'What time is it?' });
session.toolAudit = session.toolAudit || [];
const result = await harness.run(session.messages, settings, {
  usedToolIds: session.toolAudit.map(entry => entry.id),
  beforeToolBatch: async message => {
    session.toolAudit = session.toolAudit.concat(message.tool_calls.map(call => ({
      id: call.id, name: call.function.name, status: 'reserved'
    })));
    session.updatedAt = Date.now();
    await harness.saveSession(session); // Failure prevents every tool in this batch.
  },
  onEvent: event => {} // Update local audit status/results without logging event content.
});
session.messages = result.messages;
session.updatedAt = Date.now();
await harness.saveSession(session);
await harness.stop();
```

## Exports and UI methods

- `createHarness(adapters)` returns `loadSettings()`, `saveSettings(settings)`, `loadSessions()`, `saveSession(session)`, `createSession(title?)`, `run(messages, settings?, {onEvent, usedToolIds, beforeToolBatch}?)`, `stop()`, `flush()`, `state`, and `storageState`.
- `run` resolves `{status, messages, pending, usedToolIds, modelRequests, toolCalls, error}`. Status is `completed`, `cancelled`, `limited`, or `error`; controlled error is `{code,message}`. It snapshots and validates protocol history; the original messages are not mutated. Complete groups enter `messages` atomically. An interrupted group is returned separately as `pending: {assistant, results, executions}`. Never merge pending into sendable history or replay its tools.
- `state` is the current run's observable plain object: `status`, `runId`, `modelRequests`, `toolCalls`, `error`, `pending`. Initial status is `idle`; an active run is `loading`. It contains no settings or API key. Events are `started`, `request`, `message`, `tool_batch`, `tool_started`, `tool_result`, `tool_group`, and terminal `error`/`limited`. Successful completion is represented by the final `message` event and resolved result. Cancelled runs suppress stale UI events. Events include conversation/tool content for UI use; **never log them**.
- `stop()` invalidates ownership synchronously, clears owned waits, and awaits registered adapter cancellation cleanup; repeated calls return the same cleanup promise. New runs await cleanup. Adapters without physical cancellation remain logically cancelled; an already-issued remote request or storage write cannot be undone.
- `saveSettings` validates, snapshots, serializes, and verifies readback. API key stays in memory unless `persistApiKey:true`. Switching it off rewrites and reads back a value without `apiKey`. The UI must obtain informed consent to plaintext storage before setting that flag. Failed saves retain in-memory settings for retry.
- `createSession` returns `{id,title,createdAt,updatedAt,messages:[]}`. Set `updatedAt` when modifying a session. Saving uses two alternating chunk slots and commits the index last; interrupted writes do not replace the indexed complete revision. Indexed history is capped at 32 sessions, 1 MiB per session, and 4 MiB aggregate; capacity fails explicitly without deleting history. This is not a physical storage quota: failed index commits can leave unindexed chunks, and the two slots retain earlier chunks. Automatic garbage collection is not implemented. Context trimming only changes the sending view.
- Session `toolAudit` is local-only metadata: up to 256 unique `{id,name,status,result?}` entries. Allowed statuses are `reserved`, `started`, `completed`, `error`, and `cancelled`; result is at most 4096 UTF-8 bytes. No arguments or extra fields are stored in this ledger. Saves cannot remove or rename an old ID. Never evict IDs to continue a full session; start a new session instead. Unknown/interrupted effects are not automatically replayed.
- Before any tool side effect, `beforeToolBatch(assistantMessage)` must durably save the entire batch's reservations. Rejecting/returning false fails `STORAGE_ERROR`; cancellation while saving prevents execution even if the save later succeeds. Always pass the complete session audit IDs in `usedToolIds`, including cancelled/error/reserved entries. Audit/history overlap is allowed, but a new model response cannot reuse any reserved ID. Without both a session seed and persistence hook, a bounded same-runner memory ledger is the fallback; it does not provide crash/restart protection. `tool_batch` and the resolved result expose `usedToolIds`. Audit entries never enter model context.
- `storageState` contains `dirty` and controlled `error`; a successful unrelated write does not clear another key's failed write. `flush()` waits for queued storage work and returns this state. Missing adapters, damaged envelopes, unsupported storage versions, and readback failures reject with stable errors. The queue remains usable after failure.
- Additional named exports: `normalizeSettings`, `completionEndpoint`, `DEFAULT_SETTINGS`, `CoreError`, `LIMITS`, `utf8Bytes`, `truncateUtf8`, `validateSchema`, `parseArguments`, `validateHistory`, `trimContext`, `createSession`. Lower-level client, runner, registry, calculator and preset helpers are exported in their respective modules.

## Adapter contracts

`requestJson(options)` performs **exactly one HTTP attempt**, with no retry below this boundary. Options contain `url`, `method:'POST'`, `headers`, serialized JSON `body`, `timeout`, `maxResponseBytes`, `retries:0`, `redirect:'error'`, `verifyPeer:true`, `verifyHost:true`, `developmentMode`, and the run's `cancellation` signal (`isCancelled()`, `onCancel(handler)` returning unsubscribe). Resolve `{status: actualIntegerStatusOrNull, data: parsedJson}`. Unknown status stays `null` at the net boundary and fails closed with `NET_TRANSPORT` in core, even with valid JSON. JSON text is also accepted for injected compatibility adapters. For physical cancellation, return `{promise, cancel()}`; cancellation may return a cleanup promise. Outstanding signal hooks are invoked on run exit; adapters must unsubscribe completed work. The platform net service currently permits only synthetic development traffic; production fails `CAPABILITY_UNAVAILABLE`. Matching firmware binary evidence shows disabled TLS peer/hostname verification, enabled redirects, missing returned HTTP status, ignored caller timeout/TLS/redirect controls and no abort. A separately verified secure adapter is required; a successful JSON POST probe cannot enable this implementation for production. Response limits are checked after resolution as a fallback: adapters should limit reception earlier. The core sends non-streaming chat completions with no automatic retry.

`getJson(key, fallback)` resolves the exact stored envelope or the supplied fallback (`null` for core) on a genuine miss. `setJson(key, envelope, guard?)` persists that envelope and resolves after completion (`false` indicates failure). When supplied, `guard()` must be rechecked after adapter queue waits and immediately before native writes, so a cancelled/expired queued tool cannot begin a later side effect. Already-issued native writes remain irreversible; ordinary settings/session persistence has no tool cancellation guard. Envelopes are `{version:1,data}`; these functions must preserve them unchanged. The platform storage service serializes JSON unchanged, so ordinary probe JSON also remains supported. It reads the known old double core envelopes and old `pa.probe` wrapper without modifying storage; a subsequent verified save writes the new single representation. No silent fallback for corrupt data is allowed. Core writes and read/modify/write note operations share a serial queue and readback verification; the platform adapter additionally serializes reads/writes with 5-second native waits and per-write readback. A timed-out native write blocks subsequent storage operations until its late acknowledgement arrives, preventing older writes from overwriting newer values; it cannot be physically cancelled. A deleted note uses a versioned `data:null` tombstone.

`deviceInfo` is a profile object or an async function returning one. Only `profile_id`, `model`, `firmware`, selected runtime/ABI fields, and logical screen dimensions reach tools; serial, IP, credentials, arbitrary profile fields, and raw adapter output are excluded.

`headProbe({url,method:'HEAD',timeout,redirect:'error',verifyPeer:true,verifyHost:true}, cancellation)` resolves `{status}`. It must honor timeout, reject redirects, download no body, and send no credentials. URL must use HTTPS, default port, and an exact host in `allowedProbeHosts` (no wildcard or model-controlled allowlist).

`execPreset(preset,cancellation)` is opt-in: the function must have `supportsCancellation === true` and `supportsTimeout === true`. Preset contains `commandId`, validated `params`, fixed `executable`, `argv`, individually POSIX-quoted `shell`, and `timeout`. Prefer executable/argv. Resolve boolean or `{exitCode}`; stdout is never inferred or returned. A blocking synchronous shell adapter cannot advertise these capabilities. `cancellation` supports `isCancelled()` and `onCancel(handler)`, returning an unsubscribe function. Adapters must honor deadlines and check cancellation before side effects following their own awaits.

An optional `now()` adapter supplies the wall clock for deterministic deadline tests; it defaults to `Date.now`.

## Settings, tools, and limits

Settings: `baseUrl:''`, `apiKey:''`, `model:''`, `temperature` (0–2), `maxTokens` (1–32768), `persistApiKey:false`, `execShellEnabled:false`, `developmentMode:false`, `tools` (name→boolean), and `allowedProbeHosts:[]`. Blank/partial settings can be loaded and saved; sending without either baseUrl or model resolves `CONFIG_ERROR` before any transport attempt, retaining validated input history. API root is normalized before `/chat/completions` is appended. HTTPS is required; explicit development mode permits localhost HTTP with an empty key or a `mock-`, `test-`, or `fake-` key. Queries, fragments, userinfo, and control characters are rejected.

Tool schemas are defined once in `tools/registry.js` and used for both requests and validation. Tools execute sequentially. All call envelopes/IDs and all arguments are validated before the first tool executes; invalid IDs reject the whole batch. Valid IDs with unknown/disabled tools or malformed arguments get one structured error result. IDs are unique throughout supplied protocol history and the current run. Supported schema subset: object, array, string, number, integer, boolean; properties, required, enum, minimum/maximum, string min/maxLength/pattern, array min/maxItems/items, and additionalProperties. Unknown fields and prototype pollution keys are rejected.

- `clock({})`: UTC ISO time and timezone offset.
- `calculator({expression})`: +, -, *, /, %, unary signs, decimal/exponent numbers and parentheses. Max 512 characters, 256 tokens, 32 nested parentheses/unary levels, magnitude 1e100. No code evaluation.
- `note({op,id,content?})`: create/read/update/delete; ID `[A-Za-z0-9_-]` up to 64 characters; content only for create/update, at most 2048 UTF-8 bytes; keys only `pa.note.*`.
- `device_info({})`: filtered profile.
- `net_probe({url})`: allowlisted HTTPS HEAD, at most 6 seconds.
- `execShell({commandId,params})`: `head_probe` with exactly `{url}`, `system_arch` or `device_time` with exactly `{}`; disabled by default and rechecked before execution.

Central limits: 6 model requests, 24 tool calls including error results, 8 calls per batch, 120 seconds per run, 20 seconds per model request, 10 seconds per tool; 2 MiB each request/response, 8 KiB arguments, 4 KiB tool results with `[truncated]` marker; 100 context messages and 256 KiB context. System messages and the entire current turn are retained; oldest complete turns are removed from the sending view. A retained turn that exceeds a limit fails explicitly. Budget exhaustion sends no extra summary request.

Core errors and tool errors contain controlled codes/messages, never raw adapter exceptions. API keys enter only configuration/storage (when opted in) and the model request Authorization header; tool context does not contain settings, the key, request transport, or logs. No runtime logging is performed.

Run verification without changing package scripts:

```sh
node --test D:/penagent/app/test/core.test.mjs D:/penagent/app/test/storage.test.mjs D:/penagent/app/test/core-integration.test.mjs
```
