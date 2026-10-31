import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeRequestJson } from '../src/services/net/native.js';

class FakeHttpClient {
  constructor(behavior) {
    this.behavior = behavior;
    this.requests = [];
    this.cancelled = 0;
    this.stopped = 0;
    this.behavior.instances.push(this);
  }
  async request(options) {
    this.requests.push(options);
    if (this.behavior.handler) return this.behavior.handler(options);
    return { statusCode: 200, body: '{"ok":true}' };
  }
  cancelAll() { this.cancelled += 1; }
  stop() { this.stopped += 1; }
}

function fakeModule(behavior) {
  const record = Object.assign({ instances: [], handler: null }, behavior || {});
  return { record, module: { HttpClient: class extends FakeHttpClient { constructor() { super(record); } } } };
}

const options = (overrides) => Object.assign({
  url: 'https://api.example/v1/chat/completions',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-synthetic-key' },
  body: '{"model":"m","messages":[]}',
  timeout: 15000,
  developmentMode: false,
}, overrides);

test('native adapter maps request/response and disables insecure HTTP outside development', async () => {
  const fake = fakeModule();
  const requestJson = createNativeRequestJson(null, async () => fake.module);
  assert.deepEqual(await requestJson(options()), { status: 200, data: '{"ok":true}' });
  const sent = fake.record.instances[0].requests[0];
  assert.equal(sent.url, 'https://api.example/v1/chat/completions');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.timeoutMs, 15000);
  assert.equal(sent.allowInsecureHttp, false);
  assert.equal(sent.headers.Authorization, 'Bearer test-synthetic-key');
  assert.equal(fake.record.instances[0].stopped, 1);
});

test('native adapter allows insecure HTTP only for explicit development mode', async () => {
  const fake = fakeModule();
  const requestJson = createNativeRequestJson(null, async () => fake.module);
  await requestJson(options({ url: 'http://192.168.1.10:8787/v1/chat/completions', developmentMode: true }));
  assert.equal(fake.record.instances[0].requests[0].allowInsecureHttp, true);
});

test('native adapter falls back exactly once when the native module is missing', async () => {
  let fallbackCalls = 0;
  const requestJson = createNativeRequestJson(async (input) => { fallbackCalls += 1; return { status: 418, data: String(input.method) }; }, async () => null);
  assert.deepEqual(await requestJson(options()), { status: 418, data: 'POST' });
  assert.equal(fallbackCalls, 1);
});

test('native adapter maps native failures and honors cancellation', async () => {
  const failure = fakeModule({ handler: async () => { const error = new Error('HTTPX_TIMEOUT'); error.code = 'HTTPX_TIMEOUT'; throw error; } });
  const timedOut = createNativeRequestJson(null, async () => failure.module);
  await assert.rejects(timedOut(options()), (error) => error.code === 'NET_TIMEOUT');

  const cancelled = fakeModule({ handler: () => new Promise(() => {}) });
  const requestJson = createNativeRequestJson(null, async () => cancelled.module);
  let cancelHandler = null;
  const cancellation = { isCancelled: () => false, onCancel: (handler) => { cancelHandler = handler; return () => { cancelHandler = null; }; } };
  const running = requestJson(options({ cancellation }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof cancelHandler, 'function');
  cancelHandler();
  assert.equal(cancelled.record.instances[0].cancelled, 1);
});

test('native adapter rejects malformed responses and non-POST calls', async () => {
  const malformed = fakeModule({ handler: async () => ({ statusCode: '200', body: 'x' }) });
  const requestJson = createNativeRequestJson(null, async () => malformed.module);
  await assert.rejects(requestJson(options()), (error) => error.code === 'NET_TRANSPORT');
  const empty = fakeModule();
  const onlyPost = createNativeRequestJson(null, async () => empty.module);
  await assert.rejects(onlyPost(options({ method: 'GET' })), (error) => error.code === 'CAPABILITY_UNAVAILABLE');
});
