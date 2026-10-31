// Workspace file and execution tools. The tools only accept workspace-relative
// paths and speak to the narrow device adapter; they never import Falcon
// platform modules directly.
import { fail } from '../core/errors.js';
import {
  WORKSPACE_LIMITS, normalizeWorkspacePath, validateCommand, validateExecArgs,
  validateExecTimeout, validateWriteContent,
} from '../core/workspace.js';
import { truncateUtf8 } from '../core/utf8.js';
import { isObject } from '../core/schema.js';

function object(properties, required) { return { type: 'object', properties: properties, required: required || [], additionalProperties: false }; }
function text(max) { return { type: 'string', maxLength: max }; }
function output(value) { return JSON.stringify({ ok: true, data: value }); }
function requireWorkspace(ctx) {
  const adapter = ctx.workspace;
  if (!adapter || typeof adapter.list !== 'function' || typeof adapter.read !== 'function' ||
    typeof adapter.write !== 'function' || typeof adapter.remove !== 'function' || typeof adapter.exec !== 'function') {
    fail('CAPABILITY_UNAVAILABLE');
  }
  return adapter;
}
function boundedText(value, maxBytes) {
  const text = typeof value === 'string' ? value : '';
  if (text.length === 0) return { text: '', truncated: false };
  const limited = truncateUtf8(text, maxBytes);
  return { text: limited, truncated: limited !== text };
}
function entryList(entries) {
  const list = [];
  for (let i = 0; i < entries.length && i < 40; i += 1) {
    const entry = entries[i];
    let name = typeof entry.name === 'string' ? entry.name : '';
    const limited = truncateUtf8(name, 96);
    list.push({ name: limited, type: entry.type || 'other', size: Number.isFinite(entry.size) ? entry.size : 0 });
  }
  return list;
}

export function createWorkspaceTools() {
  return [
    { name: 'file_list', origin: 'builtin', description: 'List files and directories inside the app workspace. Paths are workspace-relative; empty means the root.',
      parameters: object({ path: text(WORKSPACE_LIMITS.pathLength) }),
      validate(args) { normalizeWorkspacePath(args.path, { allowRoot: true }); },
      async execute(args, ctx) {
        ctx.check();
        const result = await requireWorkspace(ctx).list(args.path || '');
        ctx.check();
        return output({ root: result.root, path: result.path, count: result.entries.length, truncated: result.truncated === true, entries: entryList(result.entries) });
      } },
    { name: 'file_read', origin: 'builtin', description: 'Read a UTF-8 text file from the app workspace. Returns at most a few KiB; binary and oversized files are rejected.',
      parameters: object({ path: Object.assign(text(WORKSPACE_LIMITS.pathLength), { minLength: 1 }) }, ['path']),
      validate(args) { normalizeWorkspacePath(args.path, { allowRoot: false }); },
      async execute(args, ctx) {
        ctx.check();
        const result = await requireWorkspace(ctx).read(args.path);
        ctx.check();
        const bounded = boundedText(result.content, 2400);
        return output({ root: result.root, path: result.path, bytes: result.bytes, truncated: bounded.truncated, content: bounded.text });
      } },
    { name: 'file_write', origin: 'builtin', description: 'Create or edit a UTF-8 text file in the app workspace. append=true appends instead of overwriting; parent directories are created.',
      parameters: object({
        path: Object.assign(text(WORKSPACE_LIMITS.pathLength), { minLength: 1 }),
        content: text(WORKSPACE_LIMITS.writeBytes),
        append: { type: 'boolean' }
      }, ['path', 'content']),
      validate(args) {
        normalizeWorkspacePath(args.path, { allowRoot: false });
        validateWriteContent(args.content);
        if (args.append != null && typeof args.append !== 'boolean') fail('ARGUMENT_ERROR');
      },
      async execute(args, ctx) {
        ctx.check();
        const result = await requireWorkspace(ctx).write(args.path, args.content, args.append === true);
        ctx.check();
        return output({ root: result.root, path: result.path, bytes: result.bytes, append: result.append === true });
      } },
    { name: 'file_delete', origin: 'builtin', description: 'Delete a file or an empty directory inside the app workspace. The workspace root itself cannot be deleted.',
      parameters: object({ path: Object.assign(text(WORKSPACE_LIMITS.pathLength), { minLength: 1 }) }, ['path']),
      validate(args) { normalizeWorkspacePath(args.path, { allowRoot: false }); },
      async execute(args, ctx) {
        ctx.check();
        const result = await requireWorkspace(ctx).remove(args.path);
        ctx.check();
        return output({ root: result.root, path: result.path, type: result.type, removed: true });
      } },
    { name: 'file_exec', origin: 'builtin', description: 'Run a shell command (command) or an executable file (file + args) inside the app workspace. Output is bounded and a hard timeout applies. Enabled by the user only.',
      parameters: object({
        command: text(WORKSPACE_LIMITS.execCommandLength),
        file: text(WORKSPACE_LIMITS.pathLength),
        args: { type: 'array', maxItems: WORKSPACE_LIMITS.execArgs, items: text(WORKSPACE_LIMITS.execArgLength) },
        cwd: text(WORKSPACE_LIMITS.pathLength),
        timeoutMs: { type: 'integer', minimum: WORKSPACE_LIMITS.execTimeoutMinMs, maximum: WORKSPACE_LIMITS.execTimeoutMaxMs }
      }),
      validate(args) {
        const hasCommand = typeof args.command === 'string' && args.command.trim() !== '';
        const hasFile = typeof args.file === 'string' && args.file.trim() !== '';
        if (hasCommand === hasFile) fail('ARGUMENT_ERROR');
        if (hasCommand) validateCommand(args.command);
        if (hasFile) normalizeWorkspacePath(args.file, { allowRoot: false });
        validateExecArgs(args.args);
        if (args.cwd != null) normalizeWorkspacePath(args.cwd, { allowRoot: true });
        validateExecTimeout(args.timeoutMs);
      },
      async execute(args, ctx) {
        ctx.check();
        const request = { timeoutMs: validateExecTimeout(args.timeoutMs) };
        if (typeof args.command === 'string' && args.command.trim() !== '') request.command = validateCommand(args.command);
        else request.file = normalizeWorkspacePath(args.file, { allowRoot: false });
        const execArgs = validateExecArgs(args.args);
        if (execArgs.length) request.args = execArgs;
        if (args.cwd != null) request.cwd = normalizeWorkspacePath(args.cwd, { allowRoot: true });
        const result = await requireWorkspace(ctx).exec(request);
        ctx.check();
        const stdout = boundedText(result.stdout, 1400);
        const stderr = boundedText(result.stderr, 900);
        return output({
          mode: result.mode || 'command', cwd: result.cwd || '', path: result.file || args.file || '',
          code: Number.isInteger(result.code) ? result.code : null,
          signal: result.signal || null, timedOut: result.timedOut === true,
          elapsedMs: result.elapsedMs || 0,
          stdout: stdout.text, stdoutTruncated: stdout.truncated,
          stderr: stderr.text, stderrTruncated: stderr.truncated
        });
      } }
  ];
}

export function isWorkspaceTool(name) {
  return ['file_list', 'file_read', 'file_write', 'file_delete', 'file_exec'].indexOf(name) >= 0;
}

export function workspaceToolResult(value) {
  if (!isObject(value)) return null;
  return value;
}
