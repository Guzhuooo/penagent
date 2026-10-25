import { AppError, CODE } from './error.js';
import { utf8Bytes } from '../../core/utf8.js';

const DEFAULT_TIMEOUT = 20000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
let inFlight = null;

// This firmware's flat API disables TLS verification, follows redirects and omits HTTP status.
// Caller TLS/redirect/abort options are not consumed; production use must fail closed.
export const networkCapabilities = Object.freeze({
  productionReady: false, httpStatus: false, verifiedTls: false,
  redirectControl: false, physicalCancellation: false, receiveByteLimit: false,
});

function error(code) { return new AppError(code); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function localHost(host) {
  if (host === 'localhost' || host === '[::1]') return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const parts = host.split('.').map(Number);
  if (parts.some(function (part) { return part < 0 || part > 255; })) return false;
  return parts[0] === 127 || parts[0] === 10 ||
    (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}
function makePayload(opts) {
  if (!opts || typeof opts.url !== 'string' || opts.url.length > 2048 || /[\s\x00-\x1f\x7f]/.test(opts.url)) throw error('INVALID_ARGUMENT');
  const match = /^(https?):\/\/(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?(\/[^?#]*)?$/.exec(opts.url);
  if (!match || (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535))) throw error('INVALID_ARGUMENT');
  if (opts.verifyPeer === false || opts.verifyHost === false) throw error('TLS_ERROR');
  if (opts.developmentMode !== true || !localHost(match[2].toLowerCase())) throw error('CAPABILITY_UNAVAILABLE');
  const method = String(opts.method || 'GET').toUpperCase();
  if (['GET', 'POST'].indexOf(method) < 0) throw error('CAPABILITY_UNAVAILABLE');
  const timeout = opts.timeout == null ? DEFAULT_TIMEOUT : opts.timeout;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) throw error('INVALID_ARGUMENT');
  const header = { 'Accept-Encoding': 'identity' };
  Object.keys(opts.headers || {}).forEach(function (name) {
    const value = opts.headers[name];
    if (!/^[A-Za-z0-9-]+$/.test(name) || typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value) || value.length > 8192) throw error('INVALID_ARGUMENT');
    if (name.toLowerCase() === 'authorization' && value !== 'Bearer test-synthetic-key' && value !== 'Bearer probe-key-123') throw error('CAPABILITY_UNAVAILABLE');
    if (name.toLowerCase() === 'cookie' || name.toLowerCase() === 'proxy-authorization') throw error('INVALID_ARGUMENT');
    header[name] = value;
  });
  const payload = { url: opts.url, method: method, timeout: timeout, header: header, dataType: 'text', responseType: 'text' };
  if (method === 'POST') {
    let data = opts.data;
    if (opts.body != null) {
      if (opts.data != null || typeof opts.body !== 'string' || utf8Bytes(opts.body) > MAX_BODY_BYTES) throw error('INVALID_ARGUMENT');
      try { data = JSON.parse(opts.body); } catch (_) { throw error('PARSE_ERROR'); }
    }
    if (!isObject(data)) throw error('INVALID_ARGUMENT');
    let text;
    try { text = JSON.stringify(data); } catch (_) { throw error('INVALID_ARGUMENT'); }
    if (utf8Bytes(text) > MAX_BODY_BYTES) throw error('LIMIT_REACHED');
    Object.keys(header).forEach(function (name) { if (name.toLowerCase() === 'content-type') delete header[name]; });
    header['Content-Type'] = 'application/json';
    // HttpApiExtension serializes data internally; passing a JSON string double-encodes it.
    payload.data = data;
  } else if (opts.body != null || opts.data != null) throw error('INVALID_ARGUMENT');
  return payload;
}

export function normalizeBody(res) {
  let status = null;
  let text = '';
  if (isObject(res)) {
    if (Number.isInteger(res.statusCode) && res.statusCode >= 100 && res.statusCode <= 599) status = res.statusCode;
    if (typeof res.result === 'string') text = res.result;
    else if (typeof res.data === 'string') text = res.data;
    else if (typeof res.body === 'string') text = res.body;
  } else if (typeof res === 'string') text = res;
  return { status: status, text: text };
}

function requestRaw(opts) {
  return new Promise(function (resolve, reject) {
    let payload;
    try { payload = makePayload(opts); } catch (failure) { reject(failure); return; }
    const token = opts.cancellation;
    if (token && token.isCancelled()) { reject(error('CANCELLED')); return; }
    if (inFlight) { reject(error('CAPABILITY_UNAVAILABLE')); return; }
    const api = typeof $falcon !== 'undefined' && $falcon.jsapi;
    const fn = api && api['http.request'];
    if (typeof fn !== 'function') { reject(error('CAPABILITY_UNAVAILABLE')); return; }
    const owner = {};
    let settled = false;
    let timer = null;
    let remove = function () {};
    function finish(failure, value) {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      remove();
      if (failure) reject(failure); else resolve(value);
    }
    if (token) remove = token.onCancel(function () { finish(error('CANCELLED')); });
    if (settled) { remove(); return; }
    inFlight = owner;
    timer = setTimeout(function () { finish(error('NET_TIMEOUT')); }, payload.timeout);
    try {
      fn(JSON.stringify(payload), function (res) {
        if (inFlight === owner) inFlight = null;
        finish(null, res);
      });
    } catch (_) {
      if (inFlight === owner) inFlight = null;
      finish(error('NET_TRANSPORT'));
    }
    // Logical stop/timeout cannot abort native I/O. Keep the guard until its callback.
  });
}

export async function probeRequest(opts) {
  const res = await requestRaw(opts);
  const norm = normalizeBody(res);
  const max = opts.maxResponseBytes == null ? MAX_BODY_BYTES : Math.min(MAX_BODY_BYTES, opts.maxResponseBytes);
  if (!Number.isInteger(max) || max < 1) throw error('INVALID_ARGUMENT');
  if (utf8Bytes(norm.text) > max) throw error('LIMIT_REACHED');
  return norm;
}
export async function requestText(opts) {
  const norm = await probeRequest(opts);
  if (norm.status !== null && (norm.status < 200 || norm.status >= 300)) throw error('HTTP_ERROR');
  if (!norm.text) throw error('PARSE_ERROR');
  return norm.text;
}
export async function requestJson(opts) {
  const norm = await probeRequest(opts);
  if (norm.status !== null && (norm.status < 200 || norm.status >= 300)) throw error('HTTP_ERROR');
  let data;
  try { data = JSON.parse(norm.text); } catch (_) { throw error('PARSE_ERROR'); }
  return { status: norm.status, data: data };
}
export async function probeContract(opts) {
  const norm = await probeRequest(opts);
  let contract = false;
  if (opts.method === 'POST') {
    try {
      const data = JSON.parse(norm.text);
      contract = data.authorized === true && data.jsonObject === true && data.modelPresent === true && data.messagesArray === true && data.bodyBytes > 0;
    } catch (_) {}
  }
  return { status: norm.status, contract: contract };
}
export function headProbe() { return Promise.reject(error('CAPABILITY_UNAVAILABLE')); }
export { AppError, CODE };
