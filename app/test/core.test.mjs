import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import {
  createHarness, normalizeSettings, completionEndpoint, utf8Bytes, truncateUtf8,
  validateSchema, parseArguments, trimContext, validateHistory, LIMITS
} from '../src/core/index.js';
import { validateResponse } from '../src/core/client.js';
import { calculate } from '../src/tools/calculator.js';
import { buildExecPreset, quotePosix } from '../src/tools/exec-presets.js';
import { createToolRegistry } from '../src/tools/registry.js';
import { createRunner } from '../src/core/runner.js';
import { createStorage } from '../src/core/storage.js';
const configured = (input = {}) => ({ baseUrl: 'https://api.example/v1', model: 'synthetic-model', ...input });
function configuredHarness(adapters) {
  const harness = createHarness(adapters);
  return { ...harness, run: (messages, input, options) => harness.run(messages, configured(input), options) };
}
const user = () => [{ role: 'user', content: 'Synthetic test prompt' }];
const call = (id, name = 'clock', args = {}) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const reply = (calls, content = 'Synthetic answer') => ({ status: 200, data: { choices: [{ finish_reason: calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content: calls ? null : content, ...(calls ? { tool_calls: calls } : {}) } }] } });
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function memory() {
  const values = new Map();
  return { values, getJson: async key => clone(values.get(key) ?? null), setJson: async (key, value) => { values.set(key, clone(value)); return true; } };
}
function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const code = expected => error => error.code === expected && !error.message.includes('SENSITIVE');

test('UTF-8 counts multibyte, pairs and isolated surrogates without runtime encoding APIs', () => {
  for (const text of ['', 'ASCII', '中文', 'a😀中', '\ud800', '\udc00', 'é']) assert.equal(utf8Bytes(text), Buffer.byteLength(text));
  const shortened = truncateUtf8('😀中文'.repeat(1000), 4096);
  assert.ok(utf8Bytes(shortened) <= 4096);
  assert.ok(shortened.endsWith('[truncated]'));
  assert.ok(!/[\ud800-\udbff]$/.test(shortened.slice(0, -12)));
});

test('settings normalize endpoint, toggles, HTTPS, localhost fake keys and field boundaries', () => {
  assert.equal(completionEndpoint({ baseUrl: 'https://API.example/v1/chat/completions///' }), 'https://api.example/v1/chat/completions');
  assert.equal(normalizeSettings().persistApiKey, false);
  assert.equal(normalizeSettings().execShellEnabled, false);
  assert.equal(normalizeSettings().tools.execShell, false);
  assert.equal(completionEndpoint({ baseUrl: 'http://127.0.0.1:8900/v1/', developmentMode: true, apiKey: 'mock-key' }), 'http://127.0.0.1:8900/v1/chat/completions');
  // Device-to-host development mock cannot use adb reverse on this firmware; private LAN is the same dev-only exception.
  assert.equal(completionEndpoint({ baseUrl: 'http://<device-lan-ip>:8787/v1', developmentMode: true, apiKey: 'mock-key' }), 'http://<device-lan-ip>:8787/v1/chat/completions');
  for (const settings of [
    { baseUrl: 'http://<device-lan-ip>:8787/v1', apiKey: 'mock-key' },
    { baseUrl: 'http://<device-lan-ip>:8787/v1', developmentMode: true, apiKey: 'real-secret' },
    { baseUrl: 'http://8.8.8.8:8787/v1', developmentMode: true, apiKey: 'mock-key' },
    { baseUrl: 'http://example.com/v1' }, { baseUrl: 'https://user:pass@example.com' },
    { baseUrl: 'https://example.com?key=x' }, { baseUrl: 'https://example.com/#x' },
    { baseUrl: 'https://example.com\n' }, { baseUrl: 'https://example.com:99999' },
    { baseUrl: 'http://localhost/v1', developmentMode: true, apiKey: 'real-secret' },
    { temperature: NaN }, { maxTokens: 0 }, { tools: { nope: true } }, { allowedProbeHosts: ['*.example.com'] }
  ]) assert.throws(() => normalizeSettings(settings), code('CONFIG_ERROR'));
});

test('schema enforces every advertised constraint and rejects pollution/deep arguments', () => {
  const schema = { type: 'object', properties: {
    str: { type: 'string', minLength: 2, maxLength: 4, pattern: '^[a-z]+$' },
    num: { type: 'number', minimum: 1, maximum: 2 }, int: { type: 'integer', enum: [1, 2] },
    yes: { type: 'boolean' }, arr: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['a'] } }
  }, required: ['str', 'num', 'int', 'yes', 'arr'], additionalProperties: false };
  const valid = { str: 'abc', num: 1.5, int: 2, yes: true, arr: ['a'] };
  assert.deepEqual(validateSchema(valid, schema), valid);
  for (const bad of [{ ...valid, x: 1 }, { ...valid, str: 'A' }, { ...valid, str: 'abcde' }, { ...valid, num: 3 },
    { ...valid, int: 1.5 }, { ...valid, yes: 1 }, { ...valid, arr: [] }, { ...valid, arr: ['b'] }, { ...valid, arr: ['a', 'a', 'a'] }]) {
    assert.throws(() => validateSchema(bad, schema), code('ARGUMENT_ERROR'));
  }
  for (const raw of ['null', '[]', 'bad-json', '{"__proto__":{}}', '{"constructor":1}', '{"prototype":1}', JSON.stringify({ str: '中'.repeat(3000) })]) {
    assert.throws(() => parseArguments(raw, schema), code('ARGUMENT_ERROR'));
  }
  let deep = {}; for (let i = 0; i < 20; i++) deep = { child: deep };
  assert.throws(() => validateSchema(deep, { type: 'object', additionalProperties: true }), code('ARGUMENT_ERROR'));
});

test('calculator grammar precedence unary decimals and finite bounded arithmetic', () => {
  for (const [expression, expected] of [['2+3*4', 14], ['(2+3)*4', 20], ['-(-2)+.5', 2.5], ['1e2 / 4 % 7', 4], ['1--2', 3]]) assert.equal(calculate(expression), expected);
  for (const expression of ['1/0', '2%0', '1e101', '1e100*10', 'process.exit()', '2**3', '1 2', '()', '(1', '1)', '1+', '0x10', '('.repeat(33) + '1' + ')'.repeat(33), '-'.repeat(33) + '1', Array(130).fill('1').join('+')]) assert.throws(() => calculate(expression), code('MATH_ERROR'));
});

test('history groups validate IDs and trim oldest complete turns without mutating history', () => {
  const group = [{ role: 'assistant', content: null, tool_calls: [call('a'), call('b')] },
    { role: 'tool', tool_call_id: 'a', content: 'A' }, { role: 'tool', tool_call_id: 'b', content: 'B' }];
  const history = [{ role: 'system', content: 'Keep instructions' }, { role: 'user', content: 'old' }, ...group,
    { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'current' }];
  const snapshot = clone(history);
  assert.deepEqual(trimContext(history, { maxMessages: 4 }), [history[0], history[6]]);
  assert.deepEqual(history, snapshot);
  assert.throws(() => validateHistory(history.slice(0, 4)), code('PROTOCOL_ERROR'));
  assert.throws(() => validateHistory([...user(), ...group, ...group]), code('PROTOCOL_ERROR'));
  assert.throws(() => validateHistory([{ role: 'tool', tool_call_id: 'x', content: '' }]), code('PROTOCOL_ERROR'));
  assert.throws(() => trimContext([{ role: 'system', content: 'x' }, ...user(), ...group], { maxMessages: 4 }), code('LIMIT_REACHED'));
  assert.throws(() => trimContext([{ role: 'user', content: '中'.repeat(100) }], { maxBytes: 100 }), code('LIMIT_REACHED'));
});

test('multi-tool conversation uses injected single-attempt POST and exact atomic results', async () => {
  const store = memory(); const requests = []; const events = [];
  const harness = configuredHarness({ ...store, deviceInfo: { model: 'Y02', firmware: '4.9.7', serial: 'SENSITIVE', apiKey: 'SENSITIVE' },
    requestJson: async options => {
      requests.push(options);
      return requests.length === 1 ? reply([call('m1', 'calculator', { expression: '(2+3)*4' }), call('m2', 'device_info')]) : reply(null, '中文完成');
    }
  });
  const original = user();
  const result = await harness.run(original, { apiKey: 'SENSITIVE-KEY' }, { onEvent: event => events.push(event) });
  assert.equal(result.status, 'completed'); assert.equal(result.modelRequests, 2); assert.equal(result.toolCalls, 2);
  assert.equal(original.length, 1);
  const second = JSON.parse(requests[1].body);
  assert.deepEqual(second.messages.slice(2).map(m => m.tool_call_id), ['m1', 'm2']);
  assert.equal(JSON.parse(second.messages[2].content).data.value, 20);
  assert.ok(!JSON.stringify(second.messages).includes('SENSITIVE'));
  assert.ok(!JSON.stringify(events).includes('SENSITIVE'));
  assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].retries, 0);
  assert.equal(requests[0].headers.Authorization, 'Bearer SENSITIVE-KEY');
  assert.equal(requests[0].verifyPeer, true); assert.equal(requests[0].redirect, 'error');
  assert.equal(JSON.parse(requests[0].body).stream, false);
  assert.equal(events.filter(e => e.type === 'tool_group').length, 1);
});

test('valid IDs for unknown disabled malformed tools receive one controlled error each', async () => {
  let count = 0;
  const harness = configuredHarness({ ...memory(), requestJson: async () => ++count === 1 ? reply([
    call('u', 'unknown'), call('d', 'clock'), call('bad', 'calculator', '{'), call('fields', 'calculator', { expression: '2', extra: 1 })
  ]) : reply() });
  const result = await harness.run(user(), { tools: { clock: false } });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content).error.code), ['TOOL_UNKNOWN', 'TOOL_DISABLED', 'ARGUMENT_ERROR', 'ARGUMENT_ERROR']);
});

test('entire batch IDs are rejected before any note writes; history IDs cannot replay', async () => {
  for (const second of [call('dup'), { ...call('next'), id: '' }, { ...call('next'), type: 'other' }]) {
    const store = memory(); const writes = [];
    const harness = configuredHarness({ ...store, setJson: async (...args) => { writes.push(args); return store.setJson(...args); },
      requestJson: async () => reply([call('dup', 'note', { op: 'create', id: 'a', content: 'data' }), second]) });
    const result = await harness.run(user());
    assert.equal(result.status, 'error'); assert.equal(result.error.code, 'PROTOCOL_ERROR'); assert.equal(writes.length, 0);
  }
  const harness = configuredHarness({ ...memory(), requestJson: async () => reply([call('past', 'clock')]) });
  const result = await harness.run([...user(), { role: 'assistant', content: null, tool_calls: [call('past')] }, { role: 'tool', tool_call_id: 'past', content: 'ok' }, ...user()]);
  assert.equal(result.error.code, 'PROTOCOL_ERROR');
});

test('schemas of full batch are checked before execute; execution remains sequential', async () => {
  const registry = createToolRegistry(); const trace = []; let count = 0;
  const clock = registry.find(t => t.name === 'clock');
  clock.validate = () => trace.push('validated');
  clock.execute = async () => { trace.push('execute'); return 'ok'; };
  const runner = createRunner({ requestJson: async () => ++count === 1 ? reply([call('s1'), call('s2')]) : reply() }, registry, createStorage(...[memory().getJson, memory().setJson]));
  assert.equal((await runner.run(user(), configured())).status, 'completed');
  assert.deepEqual(trace, ['validated', 'validated', 'validated', 'execute', 'validated', 'execute']);
});

test('note CRUD semantics and invalid content do not write outside pa.note', async () => {
  const store = memory(); let count = 0;
  const harness = configuredHarness({ ...store, requestJson: async () => ++count === 1 ? reply([
    call('n1', 'note', { op: 'create', id: 'a', content: '中文' }), call('n2', 'note', { op: 'read', id: 'a' }),
    call('n3', 'note', { op: 'update', id: 'a', content: 'updated' }), call('n4', 'note', { op: 'delete', id: 'a' }),
    call('n5', 'note', { op: 'read', id: 'a' }), call('n6', 'note', { op: 'create', id: '../escape', content: 'x' }),
    call('n7', 'note', { op: 'create', id: 'big', content: '中'.repeat(700) })
  ]) : reply() });
  const result = await harness.run(user());
  assert.equal(result.status, 'completed');
  const outputs = result.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
  assert.equal(outputs[1].data.content, '中文'); assert.equal(outputs[4].data.exists, false);
  assert.equal(outputs[5].error.code, 'ARGUMENT_ERROR'); assert.equal(outputs[6].error.code, 'ARGUMENT_ERROR');
  assert.deepEqual([...store.values.keys()], ['pa.note.a']);
});

test('cancel after note read prevents write and subsequent tools/model requests', async () => {
  const gate = deferred(); const entered = deferred(); let writes = 0; let requests = 0;
  const harness = configuredHarness({ getJson: () => { entered.resolve(); return gate.promise; }, setJson: async () => { writes++; },
    requestJson: async () => { requests++; return reply([call('cancel-note', 'note', { op: 'create', id: 'a', content: 'x' }), call('cancel-next')]); } });
  const running = harness.run(user()); await entered.promise;
  const stopped = harness.stop(); assert.equal(harness.stop(), stopped); await stopped;
  gate.resolve(null);
  const result = await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.status, 'cancelled'); assert.equal(writes, 0); assert.equal(requests, 1);
  assert.equal(result.messages.length, 1); assert.equal(result.pending.assistant.tool_calls.length, 2);
});

test('cancel in-flight transport clears waits and rejects late events with idempotent stop', async () => {
  const gate = deferred(); const entered = deferred(); let cancels = 0; const events = [];
  const harness = configuredHarness({ requestJson: () => { entered.resolve(); return { promise: gate.promise, cancel: () => { cancels++; } }; } });
  const running = harness.run(user(), {}, { onEvent: event => events.push(event.type) }); await entered.promise;
  const first = harness.stop(); assert.equal(harness.stop(), first); await first;
  const result = await running; const snapshot = [...events]; gate.resolve(reply());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.status, 'cancelled'); assert.equal(cancels, 1); assert.deepEqual(events, snapshot);
  assert.equal(harness.state.status, 'cancelled');
});

test('stop immediately cancels reserved start; replacement awaits cancellation cleanup', async () => {
  let requests = 0;
  const harness = configuredHarness({ requestJson: async () => { requests++; return reply(); } });
  const running = harness.run(user()); await harness.stop();
  assert.equal((await running).status, 'cancelled'); assert.equal(requests, 0);
  const cleanup = deferred(); const entered = deferred(); const gate = deferred();
  const replacing = configuredHarness({ requestJson: () => { requests++; if (requests === 1) { entered.resolve(); return { promise: gate.promise, cancel: () => cleanup.promise }; } return Promise.resolve(reply()); } });
  const old = replacing.run(user()); await entered.promise;
  const next = replacing.run(user()); await Promise.resolve(); assert.equal(requests, 1);
  cleanup.resolve(); assert.equal((await old).status, 'cancelled'); assert.equal((await next).status, 'completed');
  gate.resolve(reply());
});

test('current permission is checked again after prior tool await', async () => {
  const gate = deferred(); const entered = deferred(); let requests = 0; let writes = 0;
  const store = memory();
  const harness = configuredHarness({ ...store, deviceInfo: async () => { entered.resolve(); return gate.promise; },
    setJson: async (key, value) => { if (key.startsWith('pa.note.')) writes++; return store.setJson(key, value); },
    requestJson: async () => ++requests === 1 ? reply([call('policy1', 'device_info'), call('policy2', 'note', { op: 'create', id: 'a', content: 'x' })]) : reply() });
  const running = harness.run(user()); await entered.promise;
  await harness.saveSettings({ tools: { note: false } }); gate.resolve({ model: 'Y02' });
  const result = await running;
  assert.equal(result.status, 'completed'); assert.equal(writes, 0);
  assert.equal(JSON.parse(result.messages.find(m => m.tool_call_id === 'policy2').content).error.code, 'TOOL_DISABLED');
});

test('6 model requests, 24 tool calls, 8 per batch and elapsed 120s are hard limits', async () => {
  let requests = 0;
  let harness = configuredHarness({ requestJson: async () => reply([call('r' + ++requests)]) });
  let result = await harness.run(user());
  assert.equal(result.status, 'limited'); assert.equal(requests, 6); assert.equal(result.modelRequests, 6);
  requests = 0;
  harness = configuredHarness({ requestJson: async () => { requests++; return reply(Array.from({ length: 8 }, (_, i) => call('b' + requests + '-' + i))); } });
  result = await harness.run(user()); assert.equal(result.status, 'limited'); assert.equal(requests, 3); assert.equal(result.toolCalls, 24);
  harness = configuredHarness({ requestJson: async () => reply(Array.from({ length: 9 }, (_, i) => call('too-' + i))) });
  result = await harness.run(user()); assert.equal(result.error.code, 'LIMIT_REACHED'); assert.equal(result.toolCalls, 0);
  let time = 0; requests = 0;
  harness = configuredHarness({ now: () => time, requestJson: async () => { requests++; time = 120001; return reply([call('late')]); } });
  result = await harness.run(user()); assert.equal(result.status, 'limited'); assert.equal(requests, 1); assert.equal(result.toolCalls, 0);
});

test('timeout settles a hanging model exactly once and invokes transport cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred(); let cancels = 0; let requests = 0;
  const harness = configuredHarness({ requestJson: () => { requests++; entered.resolve(); return { promise: new Promise(() => {}), cancel: () => { cancels++; } }; } });
  const running = harness.run(user()); await entered.promise;
  t.mock.timers.tick(LIMITS.requestMs);
  const result = await running;
  assert.equal(result.error.code, 'NET_TIMEOUT'); assert.equal(cancels, 1); assert.equal(requests, 1);
});

test('tool timeout prevents delayed write and produces one bounded error result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred(); const entered = deferred(); let writes = 0; let requests = 0;
  const store = memory();
  const harness = configuredHarness({ ...store, getJson: async key => { if (key.startsWith('pa.note.')) { entered.resolve(); return gate.promise; } return store.getJson(key); },
    setJson: async () => { writes++; return true; }, requestJson: async () => ++requests === 1 ? reply([call('timed-note', 'note', { op: 'create', id: 'a', content: 'x' })]) : reply() });
  const running = harness.run(user()); await entered.promise; t.mock.timers.tick(LIMITS.toolMs);
  const result = await running; gate.resolve(null); await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.status, 'completed'); assert.equal(writes, 0);
  assert.equal(JSON.parse(result.messages[2].content).error.code, 'NET_TIMEOUT');
});

test('POST failures never retry and never expose raw adapter messages', async () => {
  for (const response of [{ status: 429, data: {} }, { status: 503, data: {} }, { status: 200, data: '' }, { status: 200, data: 'bad SENSITIVE' }, { data: {} }, null]) {
    let requests = 0;
    const harness = configuredHarness({ requestJson: async () => { requests++; return response; } });
    const result = await harness.run(user());
    assert.equal(result.status, 'error'); assert.equal(requests, 1); assert.ok(!JSON.stringify(result.error).includes('SENSITIVE'));
  }
  for (const errorCode of ['NET_TIMEOUT', 'NET_TRANSPORT', 'TLS_ERROR']) {
    let requests = 0;
    const harness = configuredHarness({ requestJson: async () => { requests++; throw { code: errorCode, message: 'SENSITIVE' }; } });
    assert.equal((await harness.run(user())).error.code, errorCode); assert.equal(requests, 1);
  }
});

test('response envelope unsupported content and finish reason rejected; UTF8 response byte bound', async () => {
  for (const data of [{}, { choices: [] }, { choices: [{ message: { role: 'user', content: 'x' }, finish_reason: 'stop' }] },
    { choices: [{ message: { role: 'assistant', content: [] }, finish_reason: 'stop' }] },
    { choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'stop' }] },
    { choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'content_filter' }] }]) assert.throws(() => validateResponse(data), code('PROTOCOL_ERROR'));
  const harness = configuredHarness({ requestJson: async () => reply(null, '中'.repeat(710000)) });
  assert.equal((await harness.run(user())).error.code, 'LIMIT_REACHED');
});

test('tool result truncates by UTF8 and API key never enters execution context', async () => {
  const registry = createToolRegistry(); let count = 0; let context;
  registry.find(tool => tool.name === 'clock').execute = async (_, ctx) => { context = ctx; return '中😀'.repeat(2000); };
  const runner = createRunner({ requestJson: async () => ++count === 1 ? reply([call('big-result')]) : reply() }, registry, createStorage(memory().getJson, memory().setJson));
  const result = await runner.run(user(), configured({ apiKey: 'SENSITIVE' }));
  assert.equal(result.status, 'completed'); assert.ok(utf8Bytes(result.messages[2].content) <= 4096);
  assert.ok(result.messages[2].content.endsWith('[truncated]'));
  assert.equal(context.apiKey, undefined); assert.equal(context.settings, undefined); assert.equal(context.requestJson, undefined);
  assert.ok(!JSON.stringify(context).includes('SENSITIVE'));
});

test('HEAD allowlist and fixed exec presets enforce exact params and shell quoting', async () => {
  assert.equal(quotePosix("a'b"), "'a'\\''b'");
  const preset = buildExecPreset({ commandId: 'head_probe', params: { url: 'https://allowed.example/path' } }, ['allowed.example']);
  assert.equal(preset.executable, 'curl'); assert.ok(preset.argv.includes('--')); assert.ok(!preset.argv.includes('-k'));
  for (const args of [
    { commandId: 'system_arch', params: {}, command: 'uname;id' },
    { commandId: 'free', params: {} }, { commandId: 'system_arch', params: { url: 'x' } },
    { commandId: 'head_probe', params: { url: 'https://evil.example/' } },
    { commandId: 'head_probe', params: { url: 'https://allowed.example/;uname' } },
    { commandId: 'head_probe', params: { url: 'http://allowed.example/' } },
    { commandId: 'head_probe', params: { url: 'https://allowed.example:443/' } },
    { commandId: 'head_probe', params: { url: 'https://allowed.example/', headers: {} } }
  ]) assert.throws(() => buildExecPreset(args, ['allowed.example']), code('ARGUMENT_ERROR'));
  const seen = []; let requests = 0;
  const execPreset = async (preset, cancellation) => { seen.push(preset); assert.equal(cancellation.isCancelled(), false); return { exitCode: 0, stdout: 'SENSITIVE' }; };
  execPreset.supportsCancellation = true; execPreset.supportsTimeout = true;
  const harness = configuredHarness({ ...memory(), execPreset, headProbe: async options => { seen.push(options); return { status: 204, body: 'SENSITIVE' }; },
    requestJson: async () => ++requests === 1 ? reply([call('head', 'net_probe', { url: 'https://allowed.example/' }), call('exec', 'execShell', { commandId: 'system_arch', params: {} })]) : reply() });
  const result = await harness.run(user(), { apiKey: 'SENSITIVE', allowedProbeHosts: ['allowed.example'], tools: { execShell: true }, execShellEnabled: true });
  assert.equal(result.status, 'completed'); assert.equal(seen.length, 2);
  assert.ok(!JSON.stringify(seen).includes('SENSITIVE')); assert.ok(!JSON.stringify(result.messages).includes('SENSITIVE'));
  assert.equal(seen[0].method, 'HEAD'); assert.equal(seen[0].redirect, 'error');
});

test('exec defaults off and blocking adapters cannot execute even with user toggle', async () => {
  for (const settings of [{}, { tools: { execShell: true }, execShellEnabled: true }]) {
    let count = 0; let executions = 0;
    const harness = configuredHarness({ execPreset: () => { executions++; return true; }, requestJson: async () => ++count === 1 ? reply([call('exec-off', 'execShell', { commandId: 'device_time', params: {} })]) : reply() });
    const result = await harness.run(user(), settings);
    assert.equal(executions, 0);
    assert.equal(JSON.parse(result.messages[2].content).error.code, settings.execShellEnabled ? 'CAPABILITY_UNAVAILABLE' : 'TOOL_DISABLED');
  }
});

test('settings optional key persistence clears old key readback; queue survives failure', async () => {
  const store = memory(); let failOnce = false; const order = [];
  const harness = configuredHarness({ ...store, setJson: async (key, value) => { order.push(value.data.model); if (failOnce) { failOnce = false; throw new Error('SENSITIVE'); } return store.setJson(key, value); } });
  await harness.saveSettings({ apiKey: 'SENSITIVE' });
  assert.equal(store.values.get('pa.settings').data.apiKey, undefined);
  assert.equal((await harness.loadSettings()).apiKey, 'SENSITIVE');
  assert.equal((await configuredHarness(store).loadSettings()).apiKey, '');
  await harness.saveSettings({ apiKey: 'SENSITIVE', persistApiKey: true });
  assert.equal((await configuredHarness(store).loadSettings()).apiKey, 'SENSITIVE');
  await harness.saveSettings({ apiKey: '', persistApiKey: false });
  assert.equal(store.values.get('pa.settings').data.apiKey, undefined);
  failOnce = true;
  await assert.rejects(harness.saveSettings({ model: 'first' }), code('STORAGE_ERROR'));
  assert.equal(harness.storageState.dirty, true);
  await Promise.all([harness.saveSettings({ model: 'second' }), harness.saveSettings({ model: 'third' })]);
  assert.equal((await harness.loadSettings()).model, 'third'); assert.deepEqual(order.slice(-3), ['first', 'second', 'third']);
  assert.equal((await harness.flush()).dirty, false);
});

test('damaged versioned storage and false success/readback mismatch fail explicitly', async () => {
  for (const stored of [{ version: 99, data: {} }, 'damaged', { version: 1 }, { version: 1, data: { temperature: -1 } }]) {
    const harness = configuredHarness({ getJson: async () => stored, setJson: async () => true });
    await assert.rejects(harness.loadSettings());
  }
  const harness = configuredHarness({ getJson: async () => null, setJson: async () => true });
  await assert.rejects(harness.saveSettings({}), code('STORAGE_ERROR'));
  assert.equal(harness.storageState.dirty, true);
});

test('chunked sessions snapshot queued input and recover old committed revision after interrupted write', async () => {
  const store = memory(); let failKey = null;
  const harness = configuredHarness({ ...store, setJson: async (key, value) => { if (key === failKey) throw new Error('failure'); return store.setJson(key, value); } });
  const session = harness.createSession('Synthetic session'); session.messages = [{ role: 'user', content: '中文'.repeat(15000) }];
  await harness.saveSession(session);
  assert.deepEqual((await harness.loadSessions())[0], session);
  const old = clone(session);
  session.messages.push({ role: 'assistant', content: 'new' }); session.updatedAt++;
  failKey = 'pa.sessions'; await assert.rejects(harness.saveSession(session), code('STORAGE_ERROR'));
  assert.deepEqual((await harness.loadSessions())[0], old);
  failKey = null;
  const saved = harness.saveSession(session); session.messages.push({ role: 'user', content: 'mutation' });
  await saved;
  assert.equal((await harness.loadSessions())[0].messages.length, 2);
  const index = store.values.get('pa.sessions'); assert.ok(index.data.entries[0].chunks > 1);
  for (const value of store.values.values()) assert.ok(Buffer.byteLength(JSON.stringify(value)) <= LIMITS.storageBytes);
  const stale = { ...old, updatedAt: old.updatedAt };
  await assert.rejects(harness.saveSession(stale), code('STORAGE_ERROR'));
});

test('timed-out tool invokes cancellation hooks before continuing the model loop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0; let cancels = 0;
  const entered = deferred(); const cleanup = deferred();
  const harness = configuredHarness({ headProbe: (_, cancellation) => {
    cancellation.onCancel(() => { cancels++; return cleanup.promise; });
    entered.resolve(); return new Promise(() => {});
  }, requestJson: async () => ++requests === 1 ? reply([call('timeout-head', 'net_probe', { url: 'https://allowed.example/' })]) : reply() });
  const running = harness.run(user(), { allowedProbeHosts: ['allowed.example'] });
  await entered.promise; t.mock.timers.tick(LIMITS.toolMs);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(cancels, 1); assert.equal(requests, 1);
  cleanup.resolve(); assert.equal((await running).status, 'completed'); assert.equal(requests, 2);
});

test('replacement run waits for timeout cleanup even after first run has settled', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred(); const cleanup = deferred(); let requests = 0;
  const harness = configuredHarness({ requestJson: () => {
    requests++; if (requests === 1) { entered.resolve(); return { promise: new Promise(() => {}), cancel: () => cleanup.promise }; }
    return Promise.resolve(reply());
  } });
  const running = harness.run(user()); await entered.promise; t.mock.timers.tick(LIMITS.requestMs);
  assert.equal((await running).error.code, 'NET_TIMEOUT');
  const next = harness.run(user()); await Promise.resolve(); assert.equal(requests, 1);
  cleanup.resolve(); assert.equal((await next).status, 'completed'); assert.equal(requests, 2);
});

test('session capacity refuses excess history without deleting committed sessions', async () => {
  const store = memory(); const harness = configuredHarness(store);
  for (let i = 0; i < LIMITS.sessions; i++) await harness.saveSession(harness.createSession('Session ' + i));
  await assert.rejects(harness.saveSession(harness.createSession('Excess')), code('LIMIT_REACHED'));
  assert.equal((await harness.loadSessions()).length, LIMITS.sessions);
});

test('blank defaults load/save and partial settings remain editable, but sending fails CONFIG_ERROR before transport', async () => {
  const store = memory(); let requests = 0;
  const harness = createHarness({ ...store, requestJson: async () => { requests++; return reply(); } });
  assert.equal(normalizeSettings().baseUrl, ''); assert.equal(normalizeSettings().model, '');
  assert.throws(() => completionEndpoint({}), code('CONFIG_ERROR'));
  for (const settings of [{}, { baseUrl: 'https://api.example/v1' }, { model: 'synthetic-model' }]) {
    const saved = await harness.saveSettings(settings);
    assert.deepEqual(await harness.loadSettings(), saved);
    const result = await harness.run(user());
    assert.equal(result.status, 'error'); assert.equal(result.error.code, 'CONFIG_ERROR');
    assert.deepEqual(result.messages, user()); assert.equal(result.modelRequests, 0);
  }
  assert.equal(requests, 0);
});

test('client passes explicit development mode and shared cancellation signal to requestJson', async () => {
  let options; const entered = deferred(); let cancels = 0;
  const harness = createHarness({ requestJson: input => {
    options = input; entered.resolve();
    assert.equal(input.cancellation.isCancelled(), false);
    input.cancellation.onCancel(() => { cancels++; });
    return new Promise(() => {});
  } });
  const running = harness.run(user(), { baseUrl: 'http://127.0.0.1:8787/v1', model: 'mock-gpt', apiKey: 'test-key', developmentMode: true });
  await entered.promise;
  assert.equal(options.developmentMode, true); assert.equal(options.retries, 0);
  await harness.stop(); assert.equal((await running).status, 'cancelled'); assert.equal(cancels, 1);
  assert.equal(options.cancellation.isCancelled(), true);
});

test('actual HTTP status is mandatory even for valid parsed JSON and unknown status fails closed', async () => {
  for (const status of [null, undefined, 0, '200', 99, 600, 200.5]) {
    let requests = 0;
    const harness = configuredHarness({ requestJson: async () => { requests++; return { status, data: reply().data }; } });
    const result = await harness.run(user());
    assert.equal(result.error.code, 'NET_TRANSPORT'); assert.equal(requests, 1); assert.deepEqual(result.messages, user());
  }
});

test('signal-only transport timeout starts cleanup before replacement can send', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred(); const cleanup = deferred(); let cancels = 0; let requests = 0;
  const harness = configuredHarness({ requestJson: options => {
    requests++;
    if (requests > 1) return reply();
    entered.resolve();
    if (options.cancellation) options.cancellation.onCancel(() => { cancels++; return cleanup.promise; });
    return new Promise(() => {});
  } });
  const running = harness.run(user()); await entered.promise; t.mock.timers.tick(LIMITS.requestMs);
  const result = await running;
  assert.equal(result.error.code, 'NET_TIMEOUT'); assert.equal(cancels, 1);
  const next = harness.run(user()); await Promise.resolve(); assert.equal(requests, 1);
  cleanup.resolve(); assert.equal((await next).status, 'completed'); assert.equal(requests, 2);
});

test('run snapshots caller history before awaiting start or previous cleanup', async () => {
  const requests = [];
  const harness = configuredHarness({ requestJson: async options => { requests.push(JSON.parse(options.body)); return reply(); } });
  const messages = user(); const original = clone(messages);
  const running = harness.run(messages);
  messages[0].content = 'mutated after run'; messages.push({ role: 'user', content: 'extra' });
  const result = await running;
  assert.deepEqual(requests[0].messages, original); assert.deepEqual(result.messages.slice(0, -1), original);
});

test('cancelled reserved start returns a complete detached result', async () => {
  const harness = configuredHarness({ requestJson: async () => reply() });
  const messages = user(); const running = harness.run(messages); await harness.stop();
  const result = await running;
  assert.equal(result.status, 'cancelled'); assert.equal(result.modelRequests, 0); assert.equal(result.toolCalls, 0);
  assert.notEqual(result.messages, messages); assert.deepEqual(result.messages, messages);
});

test('corrupt settings/index/chunks reject with controlled storage errors instead of becoming empty history', async () => {
  for (const data of [null, false, 0, '', []]) {
    const store = memory(); store.values.set('pa.settings', { version: 1, data });
    await assert.rejects(createHarness(store).loadSettings(), code('STORAGE_ERROR'));
  }
  for (const data of [null, false, 0, '', []]) {
    const store = memory(); store.values.set('pa.sessions', { version: 1, data });
    const harness = createHarness(store);
    await assert.rejects(harness.loadSessions(), code('STORAGE_ERROR'));
    await assert.rejects(harness.saveSession(harness.createSession()), code('STORAGE_ERROR'));
    assert.deepEqual(store.values.get('pa.sessions'), { version: 1, data });
  }
  const store = memory();
  store.values.set('pa.sessions', { version: 1, data: { entries: [{ id: 'bad', slot: 0, revision: 1, chunks: 1, bytes: 4 }] } });
  store.values.set('pa.session.bad.0.0', { version: 1, data: { revision: 1, text: 'null' } });
  await assert.rejects(createHarness(store).loadSessions(), code('STORAGE_ERROR'));
});

test('failed settings save retains retryable memory settings, and stale reads cannot replace newer settings', async () => {
  const store = memory(); let fail = false;
  const harness = createHarness({ ...store, setJson: async (...args) => {
    if (fail) throw new Error('SENSITIVE'); return store.setJson(...args);
  } });
  await harness.saveSettings(configured({ model: 'old' })); fail = true;
  await assert.rejects(harness.saveSettings(configured({ model: 'retry-me' })), code('STORAGE_ERROR'));
  assert.equal((await harness.loadSettings()).model, 'retry-me');
  fail = false; await harness.saveSettings(await harness.loadSettings());
  assert.equal((await createHarness(store).loadSettings()).model, 'retry-me');
  const gate = deferred(); const entered = deferred(); let wait = true;
  const racing = createHarness({ ...store, getJson: async key => {
    if (key === 'pa.settings' && wait) { wait = false; const old = await store.getJson(key); entered.resolve(); await gate.promise; return old; }
    return store.getJson(key);
  } });
  const reading = racing.loadSettings(); await entered.promise;
  const saving = racing.saveSettings(configured({ model: 'newer' })); gate.resolve();
  await reading; await saving;
  assert.equal((await racing.loadSettings()).model, 'newer');
});

test('failed write dirty state is not cleared by an unrelated successful write', async () => {
  const store = memory(); let failing = true;
  const storage = createStorage(store.getJson, async (key, value) => key === 'pa.settings' && failing ? false : store.setJson(key, value));
  await assert.rejects(storage.write('pa.settings', { model: 'retry' }), code('STORAGE_ERROR'));
  await storage.write('pa.note.ok', { content: 'ok' });
  assert.equal((await storage.flush()).dirty, true);
  failing = false; await storage.write('pa.settings', { model: 'retry' });
  assert.deepEqual(await storage.flush(), { dirty: false, error: null });
});

test('cancel during synchronous adapter entry still cancels its subsequently returned transport handle once', async () => {
  let cancels = 0; const cleanup = deferred(); let harness;
  harness = configuredHarness({ requestJson: () => {
    harness.stop();
    return { promise: new Promise(() => {}), cancel: () => { cancels++; return cleanup.promise; } };
  } });
  const result = await harness.run(user()); assert.equal(result.status, 'cancelled'); assert.equal(cancels, 1);
  let stopped = false; const stopping = harness.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false); cleanup.resolve(); await stopping;
});

test('stop while timed-out tool cleanup is pending invokes each cancellation handler once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cleanup = deferred(); const entered = deferred(); let cancels = 0;
  const harness = configuredHarness({ headProbe: (_, cancellation) => {
    cancellation.onCancel(() => { cancels++; return cleanup.promise; });
    entered.resolve(); return new Promise(() => {});
  }, requestJson: async () => reply([call('cleanup-once', 'net_probe', { url: 'https://allowed.example/' })]) });
  const running = harness.run(user(), { allowedProbeHosts: ['allowed.example'] });
  await entered.promise; t.mock.timers.tick(LIMITS.toolMs); await Promise.resolve(); await Promise.resolve();
  assert.equal(cancels, 1); const stopping = harness.stop(); assert.equal(cancels, 1);
  cleanup.resolve(); await stopping; assert.equal((await running).status, 'cancelled');
});

test('partial tool group never enters sendable history; cancellation preserves completed executions as pending only', async () => {
  const gate = deferred(); const entered = deferred(); let requests = 0; let writes = 0; const store = memory();
  const harness = configuredHarness({ ...store, deviceInfo: () => { entered.resolve(); return gate.promise; },
    setJson: (...args) => { writes++; return store.setJson(...args); }, requestJson: async () => {
      requests++; return reply([call('done', 'calculator', { expression: '2+3' }), call('blocked', 'device_info'), call('never', 'note', { op: 'create', id: 'a', content: 'x' })]);
    } });
  const running = harness.run(user()); await entered.promise; await harness.stop(); const result = await running;
  assert.equal(result.status, 'cancelled'); assert.deepEqual(result.messages, user()); validateHistory(result.messages);
  assert.deepEqual(result.pending.results.map(item => item.tool_call_id), ['done']);
  assert.equal(result.pending.executions[0].status, 'completed'); assert.equal(result.toolCalls, 2);
  gate.resolve({ model: 'Y02' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1); assert.equal(writes, 0);
});

test('over-remaining tool batches fail before execution, and error results consume the 24-call budget', async () => {
  let requests = 0; let executed = 0; const registry = createToolRegistry();
  registry.find(tool => tool.name === 'clock').execute = async () => { executed++; return 'ok'; };
  const runner = createRunner({ requestJson: async () => {
    requests++; const count = requests <= 3 ? 7 : 4;
    return reply(Array.from({ length: count }, (_, i) => call('rem-' + requests + '-' + i)));
  } }, registry, null);
  const result = await runner.run(user(), configured());
  assert.equal(result.status, 'limited'); assert.equal(result.toolCalls, 21); assert.equal(executed, 21); assert.equal(requests, 4);
  validateHistory(result.messages); assert.equal(result.pending, null);
  requests = 0;
  const harness = configuredHarness({ requestJson: async () => reply(Array.from({ length: 8 }, (_, i) => call('err-' + requests + '-' + i, 'unknown-' + (++requests)))) });
  const limited = await harness.run(user());
  assert.equal(limited.status, 'limited'); assert.equal(limited.toolCalls, 24); assert.equal(limited.modelRequests, 3);
});

test('aggregate and per-session limits refuse excess bytes before any chunk write', async () => {
  const store = memory(); let writes = 0;
  const harness = createHarness({ ...store, setJson: (...args) => { writes++; return store.setJson(...args); } });
  const oversized = harness.createSession(); oversized.messages = [{ role: 'user', content: 'x'.repeat(LIMITS.sessionBytes) }];
  assert.throws(() => harness.saveSession(oversized), code('LIMIT_REACHED')); assert.equal(writes, 0);
  for (let i = 0; i < 4; i++) {
    const session = harness.createSession('Large ' + i); session.messages = [{ role: 'user', content: 'x'.repeat(900000) }]; await harness.saveSession(session);
  }
  const before = writes; const excess = harness.createSession(); excess.messages = [{ role: 'user', content: 'x'.repeat(900000) }];
  await assert.rejects(harness.saveSession(excess), code('LIMIT_REACHED')); assert.equal(writes, before);
  assert.equal((await harness.loadSessions()).length, 4);
});

test('cancelled partial note group IDs cannot replay on the same runner without a persistence hook', async () => {
  const store = memory(); const blocked = deferred(); const entered = deferred(); let noteWrites = 0;
  const harness = configuredHarness({ ...store, setJson: (...args) => { if (args[0].startsWith('pa.note.')) noteWrites++; return store.setJson(...args); },
    deviceInfo: () => { entered.resolve(); return blocked.promise; }, requestJson: async () => reply([
      call('side-effect', 'note', { op: 'delete', id: 'a' }), call('cancelled-tail', 'device_info')
    ]) });
  const running = harness.run(user()); await entered.promise; await harness.stop(); const cancelled = await running;
  assert.equal(noteWrites, 1); assert.deepEqual(cancelled.messages, user());
  assert.deepEqual(cancelled.usedToolIds, ['side-effect', 'cancelled-tail']);
  const replay = await harness.run(cancelled.messages);
  assert.equal(replay.error.code, 'PROTOCOL_ERROR'); assert.equal(noteWrites, 1); assert.equal(replay.toolCalls, 0);
  blocked.resolve({ model: 'Y02' });
});

test('an explicit empty seed without a durable hook cannot bypass the same-runner cancelled ledger', async () => {
  const harness = configuredHarness({ requestJson: async () => reply([call('no-hook-id')]) });
  const first = await harness.run(user(), {}, { usedToolIds: [] }); assert.equal(first.toolCalls, 1);
  const second = await harness.run(user(), {}, { usedToolIds: [] });
  assert.equal(second.error.code, 'PROTOCOL_ERROR'); assert.equal(second.toolCalls, 0);
});

test('beforeToolBatch must durably reserve the entire batch before first execute and never enters model context', async () => {
  const store = memory(); const saved = deferred(); const entered = deferred(); let noteWrites = 0; let requests = 0;
  const events = []; const messages = [];
  const harness = configuredHarness({ ...store, setJson: (...args) => { if (args[0].startsWith('pa.note.')) noteWrites++; return store.setJson(...args); },
    requestJson: async options => { messages.push(JSON.parse(options.body).messages); return ++requests === 1 ? reply([call('reserve-note', 'note', { op: 'create', id: 'a', content: 'x' }), call('reserve-time')]) : reply(); } });
  const running = harness.run(user(), {}, { usedToolIds: ['previous-id'], onEvent: event => events.push(event), beforeToolBatch: async message => {
    assert.deepEqual(message.tool_calls.map(item => item.id), ['reserve-note', 'reserve-time']); entered.resolve(); await saved.promise;
  } });
  await entered.promise; assert.equal(noteWrites, 0); assert.equal(requests, 1); saved.resolve();
  const result = await running; assert.equal(result.status, 'completed'); assert.equal(noteWrites, 1);
  assert.deepEqual(result.usedToolIds, ['previous-id', 'reserve-note', 'reserve-time']);
  assert.deepEqual(events.find(event => event.type === 'tool_batch').usedToolIds, result.usedToolIds);
  assert.ok(!JSON.stringify(messages).includes('previous-id'));
});

test('batch reservation save failure fails closed, returns reserved IDs and does not expose raw errors', async () => {
  let writes = 0;
  const harness = configuredHarness({ ...memory(), setJson: async () => { writes++; return true; }, requestJson: async () => reply([call('save-failed', 'note', { op: 'delete', id: 'a' })]) });
  const result = await harness.run(user(), {}, { beforeToolBatch: async () => { throw new Error('SENSITIVE'); } });
  assert.equal(result.status, 'error'); assert.equal(result.error.code, 'STORAGE_ERROR'); assert.equal(result.toolCalls, 0); assert.equal(writes, 0);
  assert.deepEqual(result.usedToolIds, ['save-failed']); assert.deepEqual(result.messages, user()); assert.ok(!JSON.stringify(result.error).includes('SENSITIVE'));
});

test('cancellation while reserving a tool batch never executes even after the save resolves', async () => {
  const gate = deferred(); const entered = deferred(); let writes = 0;
  const harness = configuredHarness({ ...memory(), setJson: async () => { writes++; return true; }, requestJson: async () => reply([call('cancel-saving', 'note', { op: 'delete', id: 'a' })]) });
  const running = harness.run(user(), {}, { beforeToolBatch: async () => { entered.resolve(); await gate.promise; } });
  await entered.promise; await harness.stop(); const result = await running;
  assert.equal(result.status, 'cancelled'); assert.equal(writes, 0); assert.equal(result.toolCalls, 0); assert.deepEqual(result.usedToolIds, ['cancel-saving']);
  gate.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(writes, 0);
});

test('session audit survives reload and seeds replay protection while coexisting with complete history IDs', async () => {
  const store = memory(); let writes = 0; let requests = 0;
  const persisted = createHarness(store); const session = persisted.createSession();
  session.messages = [...user(), { role: 'assistant', content: null, tool_calls: [call('past')] }, { role: 'tool', tool_call_id: 'past', content: 'ok' }, ...user()];
  session.toolAudit = [{ id: 'past', name: 'clock', status: 'completed', result: 'ok' }, { id: 'unknown-outcome', name: 'note', status: 'started' }];
  await persisted.saveSession(session); session.toolAudit[1].status = 'cancelled';
  const loaded = (await createHarness(store).loadSessions())[0];
  assert.equal(loaded.toolAudit[1].status, 'started');
  const harness = configuredHarness({ ...store, setJson: async () => { writes++; return true; }, requestJson: async () => { requests++; return reply([call('fresh'), call('unknown-outcome', 'note', { op: 'delete', id: 'a' })]); } });
  const result = await harness.run(loaded.messages, {}, { usedToolIds: loaded.toolAudit.map(entry => entry.id) });
  assert.equal(requests, 1); assert.equal(result.error.code, 'PROTOCOL_ERROR'); assert.equal(result.toolCalls, 0); assert.equal(writes, 0);
  assert.deepEqual(result.usedToolIds, ['past', 'unknown-outcome']);
});

test('strict bounded tool audit rejects duplicate IDs, unknown statuses, arguments and oversized results', async () => {
  const harness = createHarness(memory());
  const valid = { id: 'id', name: 'note', status: 'reserved' };
  for (const audit of [null, {}, [{ ...valid, args: '{}' }], [{ ...valid, status: 'unknown' }], [{ ...valid, id: '' }], [{ ...valid, name: '../x' }],
    [valid, valid], [{ ...valid, result: '中'.repeat(1400) }], [{ ...valid, result: 1 }]]) {
    const session = harness.createSession(); session.toolAudit = audit;
    assert.throws(() => harness.saveSession(session), code('STORAGE_ERROR'));
  }
  const session = harness.createSession(); session.toolAudit = Array.from({ length: 257 }, (_, i) => ({ ...valid, id: 'audit-' + i }));
  assert.throws(() => harness.saveSession(session), code('LIMIT_REACHED'));
  for (const status of ['reserved', 'started', 'completed', 'error', 'cancelled']) {
    session.toolAudit = [{ ...valid, status }]; await harness.saveSession(session); assert.deepEqual((await harness.loadSessions())[0].toolAudit, session.toolAudit);
  }
});

test('ledger seed validates before transport, snapshots IDs, and refuses whole batches beyond 256 without evicting IDs', async () => {
  let requests = 0; let saves = 0;
  const harness = configuredHarness({ requestJson: async () => { requests++; return reply([call('new-id')]); } });
  for (const usedToolIds of [null, {}, ['bad/id'], ['x', 'x'], Array.from({ length: 257 }, (_, i) => 'i-' + i)]) {
    const result = await harness.run(user(), {}, { usedToolIds }); assert.equal(result.status === 'error' || result.status === 'limited', true);
  }
  assert.equal(requests, 0);
  const seed = Array.from({ length: 256 }, (_, i) => 'i-' + i);
  const result = await harness.run(user(), {}, { usedToolIds: seed, beforeToolBatch: async () => { saves++; } });
  assert.equal(result.status, 'limited'); assert.equal(result.toolCalls, 0); assert.equal(saves, 0); assert.deepEqual(result.usedToolIds, seed);
  const empty = []; const running = harness.run(user(), {}, { usedToolIds: empty }); empty.push('new-id');
  // A valid seed is copied synchronously; caller mutation cannot reject this fresh batch.
  const snapshot = await running; assert.equal(snapshot.toolCalls, 1);
});

test('session saves cannot silently erase or rename reserved audit IDs, even with a newer timestamp', async () => {
  const harness = createHarness(memory()); const session = harness.createSession();
  session.toolAudit = [{ id: 'keep', name: 'note', status: 'reserved' }]; await harness.saveSession(session);
  const stale = { ...session, updatedAt: session.updatedAt + 1 }; delete stale.toolAudit;
  await assert.rejects(harness.saveSession(stale), code('STORAGE_ERROR'));
  await assert.rejects(harness.saveSession({ ...stale, toolAudit: [] }), code('STORAGE_ERROR'));
  await assert.rejects(harness.saveSession({ ...stale, toolAudit: [{ id: 'keep', name: 'clock', status: 'cancelled' }] }), code('STORAGE_ERROR'));
  assert.deepEqual((await harness.loadSessions())[0].toolAudit, session.toolAudit);
});

test('reservation hook false fails closed and mutating its snapshot cannot change executable tool arguments', async () => {
  let requests = 0; let writes = 0;
  const store = memory(); const harness = configuredHarness({ ...store,
    setJson: (...args) => { writes++; return store.setJson(...args); },
    requestJson: async () => ++requests === 1 ? reply([call('immutable', 'note', { op: 'create', id: 'safe', content: 'ok' })]) : reply() });
  const result = await harness.run(user(), {}, { usedToolIds: [], beforeToolBatch: async message => {
    message.tool_calls[0].function.arguments = '{"op":"delete","id":"unsafe"}';
    message.tool_calls[0].id = 'mutated';
  } });
  assert.equal(result.status, 'completed'); assert.equal(writes, 1); assert.ok(store.values.has('pa.note.safe'));
  assert.equal(result.messages[1].tool_calls[0].id, 'immutable');
  requests = 0;
  const failed = await harness.run(user(), {}, { usedToolIds: [], beforeToolBatch: async () => false });
  assert.equal(failed.error.code, 'STORAGE_ERROR'); assert.equal(failed.toolCalls, 0); assert.equal(writes, 1);
});

test('all runtime sources remain pure and avoid unsupported encoding/dynamic execution/platform imports', async () => {
  for (const directory of [new URL('../src/core/', import.meta.url), new URL('../src/tools/', import.meta.url)]) {
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.js')) continue;
      const source = await readFile(new URL(name, directory), 'utf8');
      assert.ok(!/\b(?:TextEncoder|Buffer|eval|console)\b|new\s+Function|\$falcon|from\s+['"](?:node:|.*services|.*pages)|import\s*\(/.test(source), name);
    }
  }
});
