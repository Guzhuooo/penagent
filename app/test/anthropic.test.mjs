import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIClient } from '../src/core/client.js';
import { anthropicEndpoint, buildAnthropicRequest, validateAnthropicResponse } from '../src/core/anthropic.js';

const settings = (overrides) => Object.assign({
  baseUrl: 'https://api.example', apiKey: 'test-key', model: 'deepseek-v4.1-flash',
  temperature: 0.7, maxTokens: 256, persistApiKey: false, execShellEnabled: false,
  developmentMode: false, apiFormat: 'anthropic', tools: {},
}, overrides);

const scope = () => ({
  check() {},
  remaining() { return 5000; },
  cancellation: { isCancelled() { return false; }, onCancel() { return () => {}; } },
  wait(task) { return task(); },
});

const message = (content) => ({ role: 'assistant', content });

test('anthropic endpoint accepts root or /v1', () => {
  assert.equal(anthropicEndpoint(settings({ baseUrl: 'https://api.example' })), 'https://api.example/v1/messages');
  assert.equal(anthropicEndpoint(settings({ baseUrl: 'https://api.example/v1' })), 'https://api.example/v1/messages');
});

test('anthropic request maps system, tools and history tool calls', () => {
  const body = buildAnthropicRequest([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'time?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'clock', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true,"data":{"iso":"x"}}' },
  ], settings(), [{ name: 'clock', description: 'time', parameters: { type: 'object', properties: {}, required: [] } }]);
  assert.equal(body.system, 'be brief');
  assert.equal(body.model, 'deepseek-v4.1-flash');
  assert.equal(body.messages[0].role, 'user');
  assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'time?' }]);
  assert.equal(body.messages[1].role, 'assistant');
  assert.equal(body.messages[1].content[0].type, 'tool_use');
  assert.equal(body.messages[1].content[0].name, 'clock');
  assert.equal(body.messages[2].role, 'user');
  assert.equal(body.messages[2].content[0].type, 'tool_result');
  assert.equal(body.messages[2].content[0].tool_use_id, 'call_1');
  assert.deepEqual(body.tools[0].input_schema, { type: 'object', properties: {}, required: [] });
});

test('anthropic response drops thinking, maps text and tool_use', () => {
  const tool = validateAnthropicResponse({
    type: 'message', role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 'call_2', name: 'clock', input: {} }],
  });
  assert.equal(tool.content, null);
  assert.equal(tool.tool_calls[0].function.name, 'clock');
  const text = validateAnthropicResponse({
    type: 'message', role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'OK' }],
  });
  assert.equal(text.content, 'OK');
  assert.equal(text.tool_calls, undefined);
});

test('anthropic client uses x-api-key, /v1/messages and real status', async () => {
  let captured;
  const client = createOpenAIClient(async (options) => {
    captured = options;
    return { status: 200, data: JSON.stringify({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'pong' }] }) };
  }, [{ name: 'clock', description: 'time', parameters: { type: 'object', properties: {} } }]);
  const result = await client.complete([{ role: 'user', content: 'ping' }], settings(), scope());
  assert.equal(result.content, 'pong');
  assert.equal(captured.url, 'https://api.example/v1/messages');
  assert.equal(captured.headers['x-api-key'], 'test-key');
  assert.equal(captured.headers.Authorization, undefined);
  assert.equal(captured.headers['anthropic-version'], '2023-06-01');
  assert.equal(JSON.parse(captured.body).tools[0].name, 'clock');
});

test('anthropic client maps HTTP, max_tokens and malformed responses', async () => {
  const respond = (status, data) => createOpenAIClient(async () => ({ status, data }), []);
  await assert.rejects(respond(401, '{"error":1}').complete([{ role: 'user', content: 'x' }], settings(), scope()), (error) => error.code === 'HTTP_ERROR');
  await assert.rejects(respond(200, JSON.stringify({ type: 'message', role: 'assistant', stop_reason: 'max_tokens', content: [] }))
    .complete([{ role: 'user', content: 'x' }], settings(), scope()), (error) => error.code === 'LIMIT_REACHED');
  await assert.rejects(respond(200, JSON.stringify({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'unknown' }] }))
    .complete([{ role: 'user', content: 'x' }], settings(), scope()), (error) => error.code === 'PROTOCOL_ERROR');
});
