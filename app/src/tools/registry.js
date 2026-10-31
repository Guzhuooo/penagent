import { fail } from '../core/errors.js';
import { isObject, validateSchema } from '../core/schema.js';
import { allowedProbeUrl } from '../core/config.js';
import { utf8Bytes } from '../core/utf8.js';
import { calculate } from './calculator.js';
import { buildExecPreset } from './exec-presets.js';
import { CUSTOM_TOOL_KINDS, buildCustomRecord, buildCustomTool, isReservedToolName, rankTools, toolCatalog } from './custom.js';
import { createWorkspaceTools } from './workspace.js';
function object(properties, required) { return { type: 'object', properties: properties, required: required || [], additionalProperties: false }; }
function text(max) { return { type: 'string', maxLength: max }; }
function output(value) { return JSON.stringify({ ok: true, data: value }); }
const TOOL_NAME_SCHEMA = { type: 'string', minLength: 3, maxLength: 32, pattern: '^[a-z][a-z0-9_]{2,31}$' };
// Model-supplied recipe input: the version and createdAt are project-owned.
function recordInput(args) {
  return { version: 1, name: args.name, description: args.description, kind: args.kind, spec: args.spec, keywords: args.keywords };
}
function requireCustomStore(ctx) {
  if (!ctx.customTools || typeof ctx.customTools.create !== 'function' || typeof ctx.customTools.remove !== 'function') fail('CAPABILITY_UNAVAILABLE');
  return ctx.customTools;
}
function profileInfo(profile) {
  if (!isObject(profile)) fail('CAPABILITY_UNAVAILABLE');
  const info = {};
  ['profile_id', 'model', 'firmware'].forEach(function (key) {
    if (typeof profile[key] === 'string') info[key] = profile[key].slice(0, 128);
  });
  ['runtime', 'screen', 'abi'].forEach(function (section) {
    if (!isObject(profile[section])) return;
    const keys = section === 'runtime' ? ['falcon', 'quickjs', 'api'] : section === 'abi' ? ['machine', 'bits', 'libc'] : ['logical'];
    const clean = {};
    keys.forEach(function (key) {
      const value = profile[section][key];
      if (key === 'logical' && isObject(value)) {
        const logical = {};
        ['width', 'height'].forEach(function (dimension) { if (Number.isFinite(value[dimension]) && value[dimension] > 0) logical[dimension] = value[dimension]; });
        clean.logical = logical;
      } else if (typeof value === 'string') clean[key] = value.slice(0, 128);
      else if (key === 'bits' && (value === 32 || value === 64)) clean[key] = value;
    });
    info[section] = clean;
  });
  return info;
}
export function createToolRegistry(customRecords, pluginTools) {
  const registry = [
    { name: 'clock', origin: 'builtin', description: 'Current UTC time and local timezone offset.', parameters: object({}), async execute(args, ctx) {
      ctx.check();
      const date = new Date(ctx.now());
      return output({ iso: date.toISOString(), timezoneOffsetMinutes: date.getTimezoneOffset() });
    } },
    { name: 'calculator', origin: 'builtin', description: 'Bounded arithmetic: numbers, parentheses, + - * / %; no code.',
      parameters: object({ expression: Object.assign(text(512), { minLength: 1 }) }, ['expression']),
      async execute(args, ctx) { ctx.check(); return output({ value: calculate(args.expression) }); } },
    { name: 'note', origin: 'builtin', description: 'Create, read, update, or delete a local note using a bounded ID.',
      parameters: object({ op: { type: 'string', enum: ['create', 'read', 'update', 'delete'] },
        id: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' }, content: text(2048) }, ['op', 'id']),
      validate(args) {
        if ((args.op === 'create' || args.op === 'update') ? typeof args.content !== 'string' : args.content !== undefined) fail('ARGUMENT_ERROR');
        if (args.content != null && utf8Bytes(args.content) > 2048) fail('ARGUMENT_ERROR');
      },
      async execute(args, ctx) {
        return ctx.notes.enqueue(async function () {
          ctx.check();
          const key = 'pa.note.' + args.id;
          const existing = await ctx.notes.read(key, ctx.check);
          ctx.check();
          if (existing !== null && (!isObject(existing) || typeof existing.content !== 'string' || utf8Bytes(existing.content) > 2048)) fail('STORAGE_ERROR');
          if (args.op === 'read') return output({ id: args.id, exists: existing !== null, content: existing === null ? null : existing.content });
          if ((args.op === 'create' && existing !== null) || (args.op === 'update' && existing === null)) fail('ARGUMENT_ERROR');
          await ctx.notes.write(key, args.op === 'delete' ? null : { content: args.content }, ctx.check);
          ctx.check();
          return output({ id: args.id, op: args.op });
        });
      } },
    { name: 'device_info', origin: 'builtin', description: 'Selected non-private fields of the injected device profile.', parameters: object({}),
      async execute(args, ctx) {
        ctx.check();
        const profile = typeof ctx.deviceInfo === 'function' ? await ctx.deviceInfo() : ctx.deviceInfo;
        ctx.check();
        return output(profileInfo(profile));
      } },
    { name: 'net_probe', origin: 'builtin', description: 'HTTPS HEAD to a host explicitly allowed in user settings; no redirects or body.',
      parameters: object({ url: Object.assign(text(2048), { minLength: 1 }) }, ['url']),
      validate(args, settings) { allowedProbeUrl(args.url, settings.allowedProbeHosts); },
      async execute(args, ctx) {
        ctx.check();
        if (typeof ctx.headProbe !== 'function') fail('CAPABILITY_UNAVAILABLE');
        const url = allowedProbeUrl(args.url, ctx.allowedProbeHosts);
        const result = await ctx.headProbe({ url: url, method: 'HEAD', timeout: Math.min(6000, ctx.remaining()), redirect: 'error', verifyPeer: true, verifyHost: true }, ctx.cancellation);
        ctx.check();
        if (!isObject(result) || !Number.isInteger(result.status) || result.status < 100 || result.status > 599) fail('NET_TRANSPORT');
        return output({ status: result.status });
      } },
    { name: 'execShell', origin: 'builtin', description: 'Opt-in fixed read-only presets; execution status only, no arbitrary command.',
      parameters: object({ commandId: { type: 'string', enum: ['head_probe', 'system_arch', 'device_time'] }, params: { type: 'object', properties: { url: text(2048) }, additionalProperties: false } }, ['commandId', 'params']),
      validate(args, settings) { buildExecPreset(args, settings.allowedProbeHosts); },
      async execute(args, ctx) {
        ctx.check();
        // A synchronous/blocking platform shell adapter must never advertise these capabilities.
        if (typeof ctx.execPreset !== 'function' || ctx.execPreset.supportsCancellation !== true || ctx.execPreset.supportsTimeout !== true) fail('CAPABILITY_UNAVAILABLE');
        const preset = buildExecPreset(args, ctx.allowedProbeHosts);
        preset.timeout = Math.min(preset.timeout, ctx.remaining());
        const result = await ctx.execPreset(preset, ctx.cancellation);
        ctx.check();
        if (typeof result === 'boolean') return output({ success: result });
        if (!isObject(result) || !Number.isInteger(result.exitCode)) fail('TOOL_ERROR');
        return output({ success: result.exitCode === 0, exitCode: result.exitCode });
      } },
    // Meta-tools: the model can define, delete and recognize declarative
    // recipes only. They never accept executable source.
    { name: 'define_tool', origin: 'meta', description: 'Define a declarative custom tool. No code is executed. Kinds: lookup {entries:[{key,value}]}; compute {expression with {var} placeholders, variables:[{name,min?,max?}]}; template {template containing {value}}; text {operation: upper|lower|length|reverse|trim}; convert {family: length|mass|temperature}.',
      parameters: object({
        name: TOOL_NAME_SCHEMA,
        description: { type: 'string', minLength: 1, maxLength: 200 },
        kind: { type: 'string', enum: CUSTOM_TOOL_KINDS.slice() },
        spec: { type: 'object', additionalProperties: true },
        keywords: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 32 } }
      }, ['name', 'description', 'kind', 'spec']),
      validate(args) { buildCustomRecord(recordInput(args)); },
      async execute(args, ctx) {
        ctx.check();
        const store = requireCustomStore(ctx);
        const record = await store.create(recordInput(args), ctx.check);
        ctx.check();
        return output({ name: record.name, kind: record.kind, createdAt: record.createdAt });
      } },
    { name: 'delete_tool', origin: 'meta', description: 'Delete a custom tool created by define_tool. Built-in and meta tools cannot be deleted.',
      parameters: object({ name: TOOL_NAME_SCHEMA }, ['name']),
      validate(args) { if (isReservedToolName(args.name)) fail('ARGUMENT_ERROR'); },
      async execute(args, ctx) {
        ctx.check();
        const store = requireCustomStore(ctx);
        const removed = await store.remove(args.name, ctx.check);
        ctx.check();
        return output({ name: args.name, removed: removed === true });
      } },
    { name: 'list_tools', origin: 'meta', description: 'List available tools, or recognize the most relevant tools for a natural-language query.',
      parameters: object({ query: text(256) }),
      async execute(args, ctx) {
        ctx.check();
        const catalog = toolCatalog(Array.isArray(ctx.tools) ? ctx.tools : []);
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) return output({ tools: catalog, count: catalog.length });
        const matches = rankTools(catalog, query, 5);
        return output({ query: query, tools: matches, count: matches.length });
      } }
  ];
  // Workspace tools are built-ins with a narrow injected adapter. They are
  // registered even when the platform modules are unavailable so a call
  // returns a controlled CAPABILITY_UNAVAILABLE instead of TOOL_UNKNOWN.
  createWorkspaceTools().forEach(function (tool) { registry.push(tool); });
  const records = Array.isArray(customRecords) ? customRecords : [];
  records.forEach(function (record) { registry.push(buildCustomTool(record)); });
  if (Array.isArray(pluginTools)) pluginTools.forEach(function (tool) { if (tool && typeof tool.name === 'string') registry.push(tool); });
  return registry;
}
export function validateToolArguments(tool, args, settings) {
  validateSchema(args, tool.parameters);
  if (tool.validate) tool.validate(args, settings);
  return args;
}
