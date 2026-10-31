import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveWorkspaceRoot, normalizeWorkspacePath, workspaceAbsolutePath, workspaceParent,
  quotePosix, writeFileCommand, validateCommand, validateExecArgs, validateExecTimeout,
  validateWriteContent, WORKSPACE_LIMITS,
} from '../src/core/workspace.js';
import { createWorkspaceTools } from '../src/tools/workspace.js';
import { createToolRegistry, validateToolArguments } from '../src/tools/registry.js';
import { createHarness } from '../src/core/index.js';
import { createWorkspaceAdapter } from '../src/services/device/workspace.js';
import { createMockServer } from '../../tools/mock-openai.mjs';

const reader = () => [{ role: 'user', content: 'Synthetic workspace request' }];
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const reply = (calls, content = 'Synthetic answer') => ({ status: 200, data: { choices: [{ finish_reason: calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content: calls ? null : content, ...(calls ? { tool_calls: calls } : {}) } }] } });
function memory() {
  const values = new Map();
  const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  return { values, getJson: async (key, fallback) => values.has(key) ? clone(values.get(key)) : fallback, setJson: async (key, value) => { values.set(key, clone(value)); return true; } };
}
function tools() {
  const map = {};
  createWorkspaceTools().forEach((tool) => { map[tool.name] = tool; });
  return map;
}
function fakeWorkspace() {
  const calls = [];
  return {
    calls: calls,
    async list(path) { calls.push(['list', path]); return { root: '/ws', path: path || '', entries: [{ name: 'a.txt', type: 'file', size: 3 }, { name: 'b', type: 'dir', size: 0 }], truncated: false }; },
    async read(path) { calls.push(['read', path]); return { root: '/ws', path, bytes: 5, content: 'hello' }; },
    async write(path, content, append) { calls.push(['write', path, content, append]); return { root: '/ws', path, bytes: content.length, append }; },
    async remove(path) { calls.push(['remove', path]); return { root: '/ws', path, type: 'file', removed: true }; },
    async exec(request) {
      calls.push(['exec', request]);
      return { mode: request.command ? 'command' : 'file', cwd: request.cwd || '', code: 0, signal: null,
        stdout: 'x'.repeat(4000), stderr: 'e'.repeat(1200), timedOut: false, elapsedMs: 12, file: request.file };
    },
  };
}

test('workspace root derives from the app slot and falls back to tmp', () => {
  assert.equal(deriveWorkspaceRoot('/userdisk/secondary/miniapp/data/mini_app/pkg/8002026100700001/a/'),
    '/userdisk/secondary/miniapp/data/mini_app/pkg/8002026100700001/data/penagent-workspace');
  assert.equal(deriveWorkspaceRoot('/userdisk/secondary/miniapp/data/mini_app/pkg/8002026100700001/b'),
    '/userdisk/secondary/miniapp/data/mini_app/pkg/8002026100700001/data/penagent-workspace');
  for (const value of ['', 'relative/path', null, 7]) assert.equal(deriveWorkspaceRoot(value), '/tmp/penagent-workspace');
});

test('workspace paths are relative, bounded and traversal-free', () => {
  assert.equal(normalizeWorkspacePath(''), '');
  assert.equal(normalizeWorkspacePath('.'), '');
  assert.equal(normalizeWorkspacePath('./notes//a.txt/'), 'notes/a.txt');
  assert.equal(normalizeWorkspacePath('  notes/a.txt  '), 'notes/a.txt');
  for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'a\\b', '~/.ssh', 'a\u0000b', 'a\nb', 'x'.repeat(90), 'a/'.repeat(20) + 'x']) {
    assert.throws(() => normalizeWorkspacePath(bad), (error) => error.code === 'ARGUMENT_ERROR');
  }
  assert.throws(() => normalizeWorkspacePath('', { allowRoot: false }), (error) => error.code === 'ARGUMENT_ERROR');
  assert.equal(workspaceAbsolutePath('/ws', 'a/b'), '/ws/a/b');
  assert.equal(workspaceAbsolutePath('/ws/', ''), '/ws');
  assert.equal(workspaceParent('a/b/c.txt'), 'a/b');
  assert.equal(workspaceParent('a.txt'), '');
});

test('shell quoting and command builders preserve arbitrary text', () => {
  assert.equal(quotePosix("a'b"), "'a'\\''b'");
  assert.equal(writeFileCommand('/ws/a.txt', "x'y\nz", false), "printf '%s' 'x'\\''y\nz' > '/ws/a.txt'");
  assert.equal(writeFileCommand('/ws/a.txt', '', true), "printf '%s' '' >> '/ws/a.txt'");
  assert.equal(validateCommand('  echo hi  '), 'echo hi');
  for (const bad of ['', '   ', 'a\u0000b', 'x'.repeat(WORKSPACE_LIMITS.execCommandLength + 1)]) {
    assert.throws(() => validateCommand(bad), (error) => error.code === 'ARGUMENT_ERROR');
  }
  assert.deepEqual(validateExecArgs(['a', '']), ['a', '']);
  assert.throws(() => validateExecArgs('x'), (error) => error.code === 'ARGUMENT_ERROR');
  assert.throws(() => validateExecArgs(new Array(17).fill('a')), (error) => error.code === 'ARGUMENT_ERROR');
  assert.equal(validateExecTimeout(undefined), WORKSPACE_LIMITS.execTimeoutDefaultMs);
  assert.throws(() => validateExecTimeout(10), (error) => error.code === 'ARGUMENT_ERROR');
  assert.throws(() => validateExecTimeout(6000), (error) => error.code === 'ARGUMENT_ERROR');
  assert.throws(() => validateWriteContent('x'.repeat(WORKSPACE_LIMITS.writeBytes + 1)), (error) => error.code === 'ARGUMENT_ERROR');
});

test('workspace tool schemas reject root deletion, mixed exec modes and traversal', () => {
  const registry = createToolRegistry();
  const byName = {};
  registry.forEach((tool) => { byName[tool.name] = tool; });
  for (const name of ['file_list', 'file_read', 'file_write', 'file_delete', 'file_exec']) assert.ok(byName[name], name);
  const settings = {};
  assert.throws(() => validateToolArguments(byName.file_delete, { path: '' }, settings), (error) => error.code === 'ARGUMENT_ERROR');
  assert.throws(() => validateToolArguments(byName.file_read, { path: '../secret' }, settings), (error) => error.code === 'ARGUMENT_ERROR');
  assert.throws(() => validateToolArguments(byName.file_write, { path: 'a.txt', content: 'x', append: 'yes' }, settings), (error) => error.code === 'ARGUMENT_ERROR');
  assert.throws(() => validateToolArguments(byName.file_exec, { command: 'x', file: 'y' }, settings), (error) => error.code === 'ARGUMENT_ERROR');
  assert.throws(() => validateToolArguments(byName.file_exec, {}, settings), (error) => error.code === 'ARGUMENT_ERROR');
  assert.throws(() => validateToolArguments(byName.file_exec, { command: 'echo', timeoutMs: 10 }, settings), (error) => error.code === 'ARGUMENT_ERROR');
  validateToolArguments(byName.file_exec, { command: 'echo hi', args: ['a'], timeoutMs: 1000 }, settings);
  validateToolArguments(byName.file_list, {}, settings);
});

test('workspace tools return bounded output and missing adapters fail closed', async () => {
  const registry = tools();
  const workspace = fakeWorkspace();
  const ctx = { check() {}, workspace };
  const write = await registry.file_write.execute({ path: 'notes/a.txt', content: 'hello', append: true }, ctx);
  assert.equal(JSON.parse(write).data.append, true);
  const read = JSON.parse(await registry.file_read.execute({ path: 'notes/a.txt' }, ctx));
  assert.equal(read.data.content, 'hello');
  const list = JSON.parse(await registry.file_list.execute({}, ctx));
  assert.equal(list.data.count, 2);
  assert.equal(list.data.entries[0].name, 'a.txt');
  const removed = JSON.parse(await registry.file_delete.execute({ path: 'notes/a.txt' }, ctx));
  assert.equal(removed.data.removed, true);
  const exec = JSON.parse(await registry.file_exec.execute({ command: 'cat notes/a.txt', timeoutMs: 1200 }, ctx));
  assert.equal(exec.data.code, 0);
  assert.equal(exec.data.stdoutTruncated, true);
  assert.ok(exec.data.stdout.length <= 1410);
  const executed = JSON.parse(await registry.file_exec.execute({ file: 'run.sh', args: ['a'], cwd: '', timeoutMs: 1200 }, ctx));
  assert.equal(executed.data.mode, 'file');
  assert.deepEqual(workspace.calls.filter((entry) => entry[0] === 'exec').map((entry) => entry[1].command || entry[1].file), ['cat notes/a.txt', 'run.sh']);
  for (const tool of Object.keys(registry)) {
    if (tool === 'file_list') continue;
    await assert.rejects(registry[tool].execute({ path: 'a.txt', content: 'x', command: 'x', file: 'x', args: [] }, { check() {} }), (error) => error.code === 'CAPABILITY_UNAVAILABLE');
  }
});

test('harness advertises and executes workspace tools with setting gates', async () => {
  const workspace = fakeWorkspace();
  const store = memory();
  const requests = [];
  const replies = [
    reply([call('w1', 'file_write', { path: 'notes/a.txt', content: 'hello' }), call('r1', 'file_read', { path: 'notes/a.txt' }), call('x1', 'file_exec', { command: 'cat notes/a.txt' })]),
    reply([call('d1', 'file_delete', { path: 'notes/a.txt' })]),
    reply(null, 'workspace done'),
  ];
  const harness = createHarness({ ...store, workspace, requestJson: async (options) => { requests.push(options); return replies.shift(); } });
  const settings = { baseUrl: 'https://api.example/v1', model: 'synthetic-model', tools: { file_exec: true } };
  const result = await harness.run(reader(), settings);
  assert.equal(result.status, 'completed');
  assert.equal(result.modelRequests, 3);
  assert.equal(result.toolCalls, 4);
  const firstTools = JSON.parse(requests[0].body).tools.map((tool) => tool.function.name);
  for (const name of ['file_read', 'file_write', 'file_delete', 'file_exec']) assert.ok(firstTools.includes(name), name);
  assert.deepEqual(workspace.calls.map((entry) => entry[0]), ['write', 'read', 'exec', 'remove']);
  const outputs = result.messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(message.content));
  assert.equal(outputs[0].data.bytes, 5);
  assert.equal(outputs[1].data.content, 'hello');
  assert.equal(outputs[2].data.code, 0);
  assert.equal(outputs[3].data.removed, true);

  const disabledWorkspace = fakeWorkspace();
  let count = 0;
  const disabled = createHarness({ ...memory(), workspace: disabledWorkspace, requestJson: async () => ++count === 1 ? reply([call('x1', 'file_exec', { command: 'echo hi' })]) : reply() });
  const disabledResult = await disabled.run(reader(), { baseUrl: 'https://api.example/v1', model: 'm' });
  assert.equal(disabledResult.status, 'completed');
  assert.equal(disabledWorkspace.calls.length, 0);
  assert.equal(JSON.parse(disabledResult.messages.filter((message) => message.role === 'tool')[0].content).error.code, 'TOOL_DISABLED');
});

test('real HTTP mock drives the workspace tool loop end to end', async () => {
  const records = [];
  const { server, counts } = createMockServer({ log: (meta) => records.push(meta) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const workspace = fakeWorkspace();
    const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
    const harness = createHarness({ ...memory(), workspace, requestJson: async (options) => {
      const response = await fetch(options.url, { method: options.method, headers: options.headers, body: options.body, redirect: 'error' });
      return { status: response.status, data: await response.json() };
    } });
    const result = await harness.run([{ role: 'user', content: 'synthetic-files' }], { baseUrl, apiKey: 'test-synthetic-key', model: 'mock-gpt', developmentMode: true, tools: { file_exec: true } });
    assert.equal(result.status, 'completed');
    assert.equal(result.modelRequests, 3);
    assert.equal(result.toolCalls, 5);
    assert.equal(result.messages.at(-1).content, '文件工具循环完成：写入、读取、执行、删除均已返回。');
    assert.deepEqual(workspace.calls.map((entry) => entry[0]), ['write', 'read', 'exec', 'write', 'remove']);
    assert.equal(workspace.calls[3][1], 'notes/keep.txt');
    assert.equal(workspace.calls[4][1], 'notes/ai.txt');
    assert.equal(counts.completions, 3);
    assert.ok(!JSON.stringify(records).includes('hello from synthetic AI'));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('device adapter composes injected fs modules for list and read without platform globals', async () => {
  const files = new Map();
  files.set('/app/slot/data/penagent-workspace', { type: 'dir', mode: 0o040755 });
  files.set('/app/slot/data/penagent-workspace/a.txt', { type: 'file', mode: 0o100644, content: 'hello' });
  files.set('/app/slot/data/penagent-workspace/sub', { type: 'dir', mode: 0o040755 });
  const fs = {
    async exists(path) { return files.has(path); },
    async stat(path) { const item = files.get(path); if (!item) throw new Error('ENOENT'); return { mode: item.mode, size: item.type === 'file' ? item.content.length : 0 }; },
    async readdir(path) { return [...files.keys()].filter((key) => key.startsWith(path + '/') && key.slice(path.length + 1).indexOf('/') < 0).map((key) => key.slice(path.length + 1)); },
    async readFile(path) { const item = files.get(path); if (!item || item.type !== 'file') throw new Error('EISDIR'); return item.content; },
    async rm(path) { files.delete(path); return true; },
    async mkdir(path) { files.set(path, { type: 'dir', mode: 0o040755 }); return true; },
  };
  const adapter = createWorkspaceAdapter({
    workspacePath: '/app/slot/a/',
    loadModule: async (name) => name === 'fs' ? { default: fs } : { default: null },
  });
  assert.equal(adapter.getRoot(), '/app/slot/data/penagent-workspace');
  const capabilities = await adapter.capabilities();
  assert.equal(capabilities.filesystem, true);
  const list = await adapter.list('');
  assert.deepEqual(list.entries.map((entry) => entry.name), ['a.txt', 'sub']);
  assert.equal(list.entries[0].type, 'file');
  const read = await adapter.read('a.txt');
  assert.equal(read.content, 'hello');
  assert.equal(read.bytes, 5);
  await assert.rejects(adapter.read('sub'), (error) => error.code === 'ARGUMENT_ERROR');
  await assert.rejects(adapter.list('missing'), (error) => error.code === 'TOOL_ERROR' || error.code === 'ARGUMENT_ERROR');
});
