import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from '../../tools/mock-openai.mjs';
import { createHarness } from '../src/core/index.js';

function memory() {
  const items = new Map();
  return {
    getJson: async (key, fallback) => items.has(key) ? structuredClone(items.get(key)) : fallback,
    setJson: async (key, data) => { items.set(key, structuredClone(data)); return true; },
  };
}

test('real local HTTP model/tool/model roundtrip and settings/session restore', async () => {
  const records = [];
  const { server, counts } = createMockServer({ log: data => records.push(data) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
    const store = memory();
    const adapters = { ...store, requestJson: async options => {
      assert.equal(options.developmentMode, true);
      assert.equal(options.retries, 0);
      const response = await fetch(options.url, { method: options.method, headers: options.headers,
        body: options.body, redirect: 'error' });
      return { status: response.status, data: await response.json() };
    } };
    const harness = createHarness(adapters);
    const settings = await harness.saveSettings({ baseUrl, apiKey: 'test-synthetic-key', model: 'mock-gpt', developmentMode: true });
    const events = [];
    const result = await harness.run([{ role: 'user', content: 'synthetic-tools' }], settings, { onEvent: event => events.push(event.type) });
    assert.equal(result.status, 'completed');
    assert.equal(result.modelRequests, 2);
    assert.equal(result.toolCalls, 2);
    assert.deepEqual(result.messages.map(message => message.role), ['user', 'assistant', 'tool', 'tool', 'assistant']);
    const calculator = JSON.parse(result.messages[2].content);
    assert.equal(calculator.data.value, 20);
    assert.equal(JSON.parse(result.messages[3].content).ok, true);
    assert.equal(counts.completions, 2); assert.equal(counts.toolResponses, 1);
    assert.equal(events.filter(type => type === 'tool_result').length, 2);
    const session = harness.createSession('合成测试');
    await harness.saveSession({ ...session, messages: result.messages });
    const restored = createHarness(adapters);
    assert.equal((await restored.loadSessions())[0].messages.length, 5);
    assert.equal((await restored.loadSettings()).apiKey, '');
    const logs = JSON.stringify(records);
    for (const sentinel of ['test-synthetic-key', 'synthetic-tools', 'expression', '工具循环完成']) assert.ok(!logs.includes(sentinel));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('mock echo reports shape only, never reflects credentials or request text', async () => {
  const { server } = createMockServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1/echo', {
      method: 'POST', headers: { Authorization: 'Bearer test-synthetic-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock-gpt', messages: [{ role: 'user', content: 'SENTINEL-PRIVATE-CONTENT' }] }),
    });
    const text = await response.text(); const data = JSON.parse(text);
    assert.equal(data.authorized, true); assert.equal(data.jsonObject, true); assert.equal(data.messagesArray, true);
    assert.ok(!text.includes('SENTINEL')); assert.ok(!text.includes('test-synthetic-key'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
