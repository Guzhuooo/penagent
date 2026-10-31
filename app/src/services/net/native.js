// Secure production HTTP adapter backed by the native `httpx` JSAPI module.
//
// Contract: exactly one request per call, Promise result {status, data:string}.
// Native core enforces HTTPS unless allowInsecureHttp is true for local/private
// development hosts, verifies TLS peer + hostname, disables redirects, applies
// the caller timeout and supports cancelAll(). This adapter never silently
// falls back for a production request: if the module is missing, the caller's
// fallback (fail-closed flat adapter or dev curl) decides.
let modulePromise = null;

export function loadNativeHttpx() {
  if (!modulePromise) {
    modulePromise = Promise.resolve().then(function () { return import('httpx'); })
      .then(function (mod) { return mod && (mod.default || mod); })
      .catch(function () { return null; });
  }
  return modulePromise;
}

function errorCode(error) {
  // Native JSAPI rejects with the C++ error code: 1 invalid, 2 busy, 3 cancelled,
  // 4 timeout, 5 response too large, 6 TLS, 7 network, 8 internal, 9 invalid
  // response, 10 closed. Some SDK paths expose it as an integer code, others as
  // a message string; map both without trusting raw text for success.
  const numeric = Number(error && error.code);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 10) {
    if (numeric === 1) return 'ARGUMENT_ERROR';
    if (numeric === 2) return 'CAPABILITY_UNAVAILABLE';
    if (numeric === 3) return 'CANCELLED';
    if (numeric === 4) return 'NET_TIMEOUT';
    if (numeric === 5) return 'LIMIT_REACHED';
    if (numeric === 6) return 'TLS_ERROR';
    if (numeric === 10) return 'CAPABILITY_UNAVAILABLE';
    return 'NET_TRANSPORT';
  }
  const text = String((error && (error.code || error.message)) || '');
  if (/cancel/i.test(text)) return 'CANCELLED';
  if (/timeout/i.test(text)) return 'NET_TIMEOUT';
  if (/TLS|ssl|certificate|verify/i.test(text)) return 'TLS_ERROR';
  if (/too large|RESPONSE_TOO_LARGE/i.test(text)) return 'LIMIT_REACHED';
  return 'NET_TRANSPORT';
}

function nativeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeResult(value) {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.statusCode)) throw nativeError('NET_TRANSPORT');
  if (value.statusCode < 100 || value.statusCode > 599) throw nativeError('NET_TRANSPORT');
  const body = typeof value.body === 'string' ? value.body : '';
  return { status: value.statusCode, data: body };
}

export function createNativeRequestJson(fallback, moduleLoader) {
  const loadModule = typeof moduleLoader === 'function' ? moduleLoader : loadNativeHttpx;
  return async function requestJson(options) {
    const mod = await loadModule();
    if (!mod || typeof mod.HttpClient !== 'function') {
      if (typeof fallback === 'function') return fallback(options);
      throw nativeError('CAPABILITY_UNAVAILABLE');
    }
    if (!options || typeof options.url !== 'string') throw nativeError('ARGUMENT_ERROR');
    if (options.method !== 'POST') throw nativeError('CAPABILITY_UNAVAILABLE');
    const headers = {};
    const source = options.headers == null ? {} : options.headers;
    if (typeof source !== 'object' || Array.isArray(source)) throw nativeError('ARGUMENT_ERROR');
    Object.keys(source).forEach(function (name) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || typeof source[name] !== 'string' || /[\x00-\x1f\x7f]/.test(source[name])) throw nativeError('ARGUMENT_ERROR');
      headers[name] = source[name];
    });
    if (typeof options.body !== 'string') throw nativeError('ARGUMENT_ERROR');
    const timeoutMs = Math.max(1, Math.min(60000, Number.isInteger(options.timeout) ? options.timeout : 20000));
    const client = new mod.HttpClient();
    const cancellation = options.cancellation;
    let remove = function () {};
    function abort() {
      try { client.cancelAll(); } catch (error) { /* already stopped */ }
    }
    if (cancellation && typeof cancellation.onCancel === 'function') remove = cancellation.onCancel(abort) || function () {};
    if (cancellation && typeof cancellation.isCancelled === 'function' && cancellation.isCancelled()) {
      abort();
      throw nativeError('CANCELLED');
    }
    try {
      const result = await client.request({
        url: options.url,
        method: 'POST',
        headers: headers,
        body: options.body,
        timeoutMs: timeoutMs,
        allowInsecureHttp: options.developmentMode === true && /^http:/.test(options.url),
      });
      return normalizeResult(result);
    } catch (error) {
      if (error && (error.code === 'CANCELLED' || error.code === 'NET_TRANSPORT' || error.code === 'NET_TIMEOUT' || error.code === 'TLS_ERROR' || error.code === 'LIMIT_REACHED')) throw error;
      throw nativeError(errorCode(error));
    } finally {
      remove();
      try { client.stop(); } catch (error) { /* best effort */ }
    }
  };
}

// Development probe used by the capability page. Not part of the model loop.
export async function nativeProbe(options, moduleLoader) {
  const loadModule = typeof moduleLoader === 'function' ? moduleLoader : loadNativeHttpx;
  const mod = await loadModule();
  if (!mod || typeof mod.HttpClient !== 'function') throw nativeError('CAPABILITY_UNAVAILABLE');
  if (!options || typeof options.url !== 'string') throw nativeError('ARGUMENT_ERROR');
  const client = new mod.HttpClient();
  const timeoutMs = Math.max(1, Math.min(60000, Number.isInteger(options.timeout) ? options.timeout : 10000));
  try {
    const requestOptions = {
      url: options.url,
      method: typeof options.method === 'string' ? options.method : 'GET',
      headers: options.headers || {},
      timeoutMs: timeoutMs,
      allowInsecureHttp: options.allowInsecureHttp === true,
    };
    if (typeof options.body === 'string') requestOptions.body = options.body;
    const result = await client.request(requestOptions);
    return { status: result.statusCode, bytes: typeof result.body === 'string' ? result.body.length : -1 };
  } catch (error) {
    throw nativeError(errorCode(error));
  } finally {
    try { client.stop(); } catch (error) { /* best effort */ }
  }
}
