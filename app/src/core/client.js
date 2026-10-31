import { fail, stableError } from './errors.js';
import { LIMITS } from './limits.js';
import { normalizeSettings, completionEndpoint, toolEnabled } from './config.js';
import { validateToolBatch, trimContext } from './context.js';
import { isObject } from './schema.js';
import { utf8Bytes, jsonBytes } from './utf8.js';
import { anthropicEndpoint, anthropicHeaders, buildAnthropicRequest, validateAnthropicResponse } from './anthropic.js';
// Reasoning is display-only; never send provider-internal fields back in a wire request.
function wireMessages(messages) {
  return messages.map(function (message) {
    const wire = { role: message.role, content: message.content };
    if (message.tool_calls) wire.tool_calls = message.tool_calls;
    if (message.tool_call_id) wire.tool_call_id = message.tool_call_id;
    return wire;
  });
}
export function validateResponse(data) {
  if (!isObject(data) || !Array.isArray(data.choices) || data.choices.length !== 1) fail('PROTOCOL_ERROR');
  const choice = data.choices[0];
  if (!isObject(choice) || !isObject(choice.message) || choice.message.role !== 'assistant') fail('PROTOCOL_ERROR');
  const message = choice.message;
  if (message.refusal != null || message.function_call != null || message.audio != null) fail('PROTOCOL_ERROR');
  let reasoning = '';
  if (typeof message.reasoning_content === 'string') reasoning = message.reasoning_content;
  else if (typeof message.reasoning === 'string') reasoning = message.reasoning;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(reasoning)) fail('PROTOCOL_ERROR');
  if (message.tool_calls != null) {
    if (choice.finish_reason !== 'tool_calls' || (message.content !== null && typeof message.content !== 'string')) fail('PROTOCOL_ERROR');
    const result = { role: 'assistant', content: message.content, tool_calls: validateToolBatch(message.tool_calls) };
    if (reasoning) result.reasoning = reasoning;
    return result;
  }
  if (choice.finish_reason === 'length') fail('LIMIT_REACHED');
  if (choice.finish_reason !== 'stop' || typeof message.content !== 'string') fail('PROTOCOL_ERROR');
  const result = { role: 'assistant', content: message.content };
  if (reasoning) result.reasoning = reasoning;
  return result;
}
// A registry is either a plain array (legacy/tests) or a function returning a
// snapshot. The function form lets the harness expose custom tools that were
// defined during the current run; it is re-resolved on every model iteration.
export async function resolveRegistry(registry) {
  const value = typeof registry === 'function' ? await registry() : registry;
  if (!Array.isArray(value)) fail('CAPABILITY_UNAVAILABLE');
  return value;
}
export function createOpenAIClient(requestJson, registry) {
  return {
    async complete(messages, input, scope, snapshot) {
      scope.check();
      const settings = normalizeSettings(input);
      if (!settings.baseUrl || !settings.model) fail('CONFIG_ERROR');
      if (typeof requestJson !== 'function') fail('CAPABILITY_UNAVAILABLE');
      const tools = snapshot === undefined ? await resolveRegistry(registry) : snapshot;
      scope.check();
      const enabledTools = tools.filter(function (tool) { return toolEnabled(settings, tool.name); });
      const useAnthropic = settings.apiFormat === 'anthropic';
      let body;
      let headers;
      let endpoint;
      if (useAnthropic) {
        const schemas = enabledTools.map(function (tool) {
          return { name: tool.name, description: tool.description, parameters: tool.parameters };
        });
        const context = trimContext(messages);
        if (settings.systemPrompt) context.unshift({ role: 'system', content: settings.systemPrompt });
        body = buildAnthropicRequest(context, settings, schemas);
        headers = anthropicHeaders(settings.apiKey);
        endpoint = anthropicEndpoint(settings);
      } else {
        const context = trimContext(messages);
        if (settings.systemPrompt) context.unshift({ role: 'system', content: settings.systemPrompt });
        body = {
          model: settings.model, messages: wireMessages(context), temperature: settings.temperature,
          max_tokens: settings.maxTokens, stream: false
        };
        const schemas = enabledTools.map(function (tool) {
          return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
        });
        if (schemas.length) body.tools = schemas;
        headers = { 'Content-Type': 'application/json' };
        if (settings.apiKey) headers.Authorization = 'Bearer ' + settings.apiKey;
        endpoint = completionEndpoint(settings);
      }
      const text = JSON.stringify(body);
      if (utf8Bytes(text) > LIMITS.requestBytes) fail('LIMIT_REACHED');
      const timeout = Math.min(LIMITS.requestMs, scope.remaining());
      let response;
      try {
        response = await scope.wait(function () {
          return requestJson({
            url: endpoint, method: 'POST', headers: headers, body: text,
            timeout: timeout, maxResponseBytes: LIMITS.responseBytes, retries: 0,
            redirect: 'error', verifyPeer: true, verifyHost: true,
            developmentMode: settings.developmentMode, cancellation: scope.cancellation
          });
        }, timeout, 'NET_TIMEOUT');
      } catch (error) { throw stableError(error, 'NET_TRANSPORT'); }
      scope.check();
      // The injected adapter must provide an explicit HTTP status; no guessed 200.
      if (!isObject(response) || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) fail('NET_TRANSPORT');
      if (response.status < 200 || response.status >= 300) fail('HTTP_ERROR');
      let data = response.data;
      if (typeof data === 'string') {
        if (utf8Bytes(data) > LIMITS.responseBytes) fail('LIMIT_REACHED');
        try { data = JSON.parse(data); } catch (_) { fail('PARSE_ERROR'); }
      } else {
        if (!isObject(data)) fail('PARSE_ERROR');
        if (jsonBytes(data) > LIMITS.responseBytes) fail('LIMIT_REACHED');
      }
      return useAnthropic ? validateAnthropicResponse(data) : validateResponse(data);
    }
  };
}
