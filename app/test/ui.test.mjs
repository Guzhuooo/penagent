import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function mount(name, overrides = {}) {
  const app = { loadSettings: async () => ({ baseUrl: 'https://example.com/v1', model: 'test' }),
    loadSessions: async () => [], stop: async () => {}, createSession: () => ({ id: 's1', title: 'new', messages: [] }),
    saveSession: async () => {}, ...overrides.application };
  let callback;
  const input = { attach: fn => { callback = fn; }, detach: () => { callback = null; }, isInputSessionActive: () => false,
    open: async () => 'uuid', ...overrides.input };
  const source = readFileSync(new URL('../src/pages/' + name + '/' + name + '.vue', import.meta.url), 'utf8');
  const script = source.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/^import .*?;\s*$/gm, '').replace('export default', 'globalThis.component =');
  const context = { getApplication: () => app, input, errorLabel: error => error.code,
    navigate: () => {}, leaveSettings: () => {}, leaveTools: () => {}, developerMockSettings: data => ({ ...data, apiKey: 'test-synthetic-key', developmentMode: true }),
    SessionRail: {}, MessageCard: {}, ToolCard: {}, SettingField: {}, Promise, Date, console, ...overrides.context };
  vm.runInNewContext(script, context);
  const component = context.component;
  const instance = { ...component.data(), $page: { own: () => {} } };
  for (const [key, fn] of Object.entries(component.methods)) instance[key] = fn.bind(instance);
  for (const [key, fn] of Object.entries(component.computed || {})) Object.defineProperty(instance, key, { get: fn.bind(instance) });
  instance.ownerActive = true; instance.active = true; instance.destroyed = false;
  instance.generation = 0; instance.pendingStop = Promise.resolve(); instance.application = app;
  instance.attachInput();
  return { instance, app, component, result: data => callback?.(data) };
}

test('chat stop discards late responses/events and leaves pending tool cards cancelled', async () => {
  const gate = deferred(); const entered = deferred(); let stops = 0;
  const { instance: chat } = mount('chat', { application: {
    run: async (_, __, { onEvent }) => {
      onEvent({ type: 'tool_started', runId: 'run-1', id: 't1', name: 'calculator' }); entered.resolve();
      await gate.promise; onEvent({ type: 'message', runId: 'run-1', message: { role: 'assistant', content: 'LATE-SENTINEL' } });
      return { status: 'completed', messages: [{ role: 'assistant', content: 'LATE-SENTINEL' }] };
    }, stop: async () => { stops++; },
  } });
  chat.settings = { baseUrl: 'https://example.com/v1', model: 'test' };
  chat.sessions = [{ id: 's1', messages: [] }]; chat.selectedId = 's1'; chat.draft = 'test';
  const sending = chat.send(); await entered.promise;
  await chat.stopRun(); gate.resolve(); await sending;
  assert.equal(chat.busy, false); assert.equal(chat.status, 'cancelled'); assert.equal(stops, 1);
  assert.equal(chat.tools[0].status, 'cancelled'); assert.ok(!JSON.stringify(chat.messages).includes('LATE-SENTINEL'));
});

test('IME hide preserves active run while real unload stops exactly once', async () => {
  let stops = 0;
  const { instance: chat } = mount('chat', { application: { stop: async () => { stops++; } }, input: { isInputSessionActive: () => true } });
  chat.busy = true;
  chat.onHide(); assert.equal(chat.ownerActive, true); assert.equal(stops, 0);
  chat.onUnload(); chat.onUnload(); await chat.pendingStop;
  assert.equal(chat.destroyed, true); assert.equal(stops, 1);
});

test('only confirmed IME edits change draft; dirty sessions cannot be switched away', async () => {
  const { instance: chat, result } = mount('chat');
  chat.draft = 'original'; result({ confirmed: false, text: 'cancelled' }); assert.equal(chat.draft, 'original');
  result({ confirmed: true, text: 'confirmed' }); assert.equal(chat.draft, 'confirmed');
  chat.dirty = true; chat.selectedId = 's1'; chat.sessions = [{ id: 's1' }, { id: 's2' }];
  await chat.selectSession('s2'); assert.equal(chat.selectedId, 's1');
});

test('settings requires plaintext consent and clear-key save removes persisted permission', async () => {
  let saved;
  const { instance: settings } = mount('settings', { application: { saveSettings: async data => { saved = data; } } });
  await settings.load();
  settings.form.apiKey = 'PRIVATE-SENTINEL';
  settings.togglePersist(); assert.equal(settings.form.persistApiKey, false); assert.equal(settings.confirmPersistence, true);
  await settings.save(); assert.equal(saved, undefined);
  settings.confirmRemember(); await settings.save(); assert.equal(saved.persistApiKey, true);
  await settings.clearKey(); assert.equal(saved.apiKey, ''); assert.equal(saved.persistApiKey, false);
});

test('tools page lists built-in, meta and custom tools and deletes only after a second tap', async () => {
  let catalog = [
    { name: 'clock', description: 'time', origin: 'builtin', kind: '' },
    { name: 'define_tool', description: 'define', origin: 'meta', kind: '' },
    { name: 'city_lookup', description: '城市查询', origin: 'custom', kind: 'lookup' },
  ];
  const deleted = [];
  const { instance: page } = mount('tools', { application: {
    listTools: async () => catalog,
    loadCustomTools: async () => [],
    deleteCustomTool: async name => { deleted.push(name); catalog = catalog.filter(tool => tool.name !== name); return true; },
  } });
  await page.load();
  assert.equal(page.status, 'ready');
  assert.equal(page.builtinTools.length, 1); assert.equal(page.metaTools.length, 1); assert.equal(page.customTools.length, 1);
  assert.equal(page.builtinTools[0].name, 'clock');
  await page.removeCustom('city_lookup');
  assert.deepEqual(deleted, []); assert.equal(page.pendingDelete, 'city_lookup'); assert.match(page.notice, /确认/);
  await page.removeCustom('city_lookup');
  assert.deepEqual(deleted, ['city_lookup']); assert.equal(page.pendingDelete, ''); assert.equal(page.customTools.length, 0);
  assert.equal(page.notice, '已删除 city_lookup');
});

test('tools page recognizes tools from confirmed IME text only and guards late callbacks', async () => {
  const searched = [];
  const { instance: page, result } = mount('tools', { application: {
    listTools: async () => [],
    findTools: async query => { searched.push(query); return [{ name: 'unit_convert', description: '单位换算', origin: 'custom', kind: 'convert', score: 60, reason: 'name' }]; },
  }, input: { open: async () => 'uuid' } });
  await page.load();
  await page.startSearch();
  result({ confirmed: false, text: '城市' });
  assert.equal(page.query, ''); assert.deepEqual(searched, []);
  await page.startSearch();
  result({ confirmed: true, text: ' 单位换算 ' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(searched, ['单位换算']);
  assert.equal(page.recognized[0].name, 'unit_convert');
  page.onHide();
  assert.equal(page.ownerActive, false);
  result({ confirmed: true, text: '迟到输入' });
  assert.deepEqual(searched, ['单位换算']);
});

test('tools page surfaces catalog errors and releases state on unload', async () => {
  const { instance: page } = mount('tools', { application: { listTools: async () => { throw { code: 'STORAGE_ERROR' }; } } });
  await page.load();
  assert.equal(page.status, 'error'); assert.equal(page.notice, 'STORAGE_ERROR');
  page.pendingDelete = 'city_lookup';
  page.onUnload(); page.onUnload();
  assert.equal(page.destroyed, true); assert.equal(page.pendingDelete, '');
  assert.equal(page.recognized.length, 0);
});

test('chat tools button stops the active run before navigating and refresh preloads recipes', async () => {
  const navigated = []; let stops = 0; let preloads = 0;
  const { instance: chat } = mount('chat', {
    application: { stop: async () => { stops++; }, loadCustomTools: async () => { preloads++; } },
    context: { navigate: route => navigated.push(route) },
  });
  chat.busy = true;
  await chat.openTools();
  assert.equal(stops, 1); assert.deepEqual(navigated, ['tools']);
  await chat.refresh();
  assert.equal(preloads, 1);
});
