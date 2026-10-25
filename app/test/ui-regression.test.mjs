import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHarness } from '../src/core/index.js';
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function page(name, application) {
  const source = readFileSync(new URL('../src/pages/' + name + '/' + name + '.vue', import.meta.url), 'utf8');
  const script = source.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^import .*?;\s*$/gm, '').replace('export default', 'globalThis.component =');
  const context = { SessionRail: {}, MessageCard: {}, ToolCard: {}, SettingField: {}, input: { attach() {}, detach() {}, isInputSessionActive: () => false },
    errorLabel: error => error.code, getApplication: () => application, Promise, Date, console, navigate() {}, leaveSettings() {} };
  vm.runInNewContext(script, context);
  const component = context.component;
  const instance = { ...component.data(), application, ownerActive: true, destroyed: false, generation: 0, pendingStop: Promise.resolve() };
  Object.entries(component.methods).forEach(([key, fn]) => { instance[key] = fn.bind(instance); });
  return instance;
}
function app(overrides = {}) {
  return { createSession: () => ({ id: 's-new', title: '新会话', createdAt: 1, updatedAt: 1, messages: [] }), saveSession: async () => {}, stop: async () => {},
    loadSettings: async () => ({ baseUrl: 'https://example.com/v1', model: 'test' }), ...overrides };
}
// The SFC VM and imported core use separate realms in this host test, unlike Falcon.
function corePageApplication(harness) {
  return { ...harness, saveSession: data => harness.saveSession(structuredClone(data)),
    run: (messages, settings, options) => harness.run(structuredClone(messages), structuredClone(settings), options) };
}
function chatPage(application) {
  const chat = page('chat', application);
  chat.settings = { baseUrl: 'https://example.com/v1', model: 'test' }; chat.draft = 'FIRST-DRAFT';
  return chat;
}

test('first send snapshots original draft before creating its initial session', async () => {
  let sent;
  const chat = chatPage(app({ run: async messages => { sent = messages; return { status: 'completed', messages }; } }));
  await chat.send();
  assert.equal(sent[0].content, 'FIRST-DRAFT'); assert.notEqual(chat.sessions[0].title, ''); assert.equal(chat.dirty, false);
});

test('stop during deferred prior cleanup prevents reserved send from creating a POST', async () => {
  const gate = deferred(); let posts = 0;
  const chat = chatPage(app({ run: async messages => { posts++; return { status: 'completed', messages }; } }));
  chat.selectedId = 's1'; chat.sessions = [{ id: 's1', title: 'saved', messages: [] }]; chat.pendingStop = gate.promise;
  const sending = chat.send(); await Promise.resolve();
  const stopping = chat.stopRun(); gate.resolve(); await Promise.all([sending, stopping]);
  assert.equal(posts, 0);
});

test('stop persists already completed tool groups and reserved audit before switching away', async () => {
  const gate = deferred(); const entered = deferred(); const saved = [];
  const group = [{ role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'note', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: '{"ok":true}' }];
  const application = app({
    saveSession: async data => { saved.push(structuredClone(data)); },
    run: async (messages, _, options) => {
      await options.beforeToolBatch(group[0]);
      options.onEvent({ type: 'tool_started', runId: 'r1', id: 't1', name: 'note' });
      options.onEvent({ type: 'tool_result', runId: 'r1', name: 'note', message: group[1] });
      options.onEvent({ type: 'tool_group', runId: 'r1', messages: group }); entered.resolve();
      await gate.promise; return { status: 'cancelled', messages: messages.concat(group) };
    }, stop: async () => { gate.resolve(); },
  });
  const chat = chatPage(application); chat.selectedId = 's1'; chat.sessions = [{ id: 's1', title: 'saved', messages: [], createdAt: 1, updatedAt: 1 }];
  const sending = chat.send(); await entered.promise; await chat.stopRun(); await sending;
  assert.equal(saved.at(-1).messages.length, 3);
  assert.equal(saved.some(data => data.toolAudit?.[0]?.status === 'reserved'), true);
  assert.equal(saved.at(-1).toolAudit[0].id, 't1'); assert.equal(chat.dirty, false);
});

test('send supersedes an earlier new-session transition without dropping the original draft', async () => {
  const gate = deferred(); let created = 0; let sent;
  const chat = chatPage(app({ createSession: () => ({ id: 's' + ++created, title: 'new', createdAt: 1, updatedAt: 1, messages: [] }),
    run: async messages => { sent = messages; return { status: 'completed', messages }; } }));
  chat.pendingStop = gate.promise;
  const creating = chat.newSession(); const sending = chat.send(); gate.resolve(); await Promise.all([creating, sending]);
  assert.equal(created, 1); assert.equal(sent[0].content, 'FIRST-DRAFT');
  assert.equal(chat.sessions.length, 1); assert.equal(chat.sessions[0].messages[0].content, 'FIRST-DRAFT');
});

test('stop during session creation preserves draft and never sends', async () => {
  const gate = deferred(); const entered = deferred(); let posts = 0;
  const chat = chatPage(app({ createSession: async () => { entered.resolve(); return gate.promise; }, run: async () => { posts++; } }));
  const sending = chat.send(); await entered.promise; await chat.stopRun();
  gate.resolve({ id: 'late-session', title: 'new', messages: [] }); await sending;
  assert.equal(posts, 0); assert.equal(chat.selectedId, ''); assert.equal(chat.draft, 'FIRST-DRAFT');
});

test('page reserves audit durably before a note effect and rejects replay after restart', async () => {
  const values = new Map(); let writes = 0; let requests = 0;
  const tool = { id: 'durable-note', type: 'function', function: { name: 'note', arguments: JSON.stringify({ op: 'create', id: 'demo', content: 'synthetic' }) } };
  const adapters = {
    getJson: async key => values.has(key) ? structuredClone(values.get(key)) : null,
    setJson: async (key, value) => { values.set(key, structuredClone(value)); if (key === 'pa.note.demo') writes++; },
    requestJson: async () => ({ status: 200, data: { choices: [{ finish_reason: requests === 1 ? 'stop' : 'tool_calls', message: ++requests === 2 ? { role: 'assistant', content: 'done' } : { role: 'assistant', content: null, tool_calls: [tool] } }] } }),
  };
  const harness = createHarness(adapters); const chat = chatPage(corePageApplication(harness));
  await chat.send(); assert.equal(chat.status, 'completed', chat.notice); assert.equal(writes, 1);
  const restored = createHarness(adapters); chat.application = corePageApplication(restored); chat.sessions = await restored.loadSessions();
  assert.equal(chat.sessions[0].toolAudit[0].status, 'completed');
  chat.messages = chat.sessions[0].messages; chat.draft = 'second request'; await chat.send();
  assert.equal(chat.status, 'error'); assert.equal(chat.notice, 'PROTOCOL_ERROR'); assert.equal(writes, 1);
});

test('stop while reservation save is pending prevents tool effects and keeps cancelled audit', async () => {
  const gate = deferred(); const entered = deferred(); const values = new Map(); let notes = 0; let blocked = false;
  const harness = createHarness({
    getJson: async key => values.has(key) ? structuredClone(values.get(key)) : null,
    setJson: async (key, value) => {
      if (key.startsWith('pa.session.') && value.data.text.includes('reserved') && !blocked) { blocked = true; entered.resolve(); await gate.promise; }
      values.set(key, structuredClone(value)); if (key.startsWith('pa.note.')) notes++;
    },
    requestJson: async () => ({ status: 200, data: { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'pending-note', type: 'function', function: { name: 'note', arguments: '{"op":"create","id":"demo","content":"synthetic"}' } }] } }] } }),
  });
  const chat = chatPage(corePageApplication(harness)); const sending = chat.send(); await entered.promise;
  const stopping = chat.stopRun(); gate.resolve(); await Promise.all([sending, stopping]);
  const restored = await harness.loadSessions();
  assert.equal(notes, 0); assert.equal(restored[0].toolAudit[0].status, 'cancelled'); assert.equal(chat.dirty, false);
});

test('settings save and clear are disabled until initial load completes; interrupted load is retried', async () => {
  const gate = deferred(); let writes = 0; let reads = 0;
  const settings = page('settings', app({ loadSettings: async () => { reads++; await gate.promise; return { baseUrl: 'https://saved.example/v1', model: 'saved', tools: {}, allowedProbeHosts: [] }; },
    saveSettings: async () => { writes++; } }));
  const loading = settings.load();
  await settings.clearKey(); await settings.save(); assert.equal(writes, 0);
  settings.onHide(); settings.onShow(); gate.resolve(); await loading;
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.ok(reads >= 2); assert.equal(settings.form.baseUrl, 'https://saved.example/v1');
});
