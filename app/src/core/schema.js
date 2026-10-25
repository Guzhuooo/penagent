import { fail } from './errors.js';
import { LIMITS } from './limits.js';
import { utf8Bytes } from './utf8.js';
export function isObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
export function validateSafe(value) {
  let nodes = 0;
  function visit(item, depth) {
    nodes += 1;
    if (depth > LIMITS.schemaDepth || nodes > LIMITS.schemaNodes) fail('ARGUMENT_ERROR');
    if (typeof item === 'string' && utf8Bytes(item) > LIMITS.argumentBytes) fail('ARGUMENT_ERROR');
    if (typeof item === 'number' && !Number.isFinite(item)) fail('ARGUMENT_ERROR');
    if (item && typeof item === 'object') {
      if (!Array.isArray(item) && !isObject(item)) fail('ARGUMENT_ERROR');
      Object.keys(item).forEach(function (key) {
        if (key.length > 128 || key === '__proto__' || key === 'constructor' || key === 'prototype') fail('ARGUMENT_ERROR');
        visit(item[key], depth + 1);
      });
    } else if (item !== null && ['string', 'number', 'boolean'].indexOf(typeof item) < 0) fail('ARGUMENT_ERROR');
  }
  visit(value, 0);
  return value;
}
// Only this subset is advertised by the built-in registry.
export function validateSchema(value, schema) {
  validateSafe(value);
  function check(item, rule) {
    const type = rule.type;
    if (type === 'object') {
      if (!isObject(item)) fail('ARGUMENT_ERROR');
      (rule.required || []).forEach(function (key) { if (!Object.prototype.hasOwnProperty.call(item, key)) fail('ARGUMENT_ERROR'); });
      Object.keys(item).forEach(function (key) {
        if (rule.properties && Object.prototype.hasOwnProperty.call(rule.properties, key)) check(item[key], rule.properties[key]);
        else if (rule.additionalProperties !== true) fail('ARGUMENT_ERROR');
      });
    } else if (type === 'array') {
      if (!Array.isArray(item) || item.length > (rule.maxItems == null ? 256 : rule.maxItems) || item.length < (rule.minItems || 0)) fail('ARGUMENT_ERROR');
      item.forEach(function (entry) { check(entry, rule.items); });
    } else if (type === 'string') {
      if (typeof item !== 'string' || item.length < (rule.minLength || 0) || item.length > (rule.maxLength == null ? 8192 : rule.maxLength)) fail('ARGUMENT_ERROR');
      if (rule.pattern && !(new RegExp(rule.pattern)).test(item)) fail('ARGUMENT_ERROR');
    } else if (type === 'number' || type === 'integer') {
      if (typeof item !== 'number' || !Number.isFinite(item) || (type === 'integer' && !Number.isInteger(item)) ||
        (rule.minimum != null && item < rule.minimum) || (rule.maximum != null && item > rule.maximum)) fail('ARGUMENT_ERROR');
    } else if (type === 'boolean') { if (typeof item !== 'boolean') fail('ARGUMENT_ERROR'); }
    else fail('ARGUMENT_ERROR');
    if (rule.enum && rule.enum.indexOf(item) < 0) fail('ARGUMENT_ERROR');
  }
  check(value, schema);
  return value;
}
export function parseArguments(text, schema) {
  if (typeof text !== 'string' || utf8Bytes(text) > LIMITS.argumentBytes) fail('ARGUMENT_ERROR');
  let args;
  try { args = JSON.parse(text); } catch (_) { fail('ARGUMENT_ERROR'); }
  if (!isObject(args)) fail('ARGUMENT_ERROR');
  return validateSchema(args, schema);
}
