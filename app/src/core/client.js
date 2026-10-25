import { fail, stableError } from './errors.js';
import { LIMITS } from './limits.js';
import { normalizeSettings, completionEndpoint, toolEnabled } from './config.js';
import { validateToolBatch, trimContext } from './context.js';
import { isObject } from './schema.js';
import { utf8Bytes, jsonBytes } from './utf8.js';
export function validateResponse(data) {
  if (!isObject(data) || !Array.isArray(data.choices) || data.choices.length !== 1) fail('PROTOCOL_ERROR');
  const choice = data.choices[0];
  if (!isObject(choice) || !isObject(choice.message) || choice.message.role !== 'assistant') fail('PROTOCOL_ERROR');
  const message = choice.message;
  if (message.refusal != null || message.function_call != null || message.audio != null) fail('PROTOCOL_ERROR');
  if (message.tool_calls != null) {
    if (choice.finish_reason !== 'tool_calls' || (message.content !== null && typeof message.content !== 'string')) fail('PROTOCOL_ERROR');
    return { role: 'assistant', content: message.content, tool_calls: validateToolBatch(message.tool_calls) };
  }
  if (choice.finish_reason === 'length') fail('LIMIT_REACHED');
  if (choice.finish_reason !== 'stop' || typeof message.content !== 'string') fail('PROTOCOL_ERROR');
  return { role: 'assistant', content: message.content };
}
export function createOpenAIClient(requestJson, registry) {
  return {
    async complete(messages, input, scope) {
      scope.check();
      const settings = normalizeSettings(input);
      if (!settings.baseUrl || !settings.model) fail('CONFIG_ERROR');
      if (typeof requestJson !== 'function') fail('CAPABILITY_UNAVAILABLE');
      const body = {
        model: settings.model, messages: trimContext(messages), temperature: settings.temperature,
        max_tokens: settings.maxTokens, stream: false
      };
      const schemas = registry.filter(function (tool) { return toolEnabled(settings, tool.name); }).map(function (tool) {
        return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
      });
      if (schemas.length) body.tools = schemas;
      const text = JSON.stringify(body);
      if (utf8Bytes(text) > LIMITS.requestBytes) fail('LIMIT_REACHED');
      const headers = { 'Content-Type': 'application/json' };
      if (settings.apiKey) headers.Authorization = 'Bearer ' + settings.apiKey;
      const timeout = Math.min(LIMITS.requestMs, scope.remaining());
      let response;
      try {
        response = await scope.wait(function () {
          return requestJson({
            url: completionEndpoint(settings), method: 'POST', headers: headers, body: text,
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
      return validateResponse(data);
    }
  };
}
