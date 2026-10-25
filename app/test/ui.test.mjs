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
    navigate: () => {}, leaveSettings: () => {}, developerMockSettings: data => ({ ...data, apiKey: 'test-synthetic-key', developmentMode: true }),
    SessionRail: {}, MessageCard: {}, ToolCard: {}, SettingField: {}, Promise, Date, console };
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
