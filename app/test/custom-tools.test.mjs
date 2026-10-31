import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness, LIMITS } from '../src/core/index.js';
import { createStorage } from '../src/core/storage.js';
import { normalizeSettings, toolEnabled, TOOL_NAMES } from '../src/core/config.js';
import { createToolRegistry, validateToolArguments } from '../src/tools/registry.js';
import { createRunner } from '../src/core/runner.js';
import {
  CUSTOM_TOOL_KINDS, buildCustomRecord, buildCustomTool, createCustomToolStore,
  rankTools, toolCatalog, validateStoredCatalog, isReservedToolName
} from '../src/tools/custom.js';

const configured = (input = {}) => ({ baseUrl: 'https://api.example/v1', model: 'synthetic-model', ...input });
const user = () => [{ role: 'user', content: 'Synthetic test prompt' }];
const call = (id, name = 'clock', args = {}) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const reply = (calls, content = 'Synthetic answer') => ({ status: 200, data: { choices: [{ finish_reason: calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content: calls ? null : content, ...(calls ? { tool_calls: calls } : {}) } }] } });
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const code = expected => error => error.code === expected;
const ctx = () => ({ check() {}, now: Date.now });
function memory() {
  const values = new Map();
  return { values, getJson: async key => clone(values.get(key) ?? null), setJson: async (key, value) => { values.set(key, clone(value)); return true; } };
}
function configuredHarness(adapters) {
  const harness = createHarness(adapters);
  return { ...harness, run: (messages, input, options) => harness.run(messages, configured(input), options) };
}
function makeStore(mem) { return createCustomToolStore(createStorage(mem.getJson, mem.setJson)); }
const lookupRecord = (input = {}) => ({
  version: 1, name: 'city_lookup', description: '把城市代码转换为中文名称，例如 bj 返回北京。',
  kind: 'lookup', spec: { entries: [{ key: 'bj', value: '北京' }, { key: 'sh', value: '上海' }] },
  keywords: ['城市', 'city', '地名'], ...input
});
const computeRecord = (input = {}) => ({
  version: 1, name: 'area_estimate', description: '用两个有界数值做乘法并加二。',
  kind: 'compute', spec: { expression: '{a}*{b}+2', variables: [{ name: 'a', min: -100, max: 100 }, { name: 'b', min: 1, max: 10 }] },
  ...input
});
async function create(store, input) { await store.ensureLoaded(); return store.create(input); }
async function runTool(tool, args) { return JSON.parse(await tool.execute(args, ctx())); }

test('lookup recipe creates validates persists and executes exactly', async () => {
  const mem = memory();
  const store = makeStore(mem);
  const record = await create(store, lookupRecord());
  assert.equal(record.version, 1); assert.equal(record.name, 'city_lookup'); assert.equal(record.kind, 'lookup');
  assert.ok(Number.isInteger(record.createdAt) && record.createdAt > 0);
  assert.deepEqual(record.keywords, ['城市', 'city', '地名']);
  const tool = buildCustomTool(record);
  assert.equal(tool.origin, 'custom'); assert.equal(tool.kind, 'lookup');
  assert.deepEqual(tool.parameters.properties.key, { type: 'string', minLength: 1, maxLength: 64 });
  assert.deepEqual(await runTool(tool, { key: 'bj' }), { ok: true, data: { found: true, value: '北京' } });
  assert.deepEqual(await runTool(tool, { key: 'zz' }), { ok: true, data: { found: false } });
  assert.throws(() => validateToolArguments(tool, { key: 'bj', extra: 1 }), code('ARGUMENT_ERROR'));
  // Persistence: a second store over the same storage sees the same record.
  const reloaded = makeStore(mem);
  assert.deepEqual(await reloaded.ensureLoaded(), [record]);
  assert.deepEqual(reloaded.list(), [record]);
  assert.deepEqual(await runTool(buildCustomTool(reloaded.list()[0]), { key: 'sh' }), { ok: true, data: { found: true, value: '上海' } });
  assert.deepEqual(mem.values.get('pa.customTools'), { version: 1, data: { version: 1, tools: [record] } });
});

test('compute recipe substitutes only validated finite numbers and rejects bad grammar', async () => {
  const store = makeStore(memory());
  const record = await create(store, computeRecord());
  const tool = buildCustomTool(record);
  assert.deepEqual(await runTool(tool, { a: 3, b: 4 }), { ok: true, data: { value: 14 } });
  assert.deepEqual(await runTool(tool, { a: -2, b: 1 }), { ok: true, data: { value: 0 } });
  assert.throws(() => validateToolArguments(tool, { a: 3 }), code('ARGUMENT_ERROR'));
  assert.throws(() => validateToolArguments(tool, { a: 200, b: 1 }), code('ARGUMENT_ERROR'));
  assert.throws(() => validateToolArguments(tool, { a: 3, b: '4' }), code('ARGUMENT_ERROR'));
  await assert.rejects(tool.execute({ a: NaN, b: 2 }, ctx()), code('ARGUMENT_ERROR'));
  await assert.rejects(tool.execute({ a: 1e300, b: 2 }, ctx()), code('MATH_ERROR'));
  for (const spec of [
    { expression: '{a}*{b}', variables: [] },
    { expression: '{a}+1', variables: [{ name: 'a' }, { name: 'b' }] },
    { expression: '{a}+{c}', variables: [{ name: 'a' }] },
    { expression: '2**3', variables: [{ name: 'a' }] },
    { expression: '{a}', variables: [{ name: 'a', min: 5, max: 1 }] },
    { expression: '{a}{b}', variables: [{ name: 'a' }, { name: 'b' }] },
    { expression: '{a}'.repeat(300), variables: [{ name: 'a' }] }
  ]) {
    assert.throws(() => buildCustomRecord(computeRecord({ spec })), code('ARGUMENT_ERROR'));
  }
  // A recipe whose validated grammar divides by a possible zero is still
  // rejected at creation when the representative value hits the zero.
  assert.throws(() => buildCustomRecord(computeRecord({ spec: { expression: '2/({a}-1)', variables: [{ name: 'a', min: 1, max: 5 }] } })), code('ARGUMENT_ERROR'));
});

test('template, text and convert recipes stay declarative and bounded', async () => {
  const store = makeStore(memory());
  const template = buildCustomTool(await create(store, {
    version: 1, name: 'greet_text', description: '把输入值放入问候模板。', kind: 'template',
    spec: { template: '你好，{value}。' }, keywords: ['问候', '模板']
  }));
  assert.deepEqual(await runTool(template, { value: '世界' }), { ok: true, data: { value: '你好，世界。' } });
  assert.throws(() => buildCustomRecord({ version: 1, name: 'bad_tpl', description: 'd', kind: 'template', spec: { template: '没有占位符' } }), code('ARGUMENT_ERROR'));
  assert.throws(() => buildCustomRecord({ version: 1, name: 'bad_tpl', description: 'd', kind: 'template', spec: { template: '{other}' } }), code('ARGUMENT_ERROR'));
  assert.throws(() => buildCustomRecord({ version: 1, name: 'bad_tpl', description: 'd', kind: 'template', spec: { template: '{value}{value}{value}{value}{value}' } }), code('ARGUMENT_ERROR'));

  const text = buildCustomTool(await create(store, {
    version: 1, name: 'text_tool', description: '字符串处理。', kind: 'text', spec: { operation: 'reverse' }
  }));
  assert.deepEqual(await runTool(text, { text: 'a𝄞b' }), { ok: true, data: { operation: 'reverse', value: 'b𝄞a' } });
  const length = buildCustomTool(await create(store, {
    version: 1, name: 'length_tool', description: '统计字符数。', kind: 'text', spec: { operation: 'length' }
  }));
  assert.deepEqual(await runTool(length, { text: 'a𝄞中' }), { ok: true, data: { operation: 'length', value: 3 } });
  assert.throws(() => buildCustomRecord({ version: 1, name: 'bad_text', description: 'd', kind: 'text', spec: { operation: 'sort' } }), code('ARGUMENT_ERROR'));

  const temperature = buildCustomTool(await create(store, {
    version: 1, name: 'temp_convert', description: '温度换算。', kind: 'convert', spec: { family: 'temperature' }
  }));
  assert.deepEqual(await runTool(temperature, { value: 100, from: 'c', to: 'f' }), { ok: true, data: { family: 'temperature', from: 'c', to: 'f', value: 212 } });
  assert.deepEqual(await runTool(temperature, { value: 32, from: 'f', to: 'c' }), { ok: true, data: { family: 'temperature', from: 'f', to: 'c', value: 0 } });
  assert.throws(() => validateToolArguments(temperature, { value: 1, from: 'c', to: 'x' }), code('ARGUMENT_ERROR'));
  await assert.rejects(temperature.execute({ value: 1, from: 'c', to: 'x' }, ctx()), code('ARGUMENT_ERROR'));

  const lengthUnit = buildCustomTool(await create(store, {
    version: 1, name: 'length_convert', description: '长度换算。', kind: 'convert', spec: { family: 'length' }
  }));
  assert.deepEqual(await runTool(lengthUnit, { value: 1, from: 'm', to: 'cm' }), { ok: true, data: { family: 'length', from: 'm', to: 'cm', value: 100 } });
  assert.deepEqual(await runTool(lengthUnit, { value: 1, from: 'mi', to: 'km' }), { ok: true, data: { family: 'length', from: 'mi', to: 'km', value: 1.609344 } });
  assert.throws(() => buildCustomRecord({ version: 1, name: 'bad_conv', description: 'd', kind: 'convert', spec: { family: 'volume' } }), code('ARGUMENT_ERROR'));
});

test('corrupt or missing custom-tool storage fails closed with controlled errors', async () => {
  const badCatalogs = [
    { version: 99, tools: [] },
    { version: 1, tools: 'damaged' },
    { version: 1, tools: [{ ...lookupRecord(), extra: 'field' }] },
    { version: 1, tools: [lookupRecord({ name: 'Clock' })] },
    { version: 1, tools: [lookupRecord(), { ...lookupRecord(), createdAt: 2 }] },
    { version: 1, tools: Array.from({ length: LIMITS.customTools + 1 }, (_, index) => lookupRecord({ name: 'tool_' + String(index).padStart(3, '0'), keywords: [] })) },
    { version: 1, tools: [{ ...lookupRecord(), kind: 'shell' }] }
  ];
  for (const bad of badCatalogs) {
    const mem = memory(); mem.values.set('pa.customTools', { version: 1, data: bad });
    const store = makeStore(mem);
    await assert.rejects(store.ensureLoaded(), code('STORAGE_ERROR'));
    await assert.rejects(store.create(lookupRecord({ name: 'fresh_tool' })), code('STORAGE_ERROR'));
    assert.deepEqual(mem.values.get('pa.customTools'), { version: 1, data: bad });
    const harness = configuredHarness({ ...mem, requestJson: async () => reply() });
    await assert.rejects(harness.loadCustomTools(), code('STORAGE_ERROR'));
    const result = await harness.run(user());
    assert.equal(result.status, 'error'); assert.equal(result.error.code, 'STORAGE_ERROR');
    assert.deepEqual(result.messages, user());
  }
  for (const raw of [null, false, 0, '', []]) {
    const mem = memory(); mem.values.set('pa.customTools', { version: 1, data: raw });
    await assert.rejects(makeStore(mem).ensureLoaded(), code('STORAGE_ERROR'));
  }
  assert.throws(() => validateStoredCatalog(null), code('STORAGE_ERROR'));
  assert.throws(() => validateStoredCatalog({ version: 1, tools: [lookupRecord(), lookupRecord()] }), code('STORAGE_ERROR'));

  // Without storage adapters only mutations fail; listing and running still work.
  let requests = 0;
  const bare = configuredHarness({ requestJson: async () => { requests++; return reply(); } });
  assert.deepEqual(await bare.loadCustomTools(), []);
  assert.ok((await bare.listTools()).some(tool => tool.name === 'define_tool'));
  await assert.rejects(bare.createCustomTool(lookupRecord()), code('CAPABILITY_UNAVAILABLE'));
  await assert.rejects(bare.deleteCustomTool('city_lookup'), code('CAPABILITY_UNAVAILABLE'));
  assert.equal((await bare.run(user())).status, 'completed'); assert.equal(requests, 1);
});

test('names, kinds, specs, keywords and capacity are strictly validated', async () => {
  const store = makeStore(memory());
  await store.ensureLoaded();
  for (const name of ['clock', 'calculator', 'note', 'device_info', 'net_probe', 'execShell', 'define_tool', 'delete_tool', 'list_tools']) {
    assert.ok(isReservedToolName(name));
    await assert.rejects(store.create(lookupRecord({ name })), code('ARGUMENT_ERROR'));
  }
  for (const name of ['ab', 'a', 'Abc', '1abc', 'a-b', 'a b', 'a'.repeat(33), '']) {
    await assert.rejects(store.create(lookupRecord({ name })), code('ARGUMENT_ERROR'));
  }
  await create(store, lookupRecord());
  await assert.rejects(store.create(lookupRecord()), code('ARGUMENT_ERROR'));
  await assert.rejects(store.create(lookupRecord({ name: 'fresh_one', kind: 'shell' })), code('ARGUMENT_ERROR'));
  await assert.rejects(store.create(lookupRecord({ name: 'fresh_two', description: '' })), code('ARGUMENT_ERROR'));
  await assert.rejects(store.create(lookupRecord({ name: 'fresh_two', description: 'x'.repeat(201) })), code('ARGUMENT_ERROR'));
  await assert.rejects(store.create(lookupRecord({ name: 'fresh_two', description: 'bad\u0001control' })), code('ARGUMENT_ERROR'));
  await assert.rejects(store.create(lookupRecord({ name: 'fresh_two', keywords: Array.from({ length: 9 }, (_, i) => 'k' + i) })), code('ARGUMENT_ERROR'));
  await assert.rejects(store.create(lookupRecord({ name: 'fresh_two', keywords: ['x'.repeat(33)] })), code('ARGUMENT_ERROR'));
  await assert.rejects(store.create(lookupRecord({ name: 'fresh_two', extra: 1 })), code('ARGUMENT_ERROR'));
  for (const spec of [
    { entries: [] }, { entries: [{ key: 'a' }] }, { entries: [{ key: '', value: 'x' }] },
    { entries: [{ key: 'k'.repeat(65), value: 'x' }] }, { entries: [{ key: 'k', value: 'v'.repeat(513) }] },
    { entries: [{ key: 'same', value: 'a' }, { key: 'same', value: 'b' }] },
    { entries: Array.from({ length: 33 }, (_, i) => ({ key: 'k' + i, value: 'v' })) },
    { entries: [{ key: 'k', value: 'v' }], unexpected: true }
  ]) {
    assert.throws(() => buildCustomRecord(lookupRecord({ name: 'spec_check', spec })), code('ARGUMENT_ERROR'));
  }
  for (const keywords of [[1], ['']]) {
    assert.throws(() => buildCustomRecord(lookupRecord({ name: 'keyword_case', keywords })), code('ARGUMENT_ERROR'));
  }
  assert.deepEqual(buildCustomRecord(lookupRecord({ name: 'keyword_case', keywords: ['ok', 'ok', ' fine '] })).keywords, ['ok', 'fine']);
  // Per-record 2048 UTF-8 byte cap.
  const oversized = lookupRecord({ name: 'big_record', spec: { entries: Array.from({ length: 4 }, (_, i) => ({ key: 'k' + i, value: 'v'.repeat(512) })) } });
  assert.throws(() => buildCustomRecord(oversized), code('LIMIT_REACHED'));
  // Eight records maximum.
  const capStore = makeStore(memory());
  await capStore.ensureLoaded();
  for (let i = 0; i < LIMITS.customTools; i++) await capStore.create(lookupRecord({ name: 'bulk_' + String(i).padStart(3, '0'), keywords: [] }));
  await assert.rejects(capStore.create(lookupRecord({ name: 'bulk_999' })), code('LIMIT_REACHED'));
  assert.equal((await capStore.list()).length, LIMITS.customTools);
});

test('delete removes only custom recipes and is idempotent across reloads', async () => {
  const mem = memory();
  const store = makeStore(mem);
  await create(store, lookupRecord());
  await create(store, lookupRecord({ name: 'keep_tool', keywords: [] }));
  assert.equal(await store.remove('city_lookup'), true);
  assert.deepEqual((await store.list()).map(record => record.name), ['keep_tool']);
  assert.equal(await store.remove('city_lookup'), false);
  await assert.rejects(store.remove('clock'), code('ARGUMENT_ERROR'));
  await assert.rejects(store.remove('define_tool'), code('ARGUMENT_ERROR'));
  await assert.rejects(store.remove('Bad/Name'), code('ARGUMENT_ERROR'));
  const reloaded = makeStore(mem);
  assert.deepEqual((await reloaded.ensureLoaded()).map(record => record.name), ['keep_tool']);

  const harness = configuredHarness({ ...memory(), requestJson: async () => reply() });
  await harness.createCustomTool(lookupRecord());
  assert.equal((await harness.loadCustomTools()).length, 1);
  assert.equal(await harness.deleteCustomTool('city_lookup'), true);
  assert.deepEqual(await harness.loadCustomTools(), []);
  await assert.rejects(harness.createCustomTool(lookupRecord({ version: 2 })), code('ARGUMENT_ERROR'));
});

test('recognition ranks exact name, CJK keywords, descriptions and limits deterministically', async () => {
  const store = makeStore(memory());
  await store.ensureLoaded();
  const city = await store.create(lookupRecord());
  const unit = await store.create({ version: 1, name: 'unit_convert', description: '长度和重量的单位换算。', kind: 'convert', spec: { family: 'length' }, keywords: ['换算', '单位'] });
  const weather = await store.create({ version: 1, name: 'weather_tip', description: '根据关键词给出天气提示文本。', kind: 'template', spec: { template: '天气提示：{value}' }, keywords: ['天气'] });
  const catalog = toolCatalog(createToolRegistry(store.list()));
  const customCatalog = catalog.filter(entry => entry.origin === 'custom');
  assert.deepEqual(customCatalog.map(entry => entry.name), ['city_lookup', 'unit_convert', 'weather_tip']);
  assert.deepEqual(customCatalog[0].keywords, ['城市', 'city', '地名']);

  const exact = rankTools(catalog, 'city_lookup');
  assert.equal(exact[0].name, 'city_lookup'); assert.equal(exact[0].score, 100); assert.equal(exact[0].reason, 'exact_name');
  const cjk = rankTools(catalog, '城市');
  assert.equal(cjk[0].name, 'city_lookup'); assert.ok(cjk[0].score > 0);
  const unitMatch = rankTools(catalog, '单位换算');
  assert.equal(unitMatch[0].name, 'unit_convert');
  const weatherMatch = rankTools(catalog, '天气');
  assert.equal(weatherMatch[0].name, 'weather_tip');
  assert.equal(weatherMatch[0].kind, 'template');
  const descMatch = rankTools(catalog, '提示文本');
  assert.equal(descMatch[0].name, 'weather_tip');
  assert.deepEqual(rankTools(catalog, '完全不存在的东西'), []);
  assert.deepEqual(rankTools(catalog, '城市'), rankTools(catalog, '城市'));
  assert.deepEqual(rankTools(catalog, '   '), []);
  const limited = rankTools(catalog, '单位', 1);
  assert.equal(limited.length, 1);
  for (let i = 1; i < cjk.length; i++) assert.ok(cjk[i - 1].score >= cjk[i].score);
  assert.ok(limited[0].description.length <= 100);
  assert.throws(() => rankTools(catalog, 'x'.repeat(257)), code('ARGUMENT_ERROR'));
  assert.throws(() => rankTools(catalog, 'x', 0), code('ARGUMENT_ERROR'));
  assert.equal(rankTools(null, 'x').length, 0);
});

test('harness end-to-end: model defines, calls and recognizes a persisted custom tool', async () => {
  const mem = memory();
  const requests = [];
  const harness = createHarness({ ...mem, requestJson: async options => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (requests.length === 1) {
      return reply([call('define-1', 'define_tool', {
        name: 'city_lookup', description: '把城市代码转换为中文名称。', kind: 'lookup',
        spec: { entries: [{ key: 'bj', value: '北京' }] }, keywords: ['城市', 'city']
      })]);
    }
    if (requests.length === 2) {
      const advertised = body.tools.map(tool => tool.function.name);
      assert.ok(advertised.includes('city_lookup'), 'second request must advertise the new tool');
      assert.ok(advertised.includes('define_tool'));
      const schema = body.tools.find(tool => tool.function.name === 'city_lookup').function;
      assert.equal(schema.parameters.properties.key.maxLength, 64);
      return reply([call('use-1', 'city_lookup', { key: 'bj' }), call('list-1', 'list_tools', { query: '城市' })]);
    }
    const results = body.messages.filter(message => message.role === 'tool');
    assert.deepEqual(results.map(message => message.tool_call_id), ['define-1', 'use-1', 'list-1']);
    return reply(null, '完成');
  } });
  await harness.loadCustomTools();
  const result = await harness.run(user(), configured());
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.equal(result.modelRequests, 3); assert.equal(result.toolCalls, 3);
  const toolResults = result.messages.filter(message => message.role === 'tool');
  assert.equal(JSON.parse(toolResults[0].content).data.name, 'city_lookup');
  assert.equal(JSON.parse(toolResults[1].content).data.value, '北京');
  const recognized = JSON.parse(toolResults[2].content).data;
  assert.equal(recognized.tools[0].name, 'city_lookup');
  assert.ok(recognized.tools[0].score > 0);
  assert.ok(requests[0].tools.some(tool => tool.function.name === 'define_tool'));

  // Persistence: a fresh harness with the same storage advertises the recipe.
  const nextRequests = [];
  const restored = createHarness({ ...mem, requestJson: async options => { nextRequests.push(JSON.parse(options.body)); return reply(null, 'ok'); } });
  assert.deepEqual((await restored.loadCustomTools()).map(record => record.name), ['city_lookup']);
  assert.equal((await restored.run(user(), configured())).status, 'completed');
  assert.ok(nextRequests[0].tools.some(tool => tool.function.name === 'city_lookup'));
  assert.deepEqual((await restored.findTools('城市')).map(entry => entry.name), ['city_lookup']);
  assert.ok((await restored.listTools()).some(entry => entry.origin === 'custom'));
});

test('unknown, disabled and malformed tool calls still return controlled errors', async () => {
  let requests = 0;
  const harness = configuredHarness({ ...memory(), requestJson: async () => ++requests === 1 ? reply([
    call('unknown-1', 'city_lookup', { key: 'bj' }),
    call('disabled-1', 'define_tool', { name: 'new_tool', description: 'd', kind: 'lookup', spec: { entries: [{ key: 'a', value: 'b' }] } })
  ]) : reply() });
  const result = await harness.run(user(), { tools: { define_tool: false } });
  assert.equal(result.status, 'completed');
  const errors = result.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content).error.code);
  assert.deepEqual(errors, ['TOOL_UNKNOWN', 'TOOL_DISABLED']);

  let customRequests = 0;
  const custom = configuredHarness({ ...memory(), requestJson: async () => ++customRequests === 1 ? reply([call('bad-args', 'city_lookup', { key: 'bj', extra: 1 })]) : reply() });
  await custom.createCustomTool(lookupRecord());
  const bad = await custom.run(user());
  assert.equal(bad.status, 'completed');
  assert.equal(JSON.parse(bad.messages.find(message => message.role === 'tool').content).error.code, 'ARGUMENT_ERROR');
});

test('toolEnabled semantics keep built-ins, meta-tools and custom recipes consistent', () => {
  const settings = normalizeSettings();
  for (const name of TOOL_NAMES) if (name !== 'execShell' && name !== 'file_exec') assert.equal(toolEnabled(settings, name), true, name);
  assert.equal(toolEnabled(settings, 'execShell'), false);
  assert.equal(toolEnabled(settings, 'file_exec'), false);
  assert.equal(toolEnabled(normalizeSettings({ tools: { file_exec: true } }), 'file_exec'), true);
  assert.equal(toolEnabled(normalizeSettings({ tools: { clock: false } }), 'clock'), false);
  assert.equal(toolEnabled(normalizeSettings({ tools: { execShell: true }, execShellEnabled: true }), 'execShell'), true);
  assert.equal(toolEnabled(normalizeSettings({ tools: { execShell: true } }), 'execShell'), false);
  // Custom names are not in the persisted switch map; deletion is the disable path.
  assert.equal(toolEnabled(settings, 'city_lookup'), true);
  assert.equal(toolEnabled(normalizeSettings({ tools: { list_tools: false } }), 'list_tools'), false);
  assert.ok(CUSTOM_TOOL_KINDS.indexOf('lookup') >= 0 && CUSTOM_TOOL_KINDS.length === 5);
  assert.throws(() => normalizeSettings({ tools: { 'city lookup': true } }), code('CONFIG_ERROR'));
});

test('registry keeps the array contract while appending meta and custom tools', async () => {
  assert.ok(Array.isArray(createToolRegistry()));
  const plain = createToolRegistry();
  assert.equal(plain.find(tool => tool.name === 'clock').origin, 'builtin');
  assert.equal(plain.find(tool => tool.name === 'define_tool').origin, 'meta');
  assert.equal(plain.find(tool => tool.name === 'delete_tool').origin, 'meta');
  assert.equal(plain.find(tool => tool.name === 'list_tools').origin, 'meta');
  const record = buildCustomRecord(lookupRecord());
  const registry = createToolRegistry([record]);
  assert.equal(registry.length, plain.length + 1);
  assert.equal(registry[registry.length - 1].name, 'city_lookup');
  assert.equal(registry[registry.length - 1].origin, 'custom');

  // Legacy array form of createRunner still works; a function form is also accepted.
  for (const injected of [plain, () => plain]) {
    const runner = createRunner({ requestJson: async () => reply() }, injected, createStorage(memory().getJson, memory().setJson));
    assert.equal((await runner.run(user(), configured())).status, 'completed');
  }
});

test('custom tool sources never execute dynamic code or touch platform layers', () => {
  const source = readFileSync(new URL('../src/tools/custom.js', import.meta.url), 'utf8');
  assert.ok(!/\b(?:TextEncoder|Buffer|eval|console)\b|new\s+Function|\$falcon|from\s+['"](?:node:|.*services|.*pages)|import\s*\(/.test(source));
  assert.ok(!/from\s+['"][^'"]*pages\//.test(source));
});
