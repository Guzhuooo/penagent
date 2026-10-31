import { normalizeSettings } from './config.js';
import { fail } from './errors.js';
import { createStorage } from './storage.js';
import { createSession, createSessionStore } from './session.js';
import { createToolRegistry } from '../tools/registry.js';
import { createCustomToolStore, rankTools, toolCatalog } from '../tools/custom.js';
import { createRunner } from './runner.js';
import { createPluginStore } from '../plugins/store.js';
export function createHarness(adapters) {
  const injected = adapters || {};
  const storage = createStorage(injected.getJson, injected.setJson);
  const sessions = createSessionStore(storage);
  const custom = createCustomToolStore(storage);
  const plugins = createPluginStore(injected.workspace);
  let settings = normalizeSettings();
  let settingsRevision = 0;
  let settingsDirty = false;
  const missingSettings = {};
  // Dynamic registry: re-resolved on every model iteration so a tool defined
  // during this run is advertised in the next request. Persisted recipes are
  // read only after an explicit loadCustomTools() preload: the UI page loads
  // them before sending, while a bare API runner never adds a hidden storage
  // read before the first model request (which would change cancel ordering).
  function currentRegistry() {
    return Promise.resolve()
      .then(function () { return custom.state.loaded ? custom.ensureLoaded() : null; })
      .then(function () { return plugins.state().loaded ? plugins.ensureLoaded() : null; })
      .then(function () { return createToolRegistry(custom.records(), plugins.state().loaded ? plugins.tools() : []); });
  }
  function pluginPrompt() { return plugins.prompt(); }
  const runner = createRunner(Object.assign({}, injected, { customTools: custom }), currentRegistry, storage, function () { return settings; });
  return {
    state: runner.state,
    storageState: storage.state,
    loadSettings: function () { return storage.enqueue(async function () {
      if (settingsDirty) return normalizeSettings(settings);
      const revision = settingsRevision;
      const stored = await storage.read('pa.settings', null, missingSettings);
      if (revision !== settingsRevision) return normalizeSettings(settings);
      if (stored !== missingSettings) {
        if (stored === null) fail('STORAGE_ERROR');
        let normalized;
        try { normalized = normalizeSettings(stored); } catch (_) { fail('STORAGE_ERROR'); }
        settings = normalized;
      }
      return normalizeSettings(settings);
    }); },
    saveSettings: function (input) {
      const normalized = normalizeSettings(input);
      settings = normalized;
      settingsDirty = true;
      const revision = ++settingsRevision;
      const saved = normalizeSettings(normalized);
      // User requirement: every entered API key is persisted. Keep the key in the
      // stored record unconditionally; clearing the field is the explicit erase.
      saved.persistApiKey = true;
      return storage.enqueue(async function () {
        await storage.write('pa.settings', saved);
        if (revision === settingsRevision) settingsDirty = false;
        return normalizeSettings(normalized);
      });
    },
    loadSessions: sessions.loadSessions,
    saveSession: sessions.saveSession,
    createSession: createSession,
    // Cached custom-tool snapshot (empty before the first load).
    customTools: function () { return custom.list(); },
    loadCustomTools: function () { return custom.ensureLoaded().then(function () { return custom.list(); }); },
    createCustomTool: function (input) { return custom.ensureLoaded().then(function () { return custom.create(input); }); },
    deleteCustomTool: function (name) { return custom.ensureLoaded().then(function () { return custom.remove(name); }); },
    listTools: function () {
      return Promise.all([custom.ensureLoaded(), plugins.ensureLoaded()]).then(function () {
        return toolCatalog(createToolRegistry(custom.records(), plugins.tools()));
      });
    },
    findTools: function (query) {
      return Promise.all([custom.ensureLoaded(), plugins.ensureLoaded()]).then(function () {
        return rankTools(toolCatalog(createToolRegistry(custom.records(), plugins.tools())), query, 5);
      });
    },
    loadPlugins: function () { return plugins.ensureLoaded().then(function () { return plugins.catalog(); }); },
    reloadPlugins: function () { return plugins.reload().then(function () { return plugins.catalog(); }); },
    pluginCatalog: function () { return plugins.catalog(); },
    pluginState: function () { return plugins.state(); },
    run: function (messages, input, options) {
      if (input != null) { settings = normalizeSettings(input); settingsRevision += 1; }
      const extra = [settings.systemPrompt, typeof pluginPrompt === 'function' ? pluginPrompt() : '']
        .filter(function (value) { return typeof value === 'string' && value; }).join('\n\n').slice(0, 8192);
      const runSettings = normalizeSettings(Object.assign({}, settings, { systemPrompt: extra }));
      return runner.run(messages, runSettings, options);
    },
    stop: runner.stop,
    flush: storage.flush
  };
}
export { normalizeSettings, completionEndpoint, DEFAULT_SETTINGS } from './config.js';
export { CoreError } from './errors.js';
export { LIMITS } from './limits.js';
export { utf8Bytes, truncateUtf8 } from './utf8.js';
export { validateSchema, parseArguments } from './schema.js';
export { validateHistory, trimContext } from './context.js';
export { createSession } from './session.js';
