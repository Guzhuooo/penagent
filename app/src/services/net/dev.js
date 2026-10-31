// Development-only HTTP adapter backed by the device curl binary.
//
// Why: this firmware's flat JS HTTP API returns only `{result}` with no HTTP
// status and disabled TLS verification, which the core must fail closed on.
// For explicit development mode with synthetic credentials and a private host,
// curl can provide a real status code, response bytes and a bounded timeout.
// It never runs for production settings, never accepts real-looking bearer
// tokens and never logs the request body or credentials.
import { fail, stableError } from '../../core/errors.js';
import { utf8Bytes } from '../../core/utf8.js';
import { quotePosix } from '../../core/workspace.js';

const SYNTHETIC_AUTH = /^Bearer (?:test|mock|fake)[-_][A-Za-z0-9_.-]{1,128}$/;
const MAX_TIMEOUT_MS = 30000;
const TIMEOUT_EXIT_CODE = 124;

function parseUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) fail('ARGUMENT_ERROR');
  const match = /^(https?):\/\/(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?(\/[^?#]*)?$/.exec(value);
  if (!match) fail('ARGUMENT_ERROR');
  const host = match[2].toLowerCase();
  const privateHost = host === '[::1]' || host === 'localhost' || (function () {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
    const parts = host.split('.').map(Number);
    if (parts.some((part) => part < 0 || part > 255)) return false;
    return parts[0] === 127 || parts[0] === 10 ||
      (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
  }());
  if (!privateHost) fail('CAPABILITY_UNAVAILABLE');
  return { scheme: match[1], host: host, port: match[3] ? Number(match[3]) : null };
}

function headerArgs(options) {
  const args = [];
  const headers = options.headers == null ? {} : options.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) fail('ARGUMENT_ERROR');
  Object.keys(headers).forEach(function (name) {
    const value = headers[name];
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) fail('ARGUMENT_ERROR');
    const lower = name.toLowerCase();
    if (lower === 'cookie' || lower === 'proxy-authorization') fail('ARGUMENT_ERROR');
    if (lower === 'authorization' && !SYNTHETIC_AUTH.test(value)) fail('CAPABILITY_UNAVAILABLE');
    args.push('-H', quotePosix(name + ': ' + value));
  });
  return args;
}

function requestId() {
  return 'req-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

export function createDevRequestJson(workspace, fallback) {
  if (!workspace || typeof workspace.write !== 'function' || typeof workspace.exec !== 'function' || typeof workspace.read !== 'function') fail('CAPABILITY_UNAVAILABLE');
  return async function requestJson(options) {
    if (!options || options.developmentMode !== true) return fallback(options);
    const parsed = parseUrl(options.url);
    if (options.method !== 'POST') fail('CAPABILITY_UNAVAILABLE');
    if (options.cancellation && options.cancellation.isCancelled && options.cancellation.isCancelled()) fail('CANCELLED');
    const timeout = Math.min(MAX_TIMEOUT_MS, Number.isInteger(options.timeout) ? options.timeout : 20000);
    if (timeout < 1) fail('ARGUMENT_ERROR');
    const id = requestId();
    const bodyPath = '.net/' + id + '.body';
    const responsePath = '.net/' + id + '.response';
    const absoluteResponse = workspace.getRoot ? workspace.getRoot() + '/' + responsePath : responsePath;
    const hasBody = typeof options.body === 'string';
    if (hasBody) {
      if (utf8Bytes(options.body) > (options.maxResponseBytes || 2 * 1024 * 1024)) fail('LIMIT_REACHED');
      await workspace.write(bodyPath, options.body, false);
    }
    const seconds = Math.max(1, Math.ceil(timeout / 1000));
    const parts = ['/bin/curl', '-s', '-S', '-o', quotePosix(absoluteResponse), '-w', quotePosix('%{http_code}'), '-m', String(seconds), '-X', 'POST'];
    headerArgs(options).forEach(function (item) { parts.push(item); });
    if (hasBody) parts.push('--data-binary', quotePosix('@' + (workspace.getRoot ? workspace.getRoot() : '') + '/' + bodyPath));
    parts.push(quotePosix(options.url));
    let execResult;
    try {
      execResult = await workspace.exec({ command: parts.join(' '), timeoutMs: timeout });
    } catch (error) {
      try { await workspace.remove(bodyPath); } catch (cleanup) { /* best effort */ }
      try { console.warn('[pa:devnet] exec error', { code: error && error.code, name: error && error.name, message: String(error && error.message || '').slice(0, 80) }); } catch (logging) { /* best effort */ }
      throw stableError(error, 'NET_TRANSPORT');
    }
    let status = null;
    const codeText = typeof execResult.stdout === 'string' ? execResult.stdout.trim() : '';
    if (/^[0-9]{3}$/.test(codeText)) status = Number(codeText);
    try {
      // Controlled metadata only: no URL query, body, headers or credentials.
      console.warn('[pa:devnet] curl', { status: status, bodyBytes: hasBody ? utf8Bytes(options.body) : 0,
        execCode: execResult.code, timedOut: execResult.timedOut === true, elapsedMs: execResult.elapsedMs || 0 });
    } catch (logging) { /* logging is best effort */ }
    let data = '';
    try {
      if (status !== null) {
        const response = await workspace.read(responsePath);
        data = response.content;
        if (utf8Bytes(data) > (options.maxResponseBytes || 2 * 1024 * 1024)) fail('LIMIT_REACHED');
      }
    } catch (error) {
      if (status !== null) throw stableError(error, 'PARSE_ERROR');
    } finally {
      try { await workspace.remove(responsePath); } catch (cleanup) { /* best effort */ }
      if (hasBody) { try { await workspace.remove(bodyPath); } catch (cleanup) { /* best effort */ } }
      try { await workspace.remove('.net'); } catch (cleanup) { /* best effort: directory may still be in use */ }
    }
    if (options.cancellation && options.cancellation.isCancelled && options.cancellation.isCancelled()) fail('CANCELLED');
    if (status === null) {
      if (execResult.timedOut || execResult.code === 28 || execResult.code === TIMEOUT_EXIT_CODE) fail('NET_TIMEOUT');
      fail('NET_TRANSPORT');
    }
    return { status: status, data: data };
  };
}

