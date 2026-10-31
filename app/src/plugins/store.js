// Workspace-backed plugin loader. Plugin bundles live in <workspace>/plugins/*.json;
// no storage migration or app rebuild is required. A reload re-scans the folder,
// validates every file, and swaps the active tool/prompt snapshot atomically.
import { stableError } from '../core/errors.js';
import { validatePluginBundle, buildPluginTools, pluginCatalog } from './plugin.js';

export function createPluginStore(workspace) {
  let loaded = false;
  let loading = null;
  let active = [];
  let errors = [];
  let available = !!(workspace && typeof workspace.list === 'function' && typeof workspace.read === 'function');

  async function scan() {
    if (!available) return;
    const next = [];
    const nextErrors = [];
    let listing;
    try {
      listing = await workspace.list('plugins');
    } catch (error) {
      // A missing plugins directory is a valid empty plugin set.
      active = [];
      errors = [];
      available = true;
      return;
    }
    const entries = (listing && Array.isArray(listing.entries) ? listing.entries : [])
      .filter(function (entry) { return entry && entry.type !== 'dir' && /\.json$/i.test(String(entry.name || '')); })
      .slice(0, 64);
    for (let i = 0; i < entries.length; i += 1) {
      const name = String(entries[i].name);
      try {
        const read = await workspace.read('plugins/' + name);
        const parsed = JSON.parse(read.content);
        const plugin = validatePluginBundle(parsed, 'plugins/' + name);
        const duplicate = next.some(function (item) { return item.id === plugin.id; });
        if (duplicate) throw Object.assign(new Error('duplicate plugin id'), { code: 'ARGUMENT_ERROR' });
        plugin.tools = buildPluginTools(plugin);
        next.push(plugin);
      } catch (error) {
        const safe = stableError(error, 'ARGUMENT_ERROR');
        nextErrors.push({ source: 'plugins/' + name, code: safe.code, message: safe.message });
      }
    }
    active = next;
    errors = nextErrors;
  }

  function ensureLoaded() {
    if (loaded) return Promise.resolve();
    if (!loading) loading = scan().then(function () { loaded = true; loading = null; }, function (error) { loading = null; throw error; });
    return loading;
  }

  async function reload() {
    loaded = false;
    if (loading) {
      try { await loading; } catch (_) { /* a failed scan is retried below */ }
    }
    loading = scan().then(function () { loaded = true; loading = null; });
    await loading;
    return catalog();
  }

  function tools() {
    let result = [];
    active.forEach(function (plugin) { result = result.concat(plugin.tools || []); });
    return result;
  }

  function prompts() {
    return active.map(function (plugin) { return plugin.prompt; }).filter(function (value) { return value; });
  }

  function catalog() {
    return { available: available, plugins: active.map(function (plugin) {
      const item = pluginCatalog(plugin);
      item.toolCount = plugin.tools.length;
      return item;
    }), errors: errors.slice() };
  }

  return {
    ensureLoaded: ensureLoaded,
    reload: reload,
    tools: tools,
    prompt: function () { return prompts().join('\n\n'); },
    catalog: catalog,
    state: function () { return { loaded: loaded, active: active.length, errors: errors.length }; },
  };
}
