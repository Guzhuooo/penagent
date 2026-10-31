// Plugin bundle specification (penagent-plugin/1).
//
// A plugin is data, never code: it may add declarative tools built from the same
// bounded recipes as define_tool, and may inject a short prompt fragment. Tools
// become available after a hot reload; installing a plugin does not rebuild the
// app or execute downloaded JavaScript.
import { buildCustomRecord, buildCustomTool, isReservedToolName, CUSTOM_TOOL_KINDS } from '../tools/custom.js';
import { fail } from '../core/errors.js';

export const PLUGIN_SCHEMA = 'penagent-plugin/1';
const ID = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;
const NAME = /^[A-Za-z0-9._ -]{1,64}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{2,31}$/;
const MAX_BYTES = 64 * 1024;

function onlyKeys(object, allowed) {
  Object.keys(object).forEach(function (key) {
    if (allowed.indexOf(key) < 0) fail('ARGUMENT_ERROR');
  });
}

export function validatePluginBundle(input, source) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('ARGUMENT_ERROR');
  onlyKeys(input, ['schema', 'id', 'name', 'version', 'description', 'prompt', 'tools']);
  if (input.schema !== PLUGIN_SCHEMA) fail('ARGUMENT_ERROR');
  if (typeof input.id !== 'string' || !ID.test(input.id)) fail('ARGUMENT_ERROR');
  if (typeof input.name !== 'string' || !NAME.test(input.name)) fail('ARGUMENT_ERROR');
  if (typeof input.version !== 'string' || !VERSION.test(input.version)) fail('ARGUMENT_ERROR');
  if (typeof input.description !== 'string' || input.description.length < 1 || input.description.length > 200) fail('ARGUMENT_ERROR');
  const prompt = input.prompt == null ? '' : input.prompt;
  if (typeof prompt !== 'string' || prompt.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(prompt)) fail('ARGUMENT_ERROR');
  if (!Array.isArray(input.tools) || input.tools.length < 1 || input.tools.length > 32) fail('ARGUMENT_ERROR');
  const seen = Object.create(null);
  const records = input.tools.map(function (tool) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) fail('ARGUMENT_ERROR');
    onlyKeys(tool, ['name', 'description', 'kind', 'spec', 'keywords']);
    if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name) || isReservedToolName(tool.name) || seen[tool.name]) fail('ARGUMENT_ERROR');
    if (CUSTOM_TOOL_KINDS.indexOf(tool.kind) < 0) fail('ARGUMENT_ERROR');
    seen[tool.name] = true;
    const record = buildCustomRecord({
      version: 1, name: tool.name, description: tool.description, kind: tool.kind, spec: tool.spec,
      keywords: tool.keywords, createdAt: 0,
    });
    return record;
  });
  const bytes = JSON.stringify(input).length;
  if (bytes > MAX_BYTES) fail('LIMIT_REACHED');
  return {
    schema: PLUGIN_SCHEMA, id: input.id, name: input.name, version: input.version,
    description: input.description, prompt: prompt.trim(), records: records,
    source: typeof source === 'string' ? source : '', bytes: bytes,
  };
}

export function buildPluginTools(plugin) {
  return plugin.records.map(function (record) {
    const tool = buildCustomTool(record);
    tool.origin = 'plugin';
    tool.pluginId = plugin.id;
    return tool;
  });
}

export function pluginCatalog(plugin) {
  return {
    id: plugin.id, name: plugin.name, version: plugin.version,
    description: plugin.description, tools: plugin.records.map(function (record) { return record.name; }),
    source: plugin.source,
  };
}
