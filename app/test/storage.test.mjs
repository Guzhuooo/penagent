import test from 'node:test';
import assert from 'node:assert/strict';
import { getRaw, setRaw, getJson, setJson, pickStoredValue } from '../src/services/storage/index.js';
const envelope = data => ({ version: 1, data });
const clone = value => JSON.parse(JSON.stringify(value));
function install(overrides = {}) {
  const previous = globalThis.$falcon; const values = new Map(); const trace = [];
  const apis = {
    'storage.getStorage': (input, callback) => { const { key } = JSON.parse(input); trace.push('get:' + key); callback([{ data: values.get(key) ?? '' }]); },
    'storage.setStorage': (input, callback) => { const { key, data, value } = JSON.parse(input); assert.equal(data, value); trace.push('set:' + key); values.set(key, value); callback([{ [key]: value }]); },
    ...overrides,
  };
  globalThis.$falcon = { jsapi: apis };
  return { values, trace, apis, restore: () => { if (previous === undefined) delete globalThis.$falcon; else globalThis.$falcon = previous; } };
}
const storageError = error => error.code === 'STORAGE_ERROR' && !error.message.includes('SENSITIVE');

test('ordinary probe JSON and core envelopes round-trip without adding a wrapper; inputs snapshot before queue', async () => {
  const mock = install();
  try {
    const stamp = { time: 123, ok: true }; await setJson('pa.probe', stamp);
    assert.deepEqual(JSON.parse(mock.values.get('pa.probe')), stamp); assert.deepEqual(await getJson('pa.probe', null), stamp);
    const settings = envelope({ model: '', baseUrl: '' }); const expected = clone(settings);
    const writing = setJson('pa.settings', settings); settings.data.model = 'mutated'; await writing;
    assert.deepEqual(JSON.parse(mock.values.get('pa.settings')), expected); assert.deepEqual(await getJson('pa.settings', null), expected);
    await setJson('pa.note.deleted', envelope(null)); assert.deepEqual(await getJson('pa.note.deleted', null), envelope(null));
  } finally { mock.restore(); }
});

test('documented get callback strings, object/array wrappers, keyed entries and empty misses normalize', async () => {
  let result;
  const mock = install({ 'storage.getStorage': (_, callback) => callback(result) });
  try {
    const raw = JSON.stringify(envelope({ content: '中文𐍈' }));
    for (const value of [raw, { data: raw }, { value: raw }, { 'pa.note.a': raw }, [{ data: raw }], [{ value: raw }], [{ 'pa.note.a': raw }]]) {
      result = value; assert.deepEqual(await getJson('pa.note.a', null), envelope({ content: '中文𐍈' }));
    }
    const fallback = { missing: true };
    for (const value of [undefined, null, '', [], {}, [{ data: '' }], [{ value: '' }], [{ 'pa.note.a': '' }]]) {
      result = value; assert.equal(await getJson('pa.note.a', fallback), fallback);
    }
    // Device-observed miss shape: this firmware reports a missing key as a read error.
    for (const value of [{ error: 3, errorMessage: 'get storage failed!' }, [{ error: 3, errorMessage: 'get storage failed!' }]]) {
      result = value; assert.equal(await getJson('pa.settings', fallback), fallback); assert.equal(await getRaw('pa.settings'), '');
    }
    assert.equal(pickStoredValue([{ 'pa.key': 'v' }]), 'v');
  } finally { mock.restore(); }
});

test('corrupt JSON, invalid callback types, failure metadata and ambiguous data reject instead of fallback', async () => {
  let result;
  const mock = install({ 'storage.getStorage': (_, callback) => callback(result) });
  try {
    for (const value of ['SENSITIVE bad JSON', 42, false, { data: 42 }, { error: 'SENSITIVE' }, { success: false },
      { status_code: 1, data: '{}' }, { data: '{}', value: '[]' }, [{ data: '{}' }, { data: '[]' }], { other: '{}' },
      { error: 3 }, { error: 4, errorMessage: 'get storage failed!' }, { error: 3, errorMessage: 'get storage failed!', data: 'x' }]) {
      result = value; await assert.rejects(getJson('pa.settings', null), storageError);
    }
    result = '{"value":1}'; await assert.rejects(getJson('pa.probe', null, () => false), storageError);
  } finally { mock.restore(); }
});

test('legacy double core envelopes and old probe wrappers remain readable without destructive migration', async () => {
  const mock = install();
  try {
    const inner = envelope({ model: 'kept' }); const legacy = JSON.stringify(envelope(inner));
    mock.values.set('pa.settings', legacy);
    assert.deepEqual(await getJson('pa.settings', null), inner); assert.equal(mock.values.get('pa.settings'), legacy);
    mock.values.set('pa.note.old', JSON.stringify(envelope(envelope({ content: '中文' }))));
    assert.deepEqual(await getJson('pa.note.old', null), envelope({ content: '中文' }));
    mock.values.set('pa.probe', JSON.stringify(envelope({ stamp: 123 })));
    assert.deepEqual(await getJson('pa.probe', null), { stamp: 123 });
    mock.values.set('ordinary', JSON.stringify(envelope(inner)));
    assert.deepEqual(await getJson('ordinary', null), envelope(inner));
  } finally { mock.restore(); }
});

test('reads wait for queued verified writes, preserve write order and queue survives readback failure', async () => {
  const mock = install(); let callback; let writes = 0;
  mock.apis['storage.setStorage'] = (input, done) => {
    const { key, value } = JSON.parse(input); writes++;
    if (writes === 1) callback = () => { mock.values.set(key, value); done([{ [key]: value }]); };
    else { mock.values.set(key, value); done([{ [key]: value }]); }
  };
  try {
    const first = setJson('pa.probe', { n: 1 }); const reading = getJson('pa.probe', null); const second = setJson('pa.probe', { n: 2 });
    await Promise.resolve(); assert.equal(writes, 1); assert.equal(mock.trace.length, 0);
    callback(); assert.equal(await first, true); assert.deepEqual(await reading, { n: 1 }); await second;
    assert.deepEqual(await getJson('pa.probe', null), { n: 2 });
    mock.apis['storage.setStorage'] = (_, done) => done(true);
    await assert.rejects(setJson('pa.probe', { n: 3 }), storageError);
    mock.apis['storage.setStorage'] = (input, done) => { const { key, value } = JSON.parse(input); mock.values.set(key, value); done(true); };
    await setJson('pa.probe', { n: 4 }); assert.deepEqual(await getJson('pa.probe', null), { n: 4 });
  } finally { mock.restore(); }
});

test('missing APIs, thrown native errors and explicit set failure are controlled, never logged', async () => {
  const output = []; const oldWarn = console.warn; console.warn = (...args) => output.push(args);
  const mock = install();
  try {
    delete mock.apis['storage.getStorage']; await assert.rejects(getJson('pa.probe', null), storageError);
    mock.apis['storage.getStorage'] = () => { throw new Error('SENSITIVE'); }; await assert.rejects(getRaw('pa.probe'), storageError);
    for (const result of [false, { success: false }, { error: 'SENSITIVE' }, { status_code: 1 }]) {
      mock.apis['storage.setStorage'] = (_, callback) => callback(result);
      await assert.rejects(setRaw('pa.probe', 'SENSITIVE'), storageError);
    }
    assert.deepEqual(output, []);
  } finally { console.warn = oldWarn; mock.restore(); }
});

test('bounded native waits settle once; late timed-out writes block newer writes until acknowledgement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let callback; let started;
  const entered = new Promise(resolve => { started = resolve; });
  const mock = install({ 'storage.setStorage': (_, done) => { callback = done; started(); } });
  try {
    const writing = setJson('pa.probe', { n: 1 }); const failed = assert.rejects(writing, storageError);
    await entered; t.mock.timers.tick(5000); await failed;
    await assert.rejects(setJson('pa.probe', { n: 2 }), storageError);
    callback(true);
    mock.apis['storage.setStorage'] = (input, done) => { const { key, value } = JSON.parse(input); mock.values.set(key, value); done(true); };
    assert.equal(await setJson('pa.probe', { n: 3 }), true);
    assert.deepEqual(await getJson('pa.probe', null), { n: 3 });
  } finally { mock.restore(); }
});

test('read timeouts settle once, discard late results and leave the serial queue usable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let callback; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const mock = install({ 'storage.getStorage': (_, done) => { callback = done; entered(); } });
  try {
    const reading = getJson('pa.probe', null); const failed = assert.rejects(reading, storageError);
    await started; t.mock.timers.tick(5000); await failed;
    callback([{ data: '{"old":true}' }]);
    mock.apis['storage.getStorage'] = (_, done) => { done([{ data: '{"new":true}' }]); done([{ data: 'SENSITIVE invalid' }]); };
    assert.deepEqual(await getJson('pa.probe', null), { new: true });
  } finally { mock.restore(); }
});

test('invalid JSON writes and UTF8 oversize fail before platform calls', async () => {
  let calls = 0; const mock = install({ 'storage.setStorage': () => calls++ });
  try {
    const cyclic = {}; cyclic.self = cyclic;
    for (const value of [undefined, cyclic, { text: '中'.repeat(90000) }]) await assert.rejects(setJson('pa.probe', value), storageError);
    assert.equal(calls, 0);
  } finally { mock.restore(); }
});
