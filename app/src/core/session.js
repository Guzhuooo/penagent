import { fail } from './errors.js';
import { LIMITS } from './limits.js';
import { isObject } from './schema.js';
import { validateHistory } from './context.js';
import { jsonBytes, utf8Bytes } from './utf8.js';
let nextSession = 0;
export function createSession(title) {
  const name = title == null ? 'New conversation' : title;
  if (typeof name !== 'string' || !name.trim() || name.length > 128) fail('ARGUMENT_ERROR');
  nextSession += 1;
  const time = Date.now();
  return { id: 's-' + time.toString(36) + '-' + nextSession.toString(36), title: name.trim(), createdAt: time, updatedAt: time, messages: [] };
}
export function validateToolAudit(audit) {
  if (!Array.isArray(audit)) fail('STORAGE_ERROR');
  if (audit.length > LIMITS.toolAuditIds) fail('LIMIT_REACHED');
  const seen = Object.create(null);
  return audit.map(function (entry) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.id) || seen[entry.id] ||
      typeof entry.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.name) ||
      ['reserved', 'started', 'completed', 'error', 'cancelled'].indexOf(entry.status) < 0 ||
      Object.keys(entry).some(function (key) { return ['id', 'name', 'status', 'result'].indexOf(key) < 0; })) fail('STORAGE_ERROR');
    seen[entry.id] = true;
    const copy = { id: entry.id, name: entry.name, status: entry.status };
    if (Object.prototype.hasOwnProperty.call(entry, 'result')) {
      if (typeof entry.result !== 'string' || utf8Bytes(entry.result) > LIMITS.resultBytes) fail('STORAGE_ERROR');
      copy.result = entry.result;
    }
    return copy;
  });
}
export function validateSession(session) {
  if (!isObject(session) || typeof session.id !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(session.id) ||
    typeof session.title !== 'string' || !session.title.trim() || session.title.length > 128 ||
    !Number.isFinite(session.createdAt) || !Number.isFinite(session.updatedAt) || session.createdAt < 0 || session.updatedAt < session.createdAt) fail('STORAGE_ERROR');
  const messages = validateHistory(session.messages).groups.reduce(function (all, group) { return all.concat(group); }, []);
  const copy = { id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, messages: messages };
  if (Object.prototype.hasOwnProperty.call(session, 'toolAudit')) copy.toolAudit = validateToolAudit(session.toolAudit);
  if (jsonBytes(copy) > LIMITS.sessionBytes) fail('LIMIT_REACHED');
  return copy;
}
function validateIndex(index) {
  if (!isObject(index) || !Array.isArray(index.entries)) fail('STORAGE_ERROR');
  if (index.entries.length > LIMITS.sessions) fail('LIMIT_REACHED');
  const seen = Object.create(null);
  let total = 0;
  index.entries.forEach(function (entry) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(entry.id) || seen[entry.id] ||
      (entry.slot !== 0 && entry.slot !== 1) || !Number.isInteger(entry.revision) || entry.revision < 1 ||
      !Number.isInteger(entry.chunks) || entry.chunks < 1 || entry.chunks > 96 || !Number.isInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > LIMITS.sessionBytes) fail('STORAGE_ERROR');
    seen[entry.id] = true; total += entry.bytes;
  });
  if (total > LIMITS.historyBytes) fail('LIMIT_REACHED');
  return index;
}
export function createSessionStore(storage) {
  async function readIndex() { return validateIndex(await storage.read('pa.sessions', null, { entries: [] })); }
  async function readEntry(entry) {
    let text = '';
    for (let i = 0; i < entry.chunks; i += 1) {
      const chunk = await storage.read('pa.session.' + entry.id + '.' + entry.slot + '.' + i);
      if (!isObject(chunk) || chunk.revision !== entry.revision || typeof chunk.text !== 'string') fail('STORAGE_ERROR');
      text += chunk.text;
    }
    let session;
    try { session = JSON.parse(text); } catch (_) { fail('STORAGE_ERROR'); }
    if (!isObject(session) || session.id !== entry.id || jsonBytes(session) !== entry.bytes) fail('STORAGE_ERROR');
    try { return validateSession(session); } catch (_) { fail('STORAGE_ERROR'); }
  }
  return {
    loadSessions: function () { return storage.enqueue(async function () {
      const index = await readIndex();
      const sessions = [];
      for (let i = 0; i < index.entries.length; i += 1) sessions.push(await readEntry(index.entries[i]));
      return sessions;
    }); },
    saveSession: function (input) {
      // Snapshot before enqueue: caller mutation cannot change a queued write.
      const session = validateSession(input);
      return storage.enqueue(async function () {
        const index = await readIndex();
        const previous = index.entries.filter(function (entry) { return entry.id === session.id; })[0];
        if (previous) {
          const old = await readEntry(previous);
          if (session.updatedAt < old.updatedAt) fail('STORAGE_ERROR');
          const nextAudit = Object.create(null);
          (session.toolAudit || []).forEach(function (entry) { nextAudit[entry.id] = entry; });
          (old.toolAudit || []).forEach(function (entry) {
            if (!nextAudit[entry.id] || nextAudit[entry.id].name !== entry.name) fail('STORAGE_ERROR');
          });
        }
        const entry = { id: session.id, slot: previous ? 1 - previous.slot : 0, revision: previous ? previous.revision + 1 : 1, chunks: 0, bytes: jsonBytes(session) };
        const text = JSON.stringify(session);
        const chunks = [];
        // Bound JSON-escaped chunk size too; avoid slicing UTF-16 pairs.
        for (let offset = 0; offset < text.length;) {
          let end = Math.min(offset + 16000, text.length);
          if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1;
          chunks.push(text.slice(offset, end)); offset = end;
        }
        entry.chunks = chunks.length;
        const entries = index.entries.filter(function (item) { return item.id !== session.id; }).concat([entry]);
        validateIndex({ entries: entries });
        for (let i = 0; i < chunks.length; i += 1) {
          await storage.write('pa.session.' + session.id + '.' + entry.slot + '.' + i, { revision: entry.revision, text: chunks[i] });
        }
        // Commit last: recovery sees either the old complete slot or the new complete slot.
        await storage.write('pa.sessions', { entries: entries });
        return session;
      });
    }
  };
}
