import { normalizeSettings } from './config.js';
import { fail } from './errors.js';
import { createStorage } from './storage.js';
import { createSession, createSessionStore } from './session.js';
import { createToolRegistry } from '../tools/registry.js';
import { createRunner } from './runner.js';
export function createHarness(adapters) {
  const injected = adapters || {};
  const storage = createStorage(injected.getJson, injected.setJson);
  const sessions = createSessionStore(storage);
  let settings = normalizeSettings();
  let settingsRevision = 0;
  let settingsDirty = false;
  const missingSettings = {};
  const runner = createRunner(injected, createToolRegistry(), storage, function () { return settings; });
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
        if (!normalized.persistApiKey) normalized.apiKey = settings.apiKey;
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
      if (!saved.persistApiKey) delete saved.apiKey;
      return storage.enqueue(async function () {
        await storage.write('pa.settings', saved);
        if (revision === settingsRevision) settingsDirty = false;
        return normalizeSettings(normalized);
      });
    },
    loadSessions: sessions.loadSessions,
    saveSession: sessions.saveSession,
    createSession: createSession,
    run: function (messages, input, options) {
      if (input != null) { settings = normalizeSettings(input); settingsRevision += 1; }
      return runner.run(messages, settings, options);
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
