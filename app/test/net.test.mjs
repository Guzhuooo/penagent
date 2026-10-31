import assert from 'node:assert/strict';
import test from 'node:test';
import { requestJson, probeRequest, normalizeBody, networkCapabilities } from '../src/services/net/index.js';

const options = () => ({
  url: 'http://127.0.0.1:8787/v1/echo', method: 'POST', developmentMode: true,
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-synthetic-key' },
  body: JSON.stringify({ ping: '中文𐍈' }), timeout: 100,
});
function api(fn) { globalThis.$falcon = { jsapi: { 'http.request': fn } }; }
function cancellation() {
  let stopped = false; const handlers = [];
  return {
    isCancelled: () => stopped,
    onCancel(fn) { handlers.push(fn); return () => { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); }; },
    stop() { stopped = true; handlers.slice().forEach(fn => fn()); },
    get size() { return handlers.length; },
  };
}

test('POST uses flat JSON envelope, singular header and object data exactly once', async () => {
  let calls = 0;
  api((text, cb) => {
    calls++;
    const payload = JSON.parse(text);
    assert.equal(payload.method, 'POST');
    assert.deepEqual(payload.data, { ping: '中文𐍈' });
    assert.equal(payload.header.Authorization, 'Bearer test-synthetic-key');
    assert.equal(payload.header['Accept-Encoding'], 'identity');
    assert.equal(payload.body, undefined); assert.equal(payload.headers, undefined);
    assert.equal(payload.url, options().url);
    cb({ statusCode: 201, result: '{"message":"中文回答𐍈"}' });
  });
  assert.deepEqual(await requestJson(options()), { status: 201, data: { message: '中文回答𐍈' } });
  assert.equal(calls, 1);
});

test('missing HTTP status remains unknown, business status is not HTTP status', () => {
  assert.deepEqual(normalizeBody({ result: '中文', status_code: 0 }), { status: null, text: '中文' });
  assert.equal(normalizeBody({ statusCode: 999, result: '{}' }).status, null);
  assert.equal(normalizeBody({ statusCode: 403, result: '{}' }).status, 403);
});

test('parse and transport failures send one POST and never log body/key/URL', async () => {
  const output = []; const oldWarn = console.warn;
  console.warn = (...args) => output.push(JSON.stringify(args));
  try {
    for (const mode of ['parse', 'throw', 'empty', 'http']) {
      let calls = 0;
      api((_, cb) => { calls++; if (mode === 'throw') throw new Error('SENSITIVE-TRANSPORT');
        cb({ statusCode: mode === 'http' ? 503 : 200, result: mode === 'empty' ? '' : 'SENSITIVE-BODY' }); });
      await assert.rejects(requestJson(options()));
      assert.equal(calls, 1);
    }
    assert.ok(!output.join('').includes('SENSITIVE'));
    assert.ok(!output.join('').includes('test-synthetic-key'));
    assert.ok(!output.join('').includes('/v1/echo'));
  } finally { console.warn = oldWarn; }
});

test('UTF-8 response byte limit accepts Chinese and bounds bytes, not code units', async () => {
  api((_, cb) => cb({ statusCode: 200, result: '中中' }));
  const opts = { ...options(), maxResponseBytes: 5 };
  await assert.rejects(probeRequest(opts), { code: 'LIMIT_REACHED' });
});

test('unsafe endpoints and credentials are rejected before native invocation', async () => {
  let calls = 0; api(() => calls++);
  for (const change of [
    { url: 'http://example.com/v1' }, { url: 'http://127.0.0.1.evil/v1' },
    { url: 'http://user:pass@127.0.0.1/v1' }, { url: 'http://127.0.0.1/v1?key=secret' },
    { url: 'http://127.0.0.1/v1#x' }, { url: 'http://127.0.0.1/v1\n' },
    { headers: { Authorization: 'Bearer real-key' } }, { headers: { 'X-Test': 'x\r\ny' } },
    { body: '"string body"' }, { body: 'invalid json' }, { verifyPeer: false },
  ]) await assert.rejects(probeRequest({ ...options(), ...change }));
  await assert.rejects(requestJson({ ...options(), developmentMode: false, url: 'https://api.example/v1' }), { code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(calls, 0);
  assert.equal(networkCapabilities.productionReady, false);
});

test('cancel drops late callbacks, removes subscriptions and prevents another physical request', async () => {
  let callback; let calls = 0; const token = cancellation();
  api((_, cb) => { calls++; callback = cb; });
  const pending = requestJson({ ...options(), cancellation: token });
  token.stop();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(token.size, 0);
  await assert.rejects(requestJson(options()), { code: 'CAPABILITY_UNAVAILABLE' });
  callback({ statusCode: 200, result: '{}' });
  api((_, cb) => { calls++; cb({ statusCode: 200, result: '{}' }); });
  await requestJson(options());
  assert.equal(calls, 2);
});

test('timeout is logical, no retry; native callback releases the in-flight guard', async () => {
  let callback; let calls = 0;
  api((_, cb) => { calls++; callback = cb; });
  await assert.rejects(requestJson({ ...options(), timeout: 5 }), { code: 'NET_TIMEOUT' });
  assert.equal(calls, 1);
  callback({ result: '{}' });
  api((_, cb) => cb({ result: '{"ok":true}' }));
  assert.deepEqual(await requestJson(options()), { status: null, data: { ok: true } });
});
