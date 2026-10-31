import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPlainText } from '../src/utils/plain-text.js';
import { validatePluginBundle, buildPluginTools } from '../src/plugins/plugin.js';
import { createPluginStore } from '../src/plugins/store.js';
import { createHarness } from '../src/core/index.js';
import { validateResponse } from '../src/core/client.js';
import { validateAnthropicResponse } from '../src/core/anthropic.js';

const pluginJson = (overrides) => Object.assign({
  schema: 'penagent-plugin/1',
  id: 'com.example.weekday',
  name: 'Weekday Pack',
  version: '1.0.0',
  description: 'Adds a small lookup tool.',
  prompt: 'When asked for a weekday, use weekday_cn.',
  tools: [{
    name: 'weekday_cn',
    description: 'Map an English weekday to Chinese.',
    kind: 'lookup',
    spec: { entries: [{ key: 'monday', value: '星期一' }, { key: 'tuesday', value: '星期二' }] },
  }],
}, overrides || {});

function fakeWorkspace(files) {
  const state = { files: Object.assign({}, files), lists: 0 };
  return {
    state,
    async list(relative) {
      state.lists += 1;
      return { entries: Object.keys(state.files).map((name) => ({ name, type: 'file' })) };
    },
    async read(relative) { return { content: state.files[relative.replace(/^plugins\//, '')] }; },
  };
}

test('plain text formatter strips markdown without losing content', () => {
  const text = formatPlainText('# Title\n\n**bold** and `code`\n\n- one\n- two\n\n[link](https://example.com)\n\n```js\nconst x = 1;\n```');
  assert.ok(text.includes('Title'));
  assert.ok(text.includes('bold and code'));
  assert.ok(text.includes('· one'));
  assert.ok(text.includes('link (https://example.com)'));
  assert.ok(text.includes('const x = 1;'));
  assert.ok(!text.includes('**'));
  assert.ok(!text.includes('```'));
  assert.equal(formatPlainText('<b>raw</b>'), 'raw');
});

test('plugin spec validates and builds declarative tools', () => {
  const plugin = validatePluginBundle(pluginJson(), 'plugins/weekday.json');
  assert.equal(plugin.id, 'com.example.weekday');
  assert.equal(plugin.records.length, 1);
  const tools = buildPluginTools(plugin);
  assert.equal(tools[0].name, 'weekday_cn');
  assert.equal(tools[0].origin, 'plugin');
  assert.throws(() => validatePluginBundle(pluginJson({ id: 'Bad Id' })), (error) => error.code === 'ARGUMENT_ERROR');
  assert.throws(() => validatePluginBundle(pluginJson({ tools: [{ name: 'clock', description: 'x', kind: 'text', spec: { operation: 'trim' } }] })), (error) => error.code === 'ARGUMENT_ERROR');
});

test('plugin store loads, executes, reports errors and hot reloads from workspace', async () => {
  const workspace = fakeWorkspace({ 'weekday.json': JSON.stringify(pluginJson()) });
  const store = createPluginStore(workspace);
  await store.ensureLoaded();
  assert.equal(store.catalog().plugins.length, 1);
  assert.equal(store.tools()[0].name, 'weekday_cn');
  const executed = await store.tools()[0].execute({ key: 'tuesday' }, { check() {} });
  assert.ok(executed.includes('星期二'));
  assert.equal(store.prompt(), 'When asked for a weekday, use weekday_cn.');
  workspace.state.files['weekday.json'] = JSON.stringify(pluginJson({ version: '1.0.1' }));
  workspace.state.files['broken.json'] = '{not json';
  const state = await store.reload();
  assert.equal(state.plugins[0].version, '1.0.1');
  assert.equal(state.errors.length, 1);
});

test('harness loads plugin tools and injects system prompt only into requests', async () => {
  const workspace = fakeWorkspace({ 'weekday.json': JSON.stringify(pluginJson()) });
  const stored = new Map();
  let captured;
  const harness = createHarness({
    workspace,
    getJson: async (key) => stored.has(key) ? stored.get(key) : null,
    setJson: async (key, value) => { stored.set(key, value); return true; },
    requestJson: async (options) => { captured = options; return { status: 200, data: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] } }; },
  });
  const catalog = await harness.loadPlugins();
  assert.equal(catalog.plugins.length, 1);
  const tools = await harness.listTools();
  assert.ok(tools.some((tool) => tool.name === 'weekday_cn' && tool.origin === 'plugin'));
  const settings = await harness.saveSettings({ baseUrl: 'https://api.example', apiKey: 'test-key', model: 'm', systemPrompt: 'Base prompt.' });
  const result = await harness.run([{ role: 'user', content: 'hello' }], settings);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.messages.map((message) => message.role), ['user', 'assistant']);
  const body = JSON.parse(captured.body);
  assert.equal(body.messages[0].role, 'system');
  assert.ok(body.messages[0].content.includes('Base prompt.'));
  assert.ok(body.messages[0].content.includes('weekday_cn'));
});

test('reasoning is preserved for collapsible UI but never replayed', () => {
  const openai = validateResponse({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'answer', reasoning_content: 'thought' } }] });
  assert.equal(openai.reasoning, 'thought');
  const anthropic = validateAnthropicResponse({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'answer' }] });
  assert.equal(anthropic.reasoning, 'hmm');
});
