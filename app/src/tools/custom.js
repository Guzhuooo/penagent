// ============================================================
// 声明式自定义工具（recipe）—— 纯逻辑，无动态代码
// ------------------------------------------------------------
// 模型只能通过受限的声明式 recipe（lookup / compute / template /
// text / convert）定义工具；本项目永不编译、解释或执行模型提交的
// 任意代码。所有 recipe 在执行前逐字段验证，执行时为有界同步计算。
// 事实来源：docs/STANDARDS.md §6 / §7、docs/CUSTOM_TOOLS.md。
// ============================================================

import { fail, stableError } from '../core/errors.js';
import { LIMITS } from '../core/limits.js';
import { isObject } from '../core/schema.js';
import { jsonBytes } from '../core/utf8.js';
import { TOOL_NAMES } from '../core/config.js';
import { calculate, CALCULATOR_LIMITS } from './calculator.js';

export const CUSTOM_TOOL_KINDS = Object.freeze(['lookup', 'compute', 'template', 'text', 'convert']);

const RECORD_KEYS = ['version', 'name', 'description', 'kind', 'spec', 'keywords', 'createdAt'];
const NAME_CHARS = 32;
const DESCRIPTION_CHARS = 200;
const KEYWORD_COUNT = 8;
const KEYWORD_CHARS = 32;
const NAME_PATTERN = /^[a-z][a-z0-9_]{2,31}$/;
const VARIABLE_PATTERN = /^[a-z][a-z0-9_]{0,15}$/;

const TEXT_OPERATIONS = Object.freeze(['upper', 'lower', 'length', 'reverse', 'trim']);

// Conversion tables are fixed project data; the model can select units but
// never supply factors or formulas.
const CONVERT_FAMILIES = Object.freeze({
  length: Object.freeze({
    units: Object.freeze(['mm', 'cm', 'm', 'km', 'in', 'ft', 'mi']),
    factors: Object.freeze({ mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, mi: 1609.344 })
  }),
  mass: Object.freeze({
    units: Object.freeze(['mg', 'g', 'kg', 't', 'lb', 'oz']),
    factors: Object.freeze({ mg: 0.000001, g: 0.001, kg: 1, t: 1000, lb: 0.45359237, oz: 0.028349523125 })
  }),
  temperature: Object.freeze({
    units: Object.freeze(['c', 'f', 'k'])
  })
});

function textLimits(value, maxChars, minChars) {
  if (typeof value !== 'string' || value.length < minChars || value.length > maxChars) fail('ARGUMENT_ERROR');
  return value;
}

function forbiddenControl(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function onlyKeys(value, allowed) {
  if (!isObject(value)) fail('ARGUMENT_ERROR');
  Object.keys(value).forEach(function (key) {
    if (allowed.indexOf(key) < 0) fail('ARGUMENT_ERROR');
  });
  return value;
}

function finiteNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12) fail('ARGUMENT_ERROR');
  return value;
}

export function isReservedToolName(name) {
  return typeof name === 'string' && TOOL_NAMES.indexOf(name) >= 0;
}

function validateToolName(value) {
  if (typeof value !== 'string' || value.length > NAME_CHARS) fail('ARGUMENT_ERROR');
  if (!NAME_PATTERN.test(value)) fail('ARGUMENT_ERROR');
  if (isReservedToolName(value)) fail('ARGUMENT_ERROR');
  return value;
}

function validateDescription(value) {
  const text = textLimits(value, DESCRIPTION_CHARS, 1).trim();
  if (!text || forbiddenControl(text)) fail('ARGUMENT_ERROR');
  return text;
}

function validateKeywords(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > KEYWORD_COUNT) fail('ARGUMENT_ERROR');
  const seen = Object.create(null);
  const keywords = [];
  value.forEach(function (entry) {
    const text = textLimits(entry, KEYWORD_CHARS, 1).trim();
    if (!text || forbiddenControl(text)) fail('ARGUMENT_ERROR');
    if (seen[text]) return;
    seen[text] = true;
    keywords.push(text);
  });
  return keywords;
}

// ---------- kind-specific spec validators ----------

function normalizeLookupSpec(spec) {
  onlyKeys(spec, ['entries']);
  if (!Array.isArray(spec.entries) || spec.entries.length < 1 || spec.entries.length > 32) fail('ARGUMENT_ERROR');
  const seen = Object.create(null);
  const entries = spec.entries.map(function (entry) {
    onlyKeys(entry, ['key', 'value']);
    const key = textLimits(entry.key, 64, 1);
    const value = textLimits(entry.value, 512, 0);
    if (seen[key]) fail('ARGUMENT_ERROR');
    seen[key] = true;
    return { key: key, value: value };
  });
  return { entries: entries };
}

function scanPlaceholders(expression) {
  const names = [];
  for (let i = 0; i < expression.length; i += 1) {
    const character = expression.charAt(i);
    if (character === '}') fail('ARGUMENT_ERROR');
    if (character !== '{') continue;
    const end = expression.indexOf('}', i + 1);
    if (end < 0 || end - i > 24) fail('ARGUMENT_ERROR');
    names.push(expression.slice(i + 1, end));
    i = end;
  }
  return names;
}

function representativeValue(variable) {
  if (variable.min != null && variable.min > 1) return variable.min;
  if (variable.max != null && variable.max < 1) return variable.max;
  return 1;
}

function normalizeComputeSpec(spec) {
  onlyKeys(spec, ['expression', 'variables']);
  const expression = textLimits(spec.expression, 256, 1);
  if (forbiddenControl(expression)) fail('ARGUMENT_ERROR');
  if (!Array.isArray(spec.variables) || spec.variables.length < 1 || spec.variables.length > 4) fail('ARGUMENT_ERROR');
  const seen = Object.create(null);
  const variables = spec.variables.map(function (entry) {
    onlyKeys(entry, ['name', 'min', 'max']);
    if (typeof entry.name !== 'string' || entry.name.length > 16 || !VARIABLE_PATTERN.test(entry.name)) fail('ARGUMENT_ERROR');
    if (seen[entry.name]) fail('ARGUMENT_ERROR');
    seen[entry.name] = true;
    const variable = { name: entry.name };
    if (entry.min !== undefined) variable.min = finiteNumber(entry.min);
    if (entry.max !== undefined) variable.max = finiteNumber(entry.max);
    if (variable.min != null && variable.max != null && variable.min > variable.max) fail('ARGUMENT_ERROR');
    return variable;
  });
  const placeholders = scanPlaceholders(expression);
  if (!placeholders.length) fail('ARGUMENT_ERROR');
  placeholders.forEach(function (name) {
    if (!seen[name]) fail('ARGUMENT_ERROR');
  });
  variables.forEach(function (variable) {
    if (placeholders.indexOf(variable.name) < 0) fail('ARGUMENT_ERROR');
  });
  // Grammar check with bounded representative values: a recipe that cannot
  // evaluate at creation time can never evaluate at run time.
  let sample = expression;
  variables.forEach(function (variable) {
    sample = sample.split('{' + variable.name + '}').join('(' + String(representativeValue(variable)) + ')');
  });
  if (sample.length > CALCULATOR_LIMITS.characters) fail('ARGUMENT_ERROR');
  try { calculate(sample); } catch (_) { fail('ARGUMENT_ERROR'); }
  return { expression: expression, variables: variables };
}

function normalizeTemplateSpec(spec) {
  onlyKeys(spec, ['template']);
  const template = textLimits(spec.template, 300, 1);
  const placeholders = scanPlaceholders(template);
  if (!placeholders.length || placeholders.length > 4) fail('ARGUMENT_ERROR');
  placeholders.forEach(function (name) { if (name !== 'value') fail('ARGUMENT_ERROR'); });
  return { template: template };
}

function normalizeKindSpec(kind, spec) {
  if (kind === 'lookup') return normalizeLookupSpec(spec);
  if (kind === 'compute') return normalizeComputeSpec(spec);
  if (kind === 'template') return normalizeTemplateSpec(spec);
  if (kind === 'text') {
    onlyKeys(spec, ['operation']);
    if (TEXT_OPERATIONS.indexOf(spec.operation) < 0) fail('ARGUMENT_ERROR');
    return { operation: spec.operation };
  }
  if (kind === 'convert') {
    onlyKeys(spec, ['family']);
    if (!Object.prototype.hasOwnProperty.call(CONVERT_FAMILIES, spec.family)) fail('ARGUMENT_ERROR');
    return { family: spec.family };
  }
  fail('ARGUMENT_ERROR');
}

// ---------- record normalization ----------

function normalizeRecord(input, requireCreatedAt) {
  onlyKeys(input, RECORD_KEYS);
  if (input.version !== 1) fail('ARGUMENT_ERROR');
  const name = validateToolName(input.name);
  const description = validateDescription(input.description);
  if (CUSTOM_TOOL_KINDS.indexOf(input.kind) < 0) fail('ARGUMENT_ERROR');
  const spec = normalizeKindSpec(input.kind, input.spec);
  const keywords = validateKeywords(input.keywords);
  let createdAt;
  if (input.createdAt === undefined && !requireCreatedAt) createdAt = Date.now();
  else {
    if (typeof input.createdAt !== 'number' || !Number.isFinite(input.createdAt) || input.createdAt < 0 || !Number.isInteger(input.createdAt)) fail('ARGUMENT_ERROR');
    createdAt = input.createdAt;
  }
  const record = { version: 1, name: name, description: description, kind: input.kind, spec: spec, createdAt: createdAt };
  if (keywords.length) record.keywords = keywords;
  if (jsonBytes(record) > LIMITS.customToolBytes) fail('LIMIT_REACHED');
  return record;
}

export function buildCustomRecord(input) {
  return normalizeRecord(input, false);
}

function catalogShape(tools) {
  const catalog = { version: 1, tools: tools };
  if (jsonBytes(catalog) > LIMITS.customCatalogBytes) fail('LIMIT_REACHED');
  return catalog;
}

// Defensive read path: anything persisted but invalid fails closed instead of
// silently becoming an empty or partial catalog.
export function validateStoredCatalog(value) {
  try {
    onlyKeys(value, ['version', 'tools']);
    if (value.version !== 1 || !Array.isArray(value.tools)) fail('STORAGE_ERROR');
    if (value.tools.length > LIMITS.customTools) fail('STORAGE_ERROR');
    const names = Object.create(null);
    const tools = value.tools.map(function (entry) {
      const record = normalizeRecord(entry, true);
      if (names[record.name]) fail('STORAGE_ERROR');
      names[record.name] = true;
      return record;
    });
    return catalogShape(tools);
  } catch (error) {
    stableError(error, 'STORAGE_ERROR');
    fail('STORAGE_ERROR');
  }
}

// ---------- runtime tool construction ----------

function objectSchema(properties, required) {
  return { type: 'object', properties: properties, required: required || [], additionalProperties: false };
}

function parametersFor(kind, spec) {
  if (kind === 'lookup') return objectSchema({ key: { type: 'string', minLength: 1, maxLength: 64 } }, ['key']);
  if (kind === 'compute') {
    const properties = {};
    const required = [];
    spec.variables.forEach(function (variable) {
      const property = { type: 'number' };
      if (variable.min != null) property.minimum = variable.min;
      if (variable.max != null) property.maximum = variable.max;
      properties[variable.name] = property;
      required.push(variable.name);
    });
    return objectSchema(properties, required);
  }
  if (kind === 'template') return objectSchema({ value: { type: 'string', maxLength: 512 } }, ['value']);
  if (kind === 'text') return objectSchema({ text: { type: 'string', minLength: 1, maxLength: 1024 } }, ['text']);
  const family = CONVERT_FAMILIES[spec.family];
  return objectSchema({
    value: { type: 'number', minimum: -1e12, maximum: 1e12 },
    from: { type: 'string', enum: family.units.slice() },
    to: { type: 'string', enum: family.units.slice() }
  }, ['value', 'from', 'to']);
}

function guardText(value, maxChars, minChars) {
  if (typeof value !== 'string' || value.length < minChars || value.length > maxChars) fail('ARGUMENT_ERROR');
  return value;
}

function executeLookup(spec, args) {
  const key = guardText(args.key, 64, 1);
  for (let i = 0; i < spec.entries.length; i += 1) {
    if (spec.entries[i].key === key) return { found: true, value: spec.entries[i].value };
  }
  return { found: false };
}

function executeCompute(spec, args) {
  let expression = spec.expression;
  spec.variables.forEach(function (variable) {
    const value = args[variable.name];
    if (typeof value !== 'number' || !Number.isFinite(value)) fail('ARGUMENT_ERROR');
    expression = expression.split('{' + variable.name + '}').join('(' + String(value) + ')');
  });
  if (expression.indexOf('{') >= 0 || expression.indexOf('}') >= 0) fail('ARGUMENT_ERROR');
  if (expression.length > CALCULATOR_LIMITS.characters) fail('ARGUMENT_ERROR');
  const value = calculate(expression);
  return { value: value === 0 ? 0 : value };
}

function executeTemplate(spec, args) {
  const value = guardText(args.value, 512, 0);
  return { value: spec.template.split('{value}').join(value) };
}

function codePointLength(text) {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

function reverseCodePoints(text) {
  const points = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        points.push(text.slice(i, i + 2));
        i += 1;
        continue;
      }
    }
    points.push(text.charAt(i));
  }
  return points.reverse().join('');
}

function executeText(spec, args) {
  const text = guardText(args.text, 1024, 1);
  if (spec.operation === 'upper') return { operation: spec.operation, value: text.toUpperCase() };
  if (spec.operation === 'lower') return { operation: spec.operation, value: text.toLowerCase() };
  if (spec.operation === 'trim') return { operation: spec.operation, value: text.trim() };
  if (spec.operation === 'length') return { operation: spec.operation, value: codePointLength(text) };
  return { operation: spec.operation, value: reverseCodePoints(text) };
}

function roundResult(value) {
  if (!Number.isFinite(value) || Math.abs(value) > 1e15) fail('TOOL_ERROR');
  const rounded = Math.round(value * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
}

function temperatureToCelsius(value, unit) {
  if (unit === 'c') return value;
  if (unit === 'f') return (value - 32) * 5 / 9;
  return value - 273.15;
}

function celsiusToTemperature(value, unit) {
  if (unit === 'c') return value;
  if (unit === 'f') return value * 9 / 5 + 32;
  return value + 273.15;
}

function executeConvert(spec, args) {
  const value = args.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('ARGUMENT_ERROR');
  const family = CONVERT_FAMILIES[spec.family];
  if (family.units.indexOf(args.from) < 0 || family.units.indexOf(args.to) < 0) fail('ARGUMENT_ERROR');
  if (spec.family === 'temperature') {
    return { family: spec.family, from: args.from, to: args.to,
      value: roundResult(celsiusToTemperature(temperatureToCelsius(value, args.from), args.to)) };
  }
  const base = value * family.factors[args.from];
  const result = base / family.factors[args.to];
  return { family: spec.family, from: args.from, to: args.to, value: roundResult(result) };
}

export function buildCustomTool(record) {
  const normalized = normalizeRecord(record, true);
  const kind = normalized.kind;
  const spec = normalized.spec;
  const tool = {
    name: normalized.name,
    description: normalized.description,
    parameters: parametersFor(kind, spec),
    origin: 'custom',
    kind: kind,
    keywords: (normalized.keywords || []).slice(),
    async execute(args, ctx) {
      ctx.check();
      let data;
      if (kind === 'lookup') data = executeLookup(spec, args);
      else if (kind === 'compute') data = executeCompute(spec, args);
      else if (kind === 'template') data = executeTemplate(spec, args);
      else if (kind === 'text') data = executeText(spec, args);
      else data = executeConvert(spec, args);
      ctx.check();
      return JSON.stringify({ ok: true, data: data });
    }
  };
  return tool;
}

// ---------- recognition ranking ----------

function truncateLabel(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

function queryTokens(needle) {
  const tokens = [];
  const seen = Object.create(null);
  function add(token) {
    if (!token || token.length > KEYWORD_CHARS || seen[token] || tokens.length >= 24) return;
    seen[token] = true;
    tokens.push(token);
  }
  let ascii = '';
  for (let i = 0; i < needle.length; i += 1) {
    const code = needle.charCodeAt(i);
    const isAscii = (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || code === 95;
    if (isAscii) { ascii += needle.charAt(i); continue; }
    if (ascii.length >= 2) add(ascii);
    ascii = '';
  }
  if (ascii.length >= 2) add(ascii);
  for (let i = 0; i + 1 < needle.length; i += 1) {
    const first = needle.charCodeAt(i);
    const second = needle.charCodeAt(i + 1);
    if (first >= 0x4e00 && first <= 0x9fff && second >= 0x4e00 && second <= 0x9fff) add(needle.charAt(i) + needle.charAt(i + 1));
  }
  // A one-character CJK query has no bigram; keep it as a single token.
  if (needle.length === 1) {
    const only = needle.charCodeAt(0);
    if (only >= 0x4e00 && only <= 0x9fff) add(needle);
  }
  return tokens;
}

export function rankTools(catalog, query, limit) {
  if (typeof query !== 'string') fail('ARGUMENT_ERROR');
  if (query.length > 256) fail('ARGUMENT_ERROR');
  const needle = query.trim().toLowerCase();
  const max = limit == null ? 5 : limit;
  if (!Number.isInteger(max) || max < 1 || max > 20) fail('ARGUMENT_ERROR');
  if (!needle || !Array.isArray(catalog)) return [];
  const tokens = queryTokens(needle);
  const scored = [];
  catalog.slice(0, 64).forEach(function (entry) {
    if (!isObject(entry) || typeof entry.name !== 'string') return;
    const name = entry.name.toLowerCase();
    const description = typeof entry.description === 'string' ? entry.description.toLowerCase() : '';
    const keywords = Array.isArray(entry.keywords) ? entry.keywords.filter(function (item) { return typeof item === 'string'; }).map(function (item) { return item.toLowerCase(); }) : [];
    let score = 0;
    const reasons = [];
    function reason(value) { if (reasons.indexOf(value) < 0) reasons.push(value); }
    if (name === needle) {
      score = 100;
      reason('exact_name');
    } else {
      if (name.indexOf(needle) >= 0) { score += 60; reason('name'); }
      tokens.forEach(function (token) {
        let matched = false;
        if (keywords.some(function (item) { return item.indexOf(token) >= 0; })) { score += 15; matched = true; reason('keyword'); }
        if (name.indexOf(token) >= 0) { score += 20; matched = true; reason('name'); }
        if (description.indexOf(token) >= 0) { score += 8; matched = true; reason('description'); }
        if (!matched) return;
      });
    }
    if (score <= 0) return;
    scored.push({
      name: entry.name,
      description: truncateLabel(typeof entry.description === 'string' ? entry.description : '', 100),
      origin: typeof entry.origin === 'string' ? entry.origin : 'builtin',
      kind: typeof entry.kind === 'string' ? entry.kind : '',
      score: score,
      reason: reasons.join('+')
    });
  });
  scored.sort(function (left, right) {
    if (left.score !== right.score) return right.score - left.score;
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    return 0;
  });
  return scored.slice(0, max);
}

export function toolCatalog(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.slice(0, 64).map(function (tool) {
    const entry = {
      name: tool.name,
      description: truncateLabel(typeof tool.description === 'string' ? tool.description : '', 100),
      origin: typeof tool.origin === 'string' ? tool.origin : 'builtin',
      kind: typeof tool.kind === 'string' ? tool.kind : ''
    };
    if (Array.isArray(tool.keywords) && tool.keywords.length) entry.keywords = tool.keywords.slice(0, KEYWORD_COUNT);
    return entry;
  });
}

// ---------- persistent store ----------

function cloneCatalog(tools) {
  return JSON.parse(JSON.stringify(tools));
}

export function createCustomToolStore(storage) {
  const state = { loaded: false, available: true, dirty: false, error: null, count: 0 };
  let records = [];
  let loaded = false;
  let loading = null;
  let loadFailure = null;

  async function loadOnce() {
    try {
      const value = await storage.read('pa.customTools', null, { version: 1, tools: [] });
      const catalog = validateStoredCatalog(value);
      records = catalog.tools;
      state.available = true;
    } catch (error) {
      const safe = stableError(error, 'STORAGE_ERROR');
      if (safe.code !== 'CAPABILITY_UNAVAILABLE') throw safe;
      // No storage adapters: read-only listing stays empty, mutations fail.
      records = [];
      state.available = false;
    }
    loaded = true;
    state.loaded = true;
    state.count = records.length;
    return records;
  }

  function ensureLoaded() {
    if (loadFailure) return Promise.reject(loadFailure);
    if (loaded) return Promise.resolve(records);
    if (!loading) {
      loading = storage.enqueue(loadOnce).then(function (value) {
        loading = null;
        return value;
      }, function (error) {
        loading = null;
        loaded = true;
        loadFailure = stableError(error, 'STORAGE_ERROR');
        state.loaded = true;
        state.error = loadFailure.code;
        throw loadFailure;
      });
    }
    return loading;
  }

  async function create(input, guard) {
    await ensureLoaded();
    if (!state.available) fail('CAPABILITY_UNAVAILABLE');
    if (records.length >= LIMITS.customTools) fail('LIMIT_REACHED');
    const record = buildCustomRecord(input);
    for (let i = 0; i < records.length; i += 1) {
      if (records[i].name === record.name) fail('ARGUMENT_ERROR');
    }
    const next = records.concat([record]);
    const catalog = catalogShape(next);
    try {
      await storage.write('pa.customTools', catalog, guard);
    } catch (error) {
      state.dirty = true;
      state.error = stableError(error, 'STORAGE_ERROR').code;
      throw stableError(error, 'STORAGE_ERROR');
    }
    records = next;
    state.count = records.length;
    state.dirty = false;
    state.error = null;
    return JSON.parse(JSON.stringify(record));
  }

  async function remove(name, guard) {
    await ensureLoaded();
    if (!state.available) fail('CAPABILITY_UNAVAILABLE');
    if (typeof name !== 'string' || name.length > NAME_CHARS || !NAME_PATTERN.test(name) || isReservedToolName(name)) fail('ARGUMENT_ERROR');
    let index = -1;
    for (let i = 0; i < records.length; i += 1) if (records[i].name === name) index = i;
    if (index < 0) return false;
    const next = records.slice();
    next.splice(index, 1);
    const catalog = catalogShape(next);
    try {
      await storage.write('pa.customTools', catalog, guard);
    } catch (error) {
      state.dirty = true;
      state.error = stableError(error, 'STORAGE_ERROR').code;
      throw stableError(error, 'STORAGE_ERROR');
    }
    records = next;
    state.count = records.length;
    state.dirty = false;
    state.error = null;
    return true;
  }

  function list() {
    return cloneCatalog(records);
  }

  return {
    state: state,
    ensureLoaded: ensureLoaded,
    records: function () { return records; },
    list: list,
    create: create,
    remove: remove
  };
}
