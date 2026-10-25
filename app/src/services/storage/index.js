// Falcon storage stores JSON text unchanged. Core owns its versioned envelopes;
// ordinary probe JSON has no envelope. Native acknowledgement is not durability:
// every write is read back before the shared queue can advance.
const TIMEOUT_MS = 5000;
const MAX_BYTES = 256 * 1024;
let chain = Promise.resolve();
let unresolvedWrite = null;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function storageError() { const error = new Error('Storage operation failed.'); error.code = 'STORAGE_ERROR'; return error; }
function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function bytes(text) {
  let total = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 128) total += 1;
    else if (c < 2048) total += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { total += 4; i += 1; }
    else total += 3;
  }
  return total;
}
function validateKey(key) { if (typeof key !== 'string' || !/^[A-Za-z0-9_.-]{1,160}$/.test(key)) throw storageError(); }
function enqueue(operation) {
  const result = chain.then(operation);
  chain = result.then(() => {}, () => {});
  return result;
}
function failed(value) {
  if (value === false) return true;
  if (Array.isArray(value)) return value.some(failed);
  if (!plain(value)) return false;
  return (own(value, 'error') && value.error != null && value.error !== false && value.error !== '') || value.success === false || value.ok === false ||
    (own(value, 'status_code') && value.status_code !== 0 && value.status_code !== '0') ||
    (own(value, 'errCode') && value.errCode !== 0 && value.errCode !== '0');
}
// Kept for existing pure probe tests. Actual reads additionally verify the key,
// callback types, native failure metadata and conflicting candidate values.
export function pickStoredValue(args) {
  const first = args && args.length ? args[0] : null;
  if (typeof first === 'string') return first;
  if (!first || typeof first !== 'object') return '';
  const list = Array.isArray(first) ? first : [first];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!plain(item)) continue;
    if (typeof item.data === 'string') return item.data;
    if (typeof item.value === 'string') return item.value;
    const keys = Object.keys(item);
    for (let j = 0; j < keys.length; j += 1) if (typeof item[keys[j]] === 'string') return item[keys[j]];
  }
  return '';
}
// Device evidence: this firmware answers a missing key with exactly
// {error:3, errorMessage:"get storage failed!"} instead of a typed miss.
// Only that exact read shape maps to a miss; writes never use this path.
function notFoundRead(item) {
  if (!plain(item)) return false;
  const keys = Object.keys(item);
  return keys.length === 2 && own(item, 'error') && own(item, 'errorMessage') &&
    item.error === 3 && typeof item.errorMessage === 'string';
}
function readValue(args, key) {
  if (args.length > 1 && args.slice(1).some(value => value != null)) throw storageError();
  const first = args[0];
  if (first == null || first === '') return '';
  if (typeof first === 'string') return first;
  const list = Array.isArray(first) ? first : [first];
  const candidates = [];
  list.forEach(item => {
    if (notFoundRead(item)) { candidates.push(''); return; }
    if (!plain(item) || failed(item)) throw storageError();
    const fields = ['data', 'value', key].filter((field, index, all) => all.indexOf(field) === index && own(item, field));
    if (!fields.length && Object.keys(item).length) throw storageError();
    fields.forEach(field => {
      const value = item[field];
      if (value == null) candidates.push('');
      else if (typeof value === 'string') candidates.push(value);
      else throw storageError();
    });
  });
  if (candidates.some(value => value !== candidates[0])) throw storageError();
  return candidates.length ? candidates[0] : '';
}
function nativeCall(method, key, text) {
  return new Promise((resolve, reject) => {
    const api = typeof $falcon === 'object' && $falcon && $falcon.jsapi;
    const fn = api && api[method];
    const writing = method === 'storage.setStorage';
    if (typeof fn !== 'function' || unresolvedWrite !== null) { reject(storageError()); return; }
    let settled = false;
    const owner = {};
    if (writing) unresolvedWrite = owner;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // A timed-out native write may still complete. Fail closed until its callback
      // arrives; sending a newer write now could let the old write overwrite it.
      reject(storageError());
    }, TIMEOUT_MS);
    function finish(error, value) {
      if (writing && unresolvedWrite === owner) unresolvedWrite = null;
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(storageError()); else resolve(value);
    }
    try {
      const payload = writing ? { key: key, data: text, value: text } : { key: key };
      fn(JSON.stringify(payload), (...args) => {
        if (writing) { finish(args.some(failed), true); return; }
        if (settled) return;
        try { finish(false, readValue(args, key)); } catch (_) { finish(true); }
      });
    } catch (_) { finish(true); }
  });
}
async function callGet(key) {
  const raw = await nativeCall('storage.getStorage', key);
  if (bytes(raw) > MAX_BYTES) throw storageError();
  return raw;
}
function exactEnvelope(value) { return plain(value) && value.version === 1 && own(value, 'data') && Object.keys(value).length === 2; }
function normalizeLegacy(key, value) {
  const coreKey = key === 'pa.settings' || key === 'pa.sessions' || /^pa\.(?:session|note)\./.test(key);
  // Old adapter wrapped an already-enveloped core value once. Read it without
  // writing a migration; the next verified normal save replaces only that key.
  if (coreKey && exactEnvelope(value) && exactEnvelope(value.data)) return value.data;
  if (key === 'pa.probe' && exactEnvelope(value)) return value.data;
  return value;
}
export function getRaw(key) {
  return enqueue(async () => { validateKey(key); return callGet(key); });
}
export function setRaw(key, value, guard) {
  return enqueue(async () => {
    if (guard) guard();
    validateKey(key);
    if (typeof value !== 'string' || bytes(value) > MAX_BYTES) throw storageError();
    if (guard) guard();
    await nativeCall('storage.setStorage', key, value);
    if (await callGet(key) !== value) throw storageError();
    return true;
  });
}
export function getJson(key, fallback, validate) {
  return enqueue(async () => {
    validateKey(key);
    const raw = await callGet(key);
    if (raw === '') return fallback;
    let value;
    try {
      value = normalizeLegacy(key, JSON.parse(raw));
      if (typeof validate === 'function' && !validate(value)) throw storageError();
    } catch (_) { throw storageError(); }
    return value;
  });
}
export function setJson(key, data, guard) {
  let raw;
  try {
    raw = JSON.stringify(data);
    if (typeof raw !== 'string' || bytes(raw) > MAX_BYTES) throw storageError();
  } catch (_) { return Promise.reject(storageError()); }
  return setRaw(key, raw, guard);
}
