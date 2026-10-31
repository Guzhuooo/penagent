// Pure workspace path/command helpers. No platform access, Node APIs or
// dynamic code: safe to unit test and to share between the device adapter and
// the tool definitions.
import { fail } from './errors.js';
import { utf8Bytes } from './utf8.js';

export const WORKSPACE_LIMITS = Object.freeze({
  pathLength: 200,
  segmentLength: 80,
  depth: 8,
  writeBytes: 8192,
  readBytes: 262144,
  listEntries: 100,
  execCommandLength: 512,
  execArgs: 16,
  execArgLength: 200,
  execTimeoutMinMs: 100,
  execTimeoutMaxMs: 5000,
  execTimeoutAdapterMaxMs: 25000,
  execTimeoutDefaultMs: 2000,
  outputBytes: 3500,
});

// The app installs into .../mini_app/pkg/<appid>/<slot>/ and exposes that slot
// as $workspace. Files live in a sibling data directory so an app update (which
// replaces the slot) does not delete the agent workspace.
export function deriveWorkspaceRoot(workspacePath) {
  if (typeof workspacePath !== 'string' || !/^\/[^]*$/.test(workspacePath)) return '/tmp/penagent-workspace';
  const clean = workspacePath.replace(/\/+$/, '');
  const parent = clean.replace(/\/[^/]+$/, '');
  if (!/^\/[^/]/.test(parent) || parent === '/') return '/tmp/penagent-workspace';
  return parent + '/data/penagent-workspace';
}

export function normalizeWorkspacePath(input, options) {
  const allowRoot = !options || options.allowRoot !== false;
  if (input == null || input === '') {
    if (allowRoot) return '';
    fail('ARGUMENT_ERROR');
  }
  if (typeof input !== 'string' || input.length > WORKSPACE_LIMITS.pathLength) fail('ARGUMENT_ERROR');
  const text = input.trim();
  if (text === '' || text === '.') {
    if (allowRoot) return '';
    fail('ARGUMENT_ERROR');
  }
  if (/^[\/\\]/.test(text) || /[\x00-\x1f\x7f\\]/.test(text)) fail('ARGUMENT_ERROR');
  if (text.charAt(0) === '~') fail('ARGUMENT_ERROR');
  const parts = text.split('/');
  const segments = [];
  for (let i = 0; i < parts.length; i += 1) {
    const segment = parts[i];
    if (segment === '' || segment === '.') continue;
    if (segment === '..') fail('ARGUMENT_ERROR');
    if (segment.length > WORKSPACE_LIMITS.segmentLength) fail('ARGUMENT_ERROR');
    segments.push(segment);
  }
  if (!segments.length) {
    if (allowRoot) return '';
    fail('ARGUMENT_ERROR');
  }
  if (segments.length > WORKSPACE_LIMITS.depth) fail('ARGUMENT_ERROR');
  const relative = segments.join('/');
  if (relative.length > WORKSPACE_LIMITS.pathLength) fail('ARGUMENT_ERROR');
  return relative;
}

export function workspaceAbsolutePath(root, relative) {
  if (typeof root !== 'string' || root.charAt(0) !== '/') fail('ARGUMENT_ERROR');
  const base = root.replace(/\/+$/, '');
  return relative ? base + '/' + relative : base;
}

export function workspaceParent(relative) {
  const index = relative.lastIndexOf('/');
  return index < 0 ? '' : relative.slice(0, index);
}

export function quotePosix(value) {
  if (typeof value !== 'string') fail('ARGUMENT_ERROR');
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function writeFileCommand(absolutePath, content, append) {
  if (typeof content !== 'string' || /[\x00]/.test(content)) fail('ARGUMENT_ERROR');
  return 'printf \'%s\' ' + quotePosix(content) + (append ? ' >> ' : ' > ') + quotePosix(absolutePath);
}

export function mkdirCommand(absolutePath) {
  return 'mkdir -p ' + quotePosix(absolutePath);
}

export function validateCommand(command) {
  if (typeof command !== 'string') fail('ARGUMENT_ERROR');
  const text = command.trim();
  if (!text || text.length > WORKSPACE_LIMITS.execCommandLength || /[\x00]/.test(text)) fail('ARGUMENT_ERROR');
  return text;
}

export function validateExecArgs(args) {
  if (args == null) return [];
  if (!Array.isArray(args) || args.length > WORKSPACE_LIMITS.execArgs) fail('ARGUMENT_ERROR');
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (typeof value !== 'string' || /[\x00]/.test(value) || value.length > WORKSPACE_LIMITS.execArgLength) fail('ARGUMENT_ERROR');
    out.push(value);
  }
  return out;
}

export function validateExecTimeout(value, maximum) {
  const max = maximum == null ? WORKSPACE_LIMITS.execTimeoutMaxMs : maximum;
  if (value == null) return WORKSPACE_LIMITS.execTimeoutDefaultMs;
  if (!Number.isInteger(value) || value < WORKSPACE_LIMITS.execTimeoutMinMs || value > max) fail('ARGUMENT_ERROR');
  return value;
}

export function validateWriteContent(content) {
  if (typeof content !== 'string' || /[\x00]/.test(content) || utf8Bytes(content) > WORKSPACE_LIMITS.writeBytes) fail('ARGUMENT_ERROR');
  return content;
}

// Shell consumers use /bin/sh -c; callers must already have validated the
// command text. This exists as a named helper so tests can assert the exact
// timeout wrapper (no implicit long-running shell escapes the deadline).
export function timeoutCommand(command, timeoutMs) {
  const seconds = Math.max(1, Math.ceil(validateExecTimeout(timeoutMs) / 1000));
  return { seconds: seconds, command: command };
}
