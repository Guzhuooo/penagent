import { fail } from '../core/errors.js';
import { isObject, validateSchema } from '../core/schema.js';
import { allowedProbeUrl } from '../core/config.js';
import { utf8Bytes } from '../core/utf8.js';
import { calculate } from './calculator.js';
import { buildExecPreset } from './exec-presets.js';
function object(properties, required) { return { type: 'object', properties: properties, required: required || [], additionalProperties: false }; }
function text(max) { return { type: 'string', maxLength: max }; }
function output(value) { return JSON.stringify({ ok: true, data: value }); }
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
export function createToolRegistry() {
  return [
    { name: 'clock', description: 'Current UTC time and local timezone offset.', parameters: object({}), async execute(args, ctx) {
      ctx.check();
      const date = new Date(ctx.now());
      return output({ iso: date.toISOString(), timezoneOffsetMinutes: date.getTimezoneOffset() });
    } },
    { name: 'calculator', description: 'Bounded arithmetic: numbers, parentheses, + - * / %; no code.',
      parameters: object({ expression: Object.assign(text(512), { minLength: 1 }) }, ['expression']),
      async execute(args, ctx) { ctx.check(); return output({ value: calculate(args.expression) }); } },
    { name: 'note', description: 'Create, read, update, or delete a local note using a bounded ID.',
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
    { name: 'device_info', description: 'Selected non-private fields of the injected device profile.', parameters: object({}),
      async execute(args, ctx) {
        ctx.check();
        const profile = typeof ctx.deviceInfo === 'function' ? await ctx.deviceInfo() : ctx.deviceInfo;
        ctx.check();
        return output(profileInfo(profile));
      } },
    { name: 'net_probe', description: 'HTTPS HEAD to a host explicitly allowed in user settings; no redirects or body.',
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
    { name: 'execShell', description: 'Opt-in fixed read-only presets; execution status only, no arbitrary command.',
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
      } }
  ];
}
export function validateToolArguments(tool, args, settings) {
  validateSchema(args, tool.parameters);
  if (tool.validate) tool.validate(args, settings);
  return args;
}
