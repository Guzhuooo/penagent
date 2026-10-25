import { fail } from './errors.js';
import { LIMITS } from './limits.js';
import { isObject } from './schema.js';
import { jsonBytes } from './utf8.js';
export function validateToolBatch(calls, seen) {
  if (!Array.isArray(calls) || !calls.length) fail('PROTOCOL_ERROR');
  if (calls.length > LIMITS.batch) fail('LIMIT_REACHED');
  const ids = Object.create(null);
  const normalized = calls.map(function (call) {
    if (!isObject(call) || typeof call.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(call.id) ||
      call.type !== 'function' || !isObject(call.function) || typeof call.function.name !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(call.function.name) || typeof call.function.arguments !== 'string') fail('PROTOCOL_ERROR');
    if (ids[call.id] || (seen && seen[call.id])) fail('PROTOCOL_ERROR');
    ids[call.id] = true;
    return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
  });
  return normalized;
}
export function validateHistory(messages) {
  if (!Array.isArray(messages)) fail('PROTOCOL_ERROR');
  const seen = Object.create(null);
  const groups = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!isObject(m) || ['system', 'user', 'assistant', 'tool'].indexOf(m.role) < 0) fail('PROTOCOL_ERROR');
    if (m.role === 'tool') fail('PROTOCOL_ERROR');
    if (m.role !== 'assistant' && m.tool_calls != null) fail('PROTOCOL_ERROR');
    if (m.role === 'assistant' && m.tool_calls != null) {
      if (m.content !== null && typeof m.content !== 'string') fail('PROTOCOL_ERROR');
      const calls = validateToolBatch(m.tool_calls, seen);
      const group = [{ role: 'assistant', content: m.content, tool_calls: calls }];
      calls.forEach(function (call) { seen[call.id] = true; });
      calls.forEach(function (call) {
        i += 1;
        const result = messages[i];
        if (!isObject(result) || result.role !== 'tool' || result.tool_call_id !== call.id || typeof result.content !== 'string' || result.tool_calls != null) fail('PROTOCOL_ERROR');
        group.push({ role: 'tool', tool_call_id: call.id, content: result.content });
      });
      groups.push(group);
    } else {
      if (typeof m.content !== 'string') fail('PROTOCOL_ERROR');
      groups.push([{ role: m.role, content: m.content }]);
    }
  }
  return { groups: groups, seen: seen };
}
export function trimContext(messages, options) {
  const limits = options || {};
  const maxMessages = limits.maxMessages == null ? LIMITS.contextMessages : limits.maxMessages;
  const maxBytes = limits.maxBytes == null ? LIMITS.contextBytes : limits.maxBytes;
  const groups = validateHistory(messages).groups;
  let currentUser = -1;
  for (let i = 0; i < groups.length; i += 1) if (groups[i][0].role === 'user') currentUser = i;
  if (currentUser < 0) fail('PROTOCOL_ERROR');
  const protectedGroups = groups.map(function (group, index) { return group[0].role === 'system' || index >= currentUser; });
  // Prefer removing entire oldest turns; atomic groups are never split.
  const turns = [];
  let turn = [];
  groups.forEach(function (group, index) {
    if (group[0].role === 'system' || protectedGroups[index]) return;
    if (group[0].role === 'user' && turn.length) { turns.push(turn); turn = []; }
    turn.push(index);
  });
  if (turn.length) turns.push(turn);
  const removed = Object.create(null);
  function view() {
    let output = [];
    groups.forEach(function (group, index) { if (!removed[index]) output = output.concat(group); });
    return output;
  }
  let output = view();
  let oldest = 0;
  while (output.length > maxMessages || jsonBytes(output) > maxBytes) {
    if (oldest >= turns.length) fail('LIMIT_REACHED');
    turns[oldest].forEach(function (index) { removed[index] = true; });
    oldest += 1;
    output = view();
  }
  return output;
}
