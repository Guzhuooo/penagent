import { fail, stableError } from './errors.js';
import { LIMITS } from './limits.js';
import { jsonBytes } from './utf8.js';
import { isObject } from './schema.js';
export function createStorage(getJson, setJson) {
  let chain = Promise.resolve();
  const state = { dirty: false, error: null };
  const failedWrites = Object.create(null);
  function updateState() {
    const keys = Object.keys(failedWrites);
    state.dirty = keys.length > 0;
    state.error = keys.length ? failedWrites[keys[0]] : null;
  }
  function enqueue(operation) {
    const result = chain.then(operation);
    chain = result.then(function () {}, function () {});
    return result;
  }
  async function read(key, guard, fallback) {
    if (guard) guard();
    if (typeof getJson !== 'function') fail('CAPABILITY_UNAVAILABLE');
    let stored;
    try { stored = await getJson(key, null); } catch (_) { fail('STORAGE_ERROR'); }
    if (guard) guard();
    if (stored === null) return fallback === undefined ? null : fallback;
    try {
      if (!isObject(stored) || stored.version !== 1 || !Object.prototype.hasOwnProperty.call(stored, 'data') ||
        stored.data === undefined || jsonBytes(stored) > LIMITS.storageBytes) fail('STORAGE_ERROR');
    } catch (_) { fail('STORAGE_ERROR'); }
    return stored.data;
  }
  async function write(key, value, guard) {
    if (guard) guard();
    if (typeof setJson !== 'function') fail('CAPABILITY_UNAVAILABLE');
    const stored = { version: 1, data: value };
    if (jsonBytes(stored) > LIMITS.storageBytes) fail('LIMIT_REACHED');
    try {
      const result = await setJson(key, stored, guard);
      if (guard) guard();
      if (result === false) fail('STORAGE_ERROR');
      const actual = await read(key, guard);
      if (JSON.stringify(actual) !== JSON.stringify(value)) fail('STORAGE_ERROR');
      delete failedWrites[key];
      updateState();
    } catch (error) {
      failedWrites[key] = stableError(error, 'STORAGE_ERROR').code;
      updateState();
      throw stableError(error, 'STORAGE_ERROR');
    }
  }
  return { read: read, write: write, enqueue: enqueue, state: state, flush: function () { return chain.then(function () { return Object.assign({}, state); }); } };
}
