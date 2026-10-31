import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevRequestJson } from '../src/services/net/dev.js';

function fakeWorkspace(response, execResult) {
  const files = new Map();
  const execCalls = [];
  return {
    files: files,
    execCalls: execCalls,
    getRoot() { return '/ws'; },
    async write(path, content) { files.set('/ws/' + path, content); return { path: path, bytes: content.length }; },
    async read(path) {
      const key = '/ws/' + path;
      if (!files.has(key)) { const error = new Error('missing'); error.code = 'ARGUMENT_ERROR'; throw error; }
      const content = files.get(key);
      return { path: path, bytes: content.length, content: content };
    },
    async remove(path) { files.delete('/ws/' + path); return { path: path, removed: true }; },
    async exec(request) {
      execCalls.push(request);
      const match = /-o '([^']+)'/.exec(request.command);
      if (match && response !== undefined) files.set(match[1], response);
      return Object.assign({ code: 0, signal: null, stdout: '200', stderr: '', timedOut: false, elapsedMs: 5 }, execResult || {});
    },
  };
}

const options = (overrides) => Object.assign({
  url: 'http://127.0.0.1:8787/v1/chat/completions', method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-synthetic-key' },
  body: '{"model":"mock-gpt"}', timeout: 2000, maxResponseBytes: 1024 * 1024,
  developmentMode: true, retries: 0,
}, overrides);
const code = (expected) => (error) => error.code === expected;

test('dev curl adapter returns the real status and response body, then cleans temp files', async () => {
  const workspace = fakeWorkspace('{"choices":[]}');
  const requestJson = createDevRequestJson(workspace, async () => { throw new Error('fallback must not run'); });
  const result = await requestJson(options());
  assert.deepEqual(result, { status: 200, data: '{"choices":[]}' });
  assert.equal(workspace.files.size, 0);
  const command = workspace.execCalls[0].command;
  assert.match(command, /^\/bin\/curl /);
  assert.match(command, /-w '%\{http_code\}'/);
  assert.match(command, /--data-binary '@\/ws\/\.net\//);
  assert.match(command, /Authorization: Bearer test-synthetic-key/);
  assert.equal(workspace.execCalls[0].timeoutMs, 2000);
});

test('dev curl adapter fails closed outside explicit synthetic development traffic', async () => {
  let fallbacks = 0;
  const fallback = async () => { fallbacks += 1; return { status: 200, data: {} }; };
  const requestJson = createDevRequestJson(fakeWorkspace('{}'), fallback);
  assert.deepEqual(await requestJson(options({ developmentMode: false })), { status: 200, data: {} });
  assert.equal(fallbacks, 1);
  await assert.rejects(requestJson(options({ url: 'http://8.8.8.8/v1/chat/completions' })), code('CAPABILITY_UNAVAILABLE'));
  await assert.rejects(requestJson(options({ headers: { Authorization: 'Bearer REAL-SECRET' } })), code('CAPABILITY_UNAVAILABLE'));
  await assert.rejects(requestJson(options({ headers: { Cookie: 'a=b' } })), code('ARGUMENT_ERROR'));
  await assert.rejects(requestJson(options({ method: 'GET' })), code('CAPABILITY_UNAVAILABLE'));
  await assert.rejects(requestJson(options({ body: 'x'.repeat(2048), maxResponseBytes: 1024 })), code('LIMIT_REACHED'));
  const cancelled = { isCancelled: () => true };
  await assert.rejects(requestJson(options({ cancellation: cancelled })), code('CANCELLED'));
});

test('dev curl adapter maps missing status and cancellation to stable errors', async () => {
  const workspace = fakeWorkspace('{}', { code: 28, stdout: '' });
  workspace.exec = async (request) => { workspace.execCalls.push(request); return { code: 28, stdout: '', stderr: 'timeout', timedOut: true, signal: null, elapsedMs: 2000 }; };
  const requestJson = createDevRequestJson(workspace, async () => null);
  await assert.rejects(requestJson(options()), code('NET_TIMEOUT'));
  assert.equal(workspace.files.size, 0);

  const errorWorkspace = fakeWorkspace('{"error":true}');
  errorWorkspace.exec = async (request) => { errorWorkspace.execCalls.push(request); const match = /-o '([^']+)'/.exec(request.command); errorWorkspace.files.set(match[1], '{"error":true}'); return { code: 0, stdout: '500', stderr: '', timedOut: false, signal: null, elapsedMs: 4 }; };
  const requestError = createDevRequestJson(errorWorkspace, async () => null);
  const result = await requestError(options());
  assert.deepEqual(result, { status: 500, data: '{"error":true}' });
  assert.equal(errorWorkspace.files.size, 0);
});

