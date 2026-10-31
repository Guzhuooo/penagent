// Read a user-provided config file from a fixed, safe location so the pen does
// not require typing the key character by character. No path is accepted from
// the UI/model: only these fixed candidates are read, each ≤64 KiB.
import { parseConfigText } from '../../core/import-config.js';
import { getWorkspaceAdapter } from './workspace.js';

const CANDIDATES = ['/tmp/penagent-config.json', '/tmp/penagent-config.txt', '/tmp/penagent-config'];
const WORKSPACE_CANDIDATES = ['import/config.json', 'penagent-config.json'];
const MAX_BYTES = 64 * 1024;
let fsModulePromise = null;

function loadFs() {
  if (!fsModulePromise) {
    fsModulePromise = Promise.resolve().then(function () { return import('fs'); })
      .catch(function () { return null; });
  }
  return fsModulePromise;
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.data === 'string') return value.data;
  if (value && typeof value.text === 'string') return value.text;
  return null;
}

export async function importConfigFromFile() {
  let lastError = null;
  // Workspace first: it is the app-private path and always available to the
  // workspace adapter on this firmware (the /tmp fs read may be sandboxed).
  try {
    const workspace = getWorkspaceAdapter();
    for (let i = 0; i < WORKSPACE_CANDIDATES.length; i += 1) {
      const relative = WORKSPACE_CANDIDATES[i];
      try {
        const read = await workspace.read(relative);
        const parsed = parseConfigText(read.content);
        return { found: true, path: 'workspace/' + relative, format: parsed.format, fields: parsed.fields, settings: parsed.settings };
      } catch (error) { lastError = error; }
    }
  } catch (error) { lastError = error; }
  const fsModule = await loadFs();
  if (fsModule && typeof fsModule.readFile === 'function' && typeof fsModule.stat === 'function') {
    for (let i = 0; i < CANDIDATES.length; i += 1) {
      const path = CANDIDATES[i];
      let stat;
      try { stat = await fsModule.stat(path); } catch (error) { continue; }
      if (!stat || typeof stat.size === 'number' && stat.size > MAX_BYTES) continue;
      let loaded;
      try { loaded = await fsModule.readFile(path); } catch (error) { lastError = error; continue; }
      const text = textOf(loaded);
      if (text == null || text.indexOf('\u0000') >= 0 || text.length > MAX_BYTES) continue;
      try {
        const parsed = parseConfigText(text);
        return { found: true, path: path, format: parsed.format, fields: parsed.fields, settings: parsed.settings };
      } catch (error) { lastError = error; }
    }
  }
  if (lastError && lastError.code) throw lastError;
  return { found: false, path: null, format: null, fields: [], settings: null, candidates: WORKSPACE_CANDIDATES.concat(CANDIDATES) };
}
