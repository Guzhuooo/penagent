const MESSAGES = {
  CONFIG_ERROR: 'Invalid settings.', PROTOCOL_ERROR: 'Unsupported conversation or model response.',
  ARGUMENT_ERROR: 'Invalid tool arguments.', TOOL_UNKNOWN: 'Unknown tool.', TOOL_DISABLED: 'Tool disabled.',
  TOOL_ERROR: 'Tool execution failed.', MATH_ERROR: 'Invalid arithmetic expression.',
  NET_TIMEOUT: 'Request timed out.', NET_TRANSPORT: 'Transport failed.', TLS_ERROR: 'TLS verification failed.',
  HTTP_ERROR: 'HTTP request failed.', PARSE_ERROR: 'Invalid JSON response.',
  CAPABILITY_UNAVAILABLE: 'Required adapter unavailable.', LIMIT_REACHED: 'Resource limit reached.',
  CANCELLED: 'Run cancelled.', STORAGE_ERROR: 'Storage operation failed.'
};
export class CoreError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.TOOL_ERROR);
    this.name = 'CoreError';
    this.code = Object.prototype.hasOwnProperty.call(MESSAGES, code) ? code : 'TOOL_ERROR';
  }
}
export function fail(code) { throw new CoreError(code); }
export function stableError(error, fallback) {
  return new CoreError(error && Object.prototype.hasOwnProperty.call(MESSAGES, error.code) ? error.code : fallback);
}
export function errorResult(error, fallback) {
  const safe = stableError(error, fallback || 'TOOL_ERROR');
  return JSON.stringify({ ok: false, error: { code: safe.code, message: safe.message } });
}
