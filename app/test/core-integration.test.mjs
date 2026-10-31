import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, validateHistory, LIMITS } from '../src/core/index.js';
import { requestJson } from '../src/services/net/index.js';
import { getJson, setJson, getRaw } from '../src/services/storage/index.js';

const settings = () => ({ baseUrl: 'http://127.0.0.1:8787/v1', model: 'mock-gpt', apiKey: 'test-synthetic-key', developmentMode: true });
const prompt = () => [{ role: 'user', content: 'Synthetic 中文 prompt' }];
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = calls => ({ choices: [{ finish_reason: calls ? 'tool_calls' : 'stop', message: {
  role: 'assistant', content: calls ? null : '中文完成', ...(calls ? { tool_calls: calls } : {}),
} }] });
function install(apis) {
  const previous = globalThis.$falcon;
  globalThis.$falcon = { jsapi: apis };
  return () => { if (previous === undefined) delete globalThis.$falcon; else globalThis.$falcon = previous; };
}
function storageApi() {
  const values = new Map();
  return { values, apis: {
    'storage.getStorage': (input, callback) => { const { key } = JSON.parse(input); callback([{ data: values.get(key) ?? '' }]); },
    'storage.setStorage': (input, callback) => { const { key, data, value } = JSON.parse(input); assert.equal(data, value); values.set(key, value); callback([{ [key]: value }]); },
  } };
}

test('real net adapter composes with core for a Chinese two-tool loop using one attempt per POST', async () => {
  const requests = [];
  const restore = install({ 'http.request': (input, callback) => {
    const payload = JSON.parse(input); requests.push(payload);
    assert.equal(payload.method, 'POST'); assert.equal(payload.header.Authorization, 'Bearer test-synthetic-key');
    assert.equal(payload.data.stream, false); assert.equal(payload.data.model, 'mock-gpt');
    if (requests.length === 1) {
      const schemas = payload.data.tools.map(tool => tool.function.name);
      assert.ok(schemas.includes('calculator')); assert.ok(schemas.includes('clock')); assert.ok(!schemas.includes('execShell'));
    } else {
      validateHistory(payload.data.messages);
      const results = payload.data.messages.filter(message => message.role === 'tool');
      assert.deepEqual(results.map(message => message.tool_call_id), ['calc', 'time']);
      assert.equal(JSON.parse(results[0].content).data.value, 20);
      assert.equal(typeof JSON.parse(results[1].content).data.iso, 'string');
    }
    callback({ statusCode: 200, result: JSON.stringify(response(requests.length === 1 ? [call('calc', 'calculator', { expression: '(2+3)*4' }), call('time', 'clock', {})] : null)) });
  } });
  try {
    const harness = createHarness({ requestJson });
    const result = await harness.run(prompt(), settings());
    assert.equal(result.status, 'completed'); assert.equal(result.modelRequests, 2); assert.equal(result.toolCalls, 2);
    assert.equal(requests.length, 2); assert.equal(result.messages.at(-1).content, '中文完成');
  } finally { restore(); }
});

test('real net adapter unknown HTTP status fails closed in core and production remains unavailable', async () => {
  let calls = 0;
  const restore = install({ 'http.request': (_, callback) => { calls++; callback({ result: JSON.stringify(response()) }); } });
  try {
    const harness = createHarness({ requestJson });
    const unknown = await harness.run(prompt(), settings());
    assert.equal(unknown.error.code, 'NET_TRANSPORT'); assert.equal(calls, 1); assert.deepEqual(unknown.messages, prompt());
    const production = await harness.run(prompt(), { baseUrl: 'https://api.example/v1', model: 'synthetic' });
    assert.equal(production.error.code, 'CAPABILITY_UNAVAILABLE'); assert.equal(calls, 1);
  } finally { restore(); }
});

test('real net adapter receives core cancellation and ignores a late native callback', async () => {
  let callback; let entered;
  const started = new Promise(resolve => { entered = resolve; }); const events = [];
  const restore = install({ 'http.request': (_, cb) => { callback = cb; entered(); } });
  try {
    const harness = createHarness({ requestJson });
    const running = harness.run(prompt(), settings(), { onEvent: event => events.push(event.type) });
    await started; await harness.stop();
    assert.equal((await running).status, 'cancelled'); const snapshot = events.slice();
    callback({ statusCode: 200, result: JSON.stringify(response()) });
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, snapshot);
  } finally { restore(); }
});

test('real storage adapter preserves exactly one envelope for blank settings and complete sessions', async () => {
  const store = storageApi(); const restore = install(store.apis);
  try {
    const harness = createHarness({ getJson, setJson });
    assert.equal((await harness.loadSettings()).baseUrl, '');
    await harness.saveSettings({});
    const persisted = JSON.parse(store.values.get('pa.settings'));
    assert.equal(persisted.version, 1); assert.equal(persisted.data.baseUrl, ''); assert.equal(persisted.data.version, undefined);
    const session = harness.createSession('Synthetic session'); session.messages = prompt();
    await harness.saveSession(session);
    const reloaded = createHarness({ getJson, setJson });
    assert.equal((await reloaded.loadSettings()).model, ''); assert.deepEqual(await reloaded.loadSessions(), [session]);
  } finally { restore(); }
});

for (const mode of ['cancel', 'timeout']) test('queued note write rechecks ' + mode + ' after the platform storage queue releases', async t => {
  if (mode === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
  let releaseProbe; let queued; let requests = 0; let nativeWrites = 0; let blocked;
  const writeQueued = new Promise(resolve => { queued = resolve; });
  const restore = install({
    'storage.getStorage': (input, callback) => {
      const { key } = JSON.parse(input);
      if (key === 'pa.probe') releaseProbe = () => callback([{ data: '' }]);
      else callback([{ data: '' }]);
    },
    'storage.setStorage': (_, callback) => { nativeWrites++; callback(true); },
  });
  try {
    const harness = createHarness({
      getJson: async (...args) => {
        const value = await getJson(...args);
        if (args[0] === 'pa.note.queued') blocked = getRaw('pa.probe').catch(() => {});
        return value;
      },
      setJson: (...args) => { const saving = setJson(...args); queued(); return saving; },
      requestJson: async () => ++requests === 1 ? { status: 200, data: response([call('queued-note', 'note', { op: 'create', id: 'queued', content: 'x' })]) } : { status: 200, data: response() },
    });
    const running = harness.run(prompt(), { baseUrl: 'https://api.example/v1', model: 'synthetic' });
    await writeQueued;
    assert.equal(nativeWrites, 0); assert.equal(typeof releaseProbe, 'function');
    if (mode === 'cancel') await harness.stop();
    else t.mock.timers.tick(LIMITS.toolMs);
    const result = await running;
    assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'completed');
    releaseProbe(); await blocked; await new Promise(resolve => setImmediate(resolve));
    assert.equal(nativeWrites, 0);
  } finally { restore(); }
});

test('real storage adapter corruption is not silently replaced with empty settings/history', async () => {
  const store = storageApi(); const restore = install(store.apis);
  try {
    for (const raw of ['not-json', '{"version":99,"data":{}}', '{"version":1}', '{"version":1,"data":null}']) {
      store.values.set('pa.settings', raw);
      await assert.rejects(createHarness({ getJson, setJson }).loadSettings(), { code: 'STORAGE_ERROR' });
      assert.equal(store.values.get('pa.settings'), raw);
    }
    for (const raw of ['not-json', '{"version":99,"data":{"entries":[]}}', '{"version":1,"data":false}']) {
      store.values.set('pa.sessions', raw);
      const harness = createHarness({ getJson, setJson });
      await assert.rejects(harness.loadSessions(), { code: 'STORAGE_ERROR' });
      await assert.rejects(harness.saveSession(harness.createSession()), { code: 'STORAGE_ERROR' });
      assert.equal(store.values.get('pa.sessions'), raw);
    }
  } finally { restore(); }
});
