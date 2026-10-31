// Anthropic Messages API translation for the harness. The internal protocol is
// OpenAI-shaped (assistant.tool_calls + role:tool results); this module converts
// to/from Anthropic content blocks without leaking provider-specific fields into
// the core loop.
import { fail } from './errors.js';
import { LIMITS } from './limits.js';
import { isObject } from './schema.js';
import { utf8Bytes } from './utf8.js';
import { validateToolBatch } from './context.js';

const ANTHROPIC_VERSION = '2023-06-01';
const TOOL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function anthropicEndpoint(settings) {
  const base = String(settings.baseUrl || '').replace(/\/+$/, '');
  if (!base) fail('CONFIG_ERROR');
  if (/\/v1$/.test(base)) return base + '/messages';
  return base + '/v1/messages';
}

export function anthropicHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION };
  if (apiKey) headers['x-api-key'] = apiKey;
  return headers;
}

function parseToolInput(text) {
  let value;
  try { value = JSON.parse(text); } catch (_) { fail('PROTOCOL_ERROR'); }
  if (!isObject(value)) fail('PROTOCOL_ERROR');
  return value;
}

// Convert validated OpenAI-shaped history into Anthropic messages. Consecutive
// same-role messages are merged; system messages become the top-level `system`.
export function buildAnthropicMessages(messages) {
  const system = [];
  const output = [];
  function add(role, blocks) {
    if (!blocks.length) return;
    const previous = output[output.length - 1];
    if (previous && previous.role === role) previous.content = previous.content.concat(blocks);
    else output.push({ role: role, content: blocks });
  }
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === 'system') {
      if (typeof message.content === 'string' && message.content) system.push(message.content);
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const blocks = [];
      if (typeof message.content === 'string' && message.content) blocks.push({ type: 'text', text: message.content });
      message.tool_calls.forEach(function (call) {
        if (!TOOL_ID.test(call.id) || !TOOL_NAME.test(call.function.name)) fail('PROTOCOL_ERROR');
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseToolInput(call.function.arguments) });
      });
      if (!blocks.length) fail('PROTOCOL_ERROR');
      add('assistant', blocks);
      continue;
    }
    if (message.role === 'assistant') {
      if (typeof message.content !== 'string') fail('PROTOCOL_ERROR');
      if (message.content) add('assistant', [{ type: 'text', text: message.content }]);
      continue;
    }
    if (message.role === 'user') {
      if (typeof message.content !== 'string') fail('PROTOCOL_ERROR');
      if (message.content) add('user', [{ type: 'text', text: message.content }]);
      continue;
    }
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || typeof message.content !== 'string') fail('PROTOCOL_ERROR');
      add('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }]);
      continue;
    }
    fail('PROTOCOL_ERROR');
  }
  if (!output.length) fail('PROTOCOL_ERROR');
  return { system: system.length ? system.join('\n\n') : '', messages: output };
}

export function buildAnthropicRequest(messages, settings, tools) {
  const translated = buildAnthropicMessages(messages);
  const body = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    temperature: Math.min(1, settings.temperature),
    messages: translated.messages,
    stream: false,
  };
  if (translated.system) body.system = translated.system;
  if (tools && tools.length) {
    body.tools = tools.map(function (tool) {
      return { name: tool.name, description: tool.description, input_schema: tool.parameters };
    });
  }
  if (utf8Bytes(JSON.stringify(body)) > LIMITS.requestBytes) fail('LIMIT_REACHED');
  return body;
}

export function validateAnthropicResponse(data) {
  if (!isObject(data) || data.type !== 'message' || data.role !== 'assistant' ||
    !Array.isArray(data.content) || typeof data.stop_reason !== 'string') fail('PROTOCOL_ERROR');
  const texts = [];
  const calls = [];
  data.content.forEach(function (block) {
    if (!isObject(block) || typeof block.type !== 'string') fail('PROTOCOL_ERROR');
    if (block.type === 'text') {
      if (typeof block.text !== 'string') fail('PROTOCOL_ERROR');
      if (block.text) texts.push(block.text);
      return;
    }
    if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || !TOOL_ID.test(block.id) || typeof block.name !== 'string' ||
        !TOOL_NAME.test(block.name) || !isObject(block.input)) fail('PROTOCOL_ERROR');
      calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
      return;
    }
    // Provider may emit extended thinking/redacted thinking blocks; they are not
    // part of the conversation protocol and are intentionally dropped.
    if (block.type === 'thinking' || block.type === 'redacted_thinking') return;
    fail('PROTOCOL_ERROR');
  });
  if (data.stop_reason === 'max_tokens') fail('LIMIT_REACHED');
  if (calls.length) {
    return { role: 'assistant', content: texts.length ? texts.join('\n') : null, tool_calls: validateToolBatch(calls) };
  }
  if (data.stop_reason !== 'end_turn' && data.stop_reason !== 'stop_sequence') fail('PROTOCOL_ERROR');
  if (!texts.length) fail('PROTOCOL_ERROR');
  return { role: 'assistant', content: texts.join('\n') };
}
