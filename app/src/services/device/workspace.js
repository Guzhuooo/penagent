// Device workspace adapter: the only place that touches the Falcon `fs` and
// `process` modules. Tools consume the narrow methods below, never the raw
// platform modules. All paths are relative to an app-private workspace; the
// workspace root is derived from $workspace so an app update does not delete
// agent files.
import { fail, stableError } from '../../core/errors.js';
import { utf8Bytes } from '../../core/utf8.js';
import {
  WORKSPACE_LIMITS, deriveWorkspaceRoot, normalizeWorkspacePath, workspaceAbsolutePath,
  workspaceParent, writeFileCommand, mkdirCommand, quotePosix, validateExecTimeout,
} from '../../core/workspace.js';

const DIRECTORY_MODE = 0o040000;
const REGULAR_MODE = 0o100000;
const FILE_TYPE_MASK = 0o170000;
const TIMEOUT_EXIT_CODE = 124;

function moduleValue(loaded) {
  if (!loaded) return null;
  return loaded.default || loaded;
}

async function defaultLoadModule(name) {
  if (name === 'fs') return import('fs');
  if (name === 'process') return import('process');
  if (name === 'global') return import('global');
  return null;
}

function modeType(mode) {
  if (typeof mode !== 'number') return 'other';
  const type = mode & FILE_TYPE_MASK;
  if (type === DIRECTORY_MODE) return 'dir';
  if (type === REGULAR_MODE) return 'file';
  return 'other';
}

function normalizeText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if (typeof value.result === 'string') return value.result;
    if (typeof value.data === 'string') return value.data;
  }
  return null;
}

function normalizeExec(result, started, timeoutMs) {
  const value = result && typeof result === 'object' ? result : {};
  const code = Number.isInteger(value.code) ? value.code : null;
  const stdout = typeof value.stdout === 'string' ? value.stdout : '';
  const stderr = typeof value.stderr === 'string' ? value.stderr : '';
  const elapsedMs = Math.max(0, Date.now() - started);
  return {
    code: code,
    signal: value.signal == null ? null : String(value.signal),
    stdout: stdout,
    stderr: stderr,
    timedOut: code === TIMEOUT_EXIT_CODE || (code !== 0 && elapsedMs >= timeoutMs - 150),
    elapsedMs: elapsedMs,
  };
}

export function createWorkspaceAdapter(options) {
  const injected = options || {};
  const loadModule = typeof injected.loadModule === 'function' ? injected.loadModule : defaultLoadModule;
  let root = null;
  let rootPromise = null;
  let fsPromise = null;
  let processPromise = null;
  let timeoutBinary = null;

  function workspacePath() {
    if (typeof injected.workspacePath === 'string') return injected.workspacePath;
    try { return typeof globalThis.$workspace === 'string' ? globalThis.$workspace : ''; } catch (error) { return ''; }
  }

  function getRoot() {
    if (!root) root = deriveWorkspaceRoot(workspacePath());
    return root;
  }

  async function loadFs() {
    if (!fsPromise) {
      fsPromise = Promise.resolve().then(function () { return loadModule('fs'); }).then(moduleValue).catch(function () { return null; });
    }
    return fsPromise;
  }

  async function loadProcess() {
    if (!processPromise) {
      processPromise = Promise.resolve().then(function () { return loadModule('process'); }).then(moduleValue).catch(function () { return null; });
    }
    return processPromise;
  }

  async function rawExec(file, args, options) {
    const processModule = await loadProcess();
    if (processModule && typeof processModule.exec === 'function') {
      return await processModule.exec(file, args || [], options || {});
    }
    // Fallback: the synchronous Global.execShell can run a fixed argv line but
    // returns no stdout. Callers verify side effects through fs afterwards.
    const globalModule = moduleValue(await loadModule('global'));
    if (!globalModule || typeof globalModule.Global !== 'function') fail('CAPABILITY_UNAVAILABLE');
    const manager = new globalModule.Global();
    if (typeof manager.execShell !== 'function') fail('CAPABILITY_UNAVAILABLE');
    const line = [file].concat(args || []).map(quotePosix).join(' ');
    const ok = manager.execShell(line);
    return { code: ok === true ? 0 : 1, signal: null, stdout: '', stderr: '', fallback: true };
  }

  async function shell(command, timeoutMs, cwd) {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const options = { timeout: timeoutMs + 1000, killSignal: 9, cwd: cwd, maxBuffer: 131072 };
    if (timeoutBinary === null) {
      const fsModule = await loadFs();
      timeoutBinary = !!(fsModule && typeof fsModule.exists === 'function' && await fsModule.exists('/bin/timeout'));
    }
    const started = Date.now();
    const result = timeoutBinary
      ? await rawExec('/bin/timeout', [String(seconds), '/bin/sh', '-c', command], options)
      : await rawExec('/bin/sh', ['-c', command], options);
    return normalizeExec(result, started, timeoutMs);
  }

  async function ensureRoot() {
    if (!rootPromise) {
      rootPromise = (async function () {
        const target = getRoot();
        const fsModule = await loadFs();
        if (!fsModule || typeof fsModule.exists !== 'function' || typeof fsModule.stat !== 'function') fail('CAPABILITY_UNAVAILABLE');
        try {
          if (!(await fsModule.exists(target))) {
            const result = await shell(mkdirCommand(target), 4000, '/tmp');
            if (result.code !== 0) fail('TOOL_ERROR');
          }
          const stat = await fsModule.stat(target);
          if (modeType(stat && stat.mode) !== 'dir') fail('TOOL_ERROR');
        } catch (error) { throw stableError(error, 'TOOL_ERROR'); }
        return target;
      })();
    }
    return rootPromise;
  }

  async function fsModuleOrFail() {
    const fsModule = await loadFs();
    if (!fsModule || typeof fsModule.readFile !== 'function' || typeof fsModule.readdir !== 'function' ||
      typeof fsModule.stat !== 'function' || typeof fsModule.exists !== 'function' || typeof fsModule.mkdir !== 'function' ||
      typeof fsModule.rm !== 'function') fail('CAPABILITY_UNAVAILABLE');
    return fsModule;
  }

  async function absolute(relative, allowRoot) {
    await ensureRoot();
    const normalized = normalizeWorkspacePath(relative, { allowRoot: allowRoot !== false });
    return { relative: normalized, absolute: workspaceAbsolutePath(getRoot(), normalized) };
  }

  async function list(relative) {
    const fsModule = await fsModuleOrFail();
    const target = await absolute(relative, true);
    let stat;
    try { stat = await fsModule.stat(target.absolute); } catch (error) { fail('ARGUMENT_ERROR'); }
    if (modeType(stat && stat.mode) !== 'dir') fail('ARGUMENT_ERROR');
    const names = await fsModule.readdir(target.absolute);
    if (!Array.isArray(names)) fail('TOOL_ERROR');
    const selected = names.slice(0, WORKSPACE_LIMITS.listEntries);
    const entries = [];
    for (let i = 0; i < selected.length; i += 1) {
      const name = selected[i];
      if (typeof name !== 'string' || !name) continue;
      let entry = { name: name, type: 'other', size: 0 };
      try {
        const child = await fsModule.stat(target.absolute + '/' + name);
        entry.type = modeType(child && child.mode);
        entry.size = Number.isFinite(child && child.size) ? child.size : 0;
      } catch (error) { entry.type = 'other'; }
      entries.push(entry);
    }
    entries.sort(function (left, right) { return left.name < right.name ? -1 : left.name > right.name ? 1 : 0; });
    return { root: getRoot(), path: target.relative, entries: entries, truncated: names.length > selected.length };
  }

  async function read(relative) {
    const fsModule = await fsModuleOrFail();
    const target = await absolute(relative, false);
    let stat;
    try { stat = await fsModule.stat(target.absolute); } catch (error) { fail('ARGUMENT_ERROR'); }
    if (modeType(stat && stat.mode) !== 'file') fail('ARGUMENT_ERROR');
    if (Number.isFinite(stat.size) && stat.size > WORKSPACE_LIMITS.readBytes) fail('LIMIT_REACHED');
    const loaded = await fsModule.readFile(target.absolute);
    const text = normalizeText(loaded);
    if (text === null) fail('TOOL_ERROR');
    if (text.indexOf('\u0000') >= 0) fail('TOOL_ERROR');
    return { root: getRoot(), path: target.relative, bytes: utf8Bytes(text), content: text };
  }

  async function write(relative, content, append) {
    const fsModule = await fsModuleOrFail();
    const target = await absolute(relative, false);
    const parent = workspaceParent(target.absolute);
    if (parent) {
      const made = await shell(mkdirCommand(parent), 4000, getRoot());
      if (made.code !== 0) fail('TOOL_ERROR');
    }
    const written = await shell(writeFileCommand(target.absolute, content, append === true), 4000, getRoot());
    if (written.code !== 0) fail('TOOL_ERROR');
    const stat = await fsModule.stat(target.absolute);
    if (modeType(stat && stat.mode) !== 'file') fail('TOOL_ERROR');
    return { root: getRoot(), path: target.relative, bytes: utf8Bytes(content), append: append === true };
  }

  async function remove(relative) {
    const fsModule = await fsModuleOrFail();
    const target = await absolute(relative, false);
    const stat = await fsModule.stat(target.absolute);
    const type = modeType(stat && stat.mode);
    if (type === 'dir') {
      const names = await fsModule.readdir(target.absolute);
      if (!Array.isArray(names) || names.length) fail('ARGUMENT_ERROR');
    } else if (type !== 'file') fail('ARGUMENT_ERROR');
    try {
      await fsModule.rm(target.absolute);
    } catch (error) {
      const fallback = await shell('/bin/rm -f ' + quotePosix(target.absolute), 3000, getRoot());
      if (fallback.code !== 0) fail('TOOL_ERROR');
    }
    if (await fsModule.exists(target.absolute)) fail('TOOL_ERROR');
    return { root: getRoot(), path: target.relative, type: type, removed: true };
  }

  async function exec(request) {
    await ensureRoot();
    const timeoutMs = validateExecTimeout(request.timeoutMs, WORKSPACE_LIMITS.execTimeoutAdapterMaxMs);
    const cwd = request.cwd ? normalizeWorkspacePath(request.cwd, { allowRoot: true }) : '';
    const cwdAbsolute = workspaceAbsolutePath(getRoot(), cwd);
    const fsModule = await fsModuleOrFail();
    const cwdStat = await fsModule.stat(cwdAbsolute);
    if (modeType(cwdStat && cwdStat.mode) !== 'dir') fail('ARGUMENT_ERROR');
    if (typeof request.command === 'string') {
      const result = await shell(request.command, timeoutMs, cwdAbsolute);
      return Object.assign({ mode: 'command', cwd: cwd }, result);
    }
    const target = await absolute(request.file, false);
    const fileStat = await fsModule.stat(target.absolute);
    if (modeType(fileStat && fileStat.mode) !== 'file') fail('ARGUMENT_ERROR');
    const args = Array.isArray(request.args) ? request.args : [];
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const options = { timeout: timeoutMs + 1000, killSignal: 9, cwd: cwdAbsolute, maxBuffer: 131072 };
    const started = Date.now();
    const raw = await rawExec('/bin/timeout', [String(seconds), target.absolute].concat(args), options);
    return Object.assign({ mode: 'file', cwd: cwd, file: target.relative, args: args }, normalizeExec(raw, started, timeoutMs));
  }

  async function capabilities() {
    const fsModule = await loadFs();
    const processModule = await loadProcess();
    return {
      root: getRoot(),
      filesystem: !!(fsModule && typeof fsModule.readFile === 'function' && typeof fsModule.readdir === 'function'),
      exec: !!(processModule && typeof processModule.exec === 'function'),
      timeoutBinary: timeoutBinary === null ? 'unknown' : timeoutBinary,
    };
  }

  async function selftest() {
    const steps = [];
    const dir = 'selftest';
    const file = dir + '/check.txt';
    try {
      const rootPath = await ensureRoot();
      steps.push({ step: 'root', ok: true, root: rootPath });
      await write(file, 'alpha', false);
      steps.push({ step: 'write', ok: true, path: file });
      const first = await read(file);
      steps.push({ step: 'read', ok: first.content === 'alpha', bytes: first.bytes });
      await write(file, '-beta', true);
      const second = await read(file);
      steps.push({ step: 'append', ok: second.content === 'alpha-beta' });
      const listed = await list(dir);
      steps.push({ step: 'list', ok: listed.entries.length === 1 && listed.entries[0].name === 'check.txt' });
      const execResult = await exec({ command: 'cat ' + quotePosix(file) + ' && printf exec-ok', timeoutMs: 3000 });
      steps.push({ step: 'exec', ok: execResult.code === 0 && execResult.stdout.indexOf('alpha-beta') >= 0 && execResult.stdout.indexOf('exec-ok') >= 0, code: execResult.code, timedOut: execResult.timedOut, stdout: execResult.stdout.slice(0, 120) });
      const exitResult = await exec({ command: 'exit 3', timeoutMs: 2000 });
      steps.push({ step: 'exit-code', ok: exitResult.code === 3 });
      await remove(file);
      const fsAfter = await fsModuleOrFail();
      const stillThere = await fsAfter.exists(workspaceAbsolutePath(getRoot(), file));
      steps.push({ step: 'delete', ok: !stillThere });
      await remove(dir);
      steps.push({ step: 'delete-dir', ok: !(await fsAfter.exists(workspaceAbsolutePath(getRoot(), dir))) });
      return { root: getRoot(), steps: steps, ok: steps.every(function (entry) { return entry.ok === true; }) };
    } catch (error) {
      steps.push({ step: 'error', ok: false, code: stableError(error, 'TOOL_ERROR').code });
      return { root: getRoot(), steps: steps, ok: false };
    }
  }

  return {
    getRoot: function () { return getRoot(); },
    ensureRoot: ensureRoot,
    capabilities: capabilities,
    list: list,
    read: read,
    write: write,
    remove: remove,
    exec: exec,
    selftest: selftest,
  };
}

let shared = null;
export function getWorkspaceAdapter() {
  if (!shared) shared = createWorkspaceAdapter();
  return shared;
}
