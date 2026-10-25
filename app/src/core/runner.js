import { CoreError, fail, errorResult, stableError } from './errors.js';
import { LIMITS } from './limits.js';
import { normalizeSettings, toolEnabled } from './config.js';
import { validateHistory, validateToolBatch } from './context.js';
import { parseArguments } from './schema.js';
import { truncateUtf8 } from './utf8.js';
import { validateToolArguments } from '../tools/registry.js';
import { createOpenAIClient } from './client.js';
export function createRunner(adapters, registry, notes, currentPolicy) {
  let generation = 0;
  let active = null;
  let starting = null;
  let pendingStop = Promise.resolve();
  // Without an explicit session ledger, conservatively retain reservations on this runner.
  const fallbackIds = Object.create(null);
  const state = { status: 'idle', runId: null, modelRequests: 0, toolCalls: 0, error: null, pending: null };
  const client = createOpenAIClient(adapters.requestJson, registry);
  const now = adapters.now || Date.now;
  function stop() {
    if (starting !== null) { generation += 1; starting = null; state.status = 'cancelled'; }
    if (!active) return pendingStop;
    const owner = active;
    generation += 1;
    active = null;
    owner.cancelled = true;
    state.status = 'cancelled';
    const cleanups = [pendingStop];
    owner.cancelHandlers.slice().forEach(function (handler) {
      try { cleanups.push(Promise.resolve(handler())); } catch (_) { cleanups.push(Promise.resolve()); }
    });
    owner.cancelHandlers.length = 0;
    pendingStop = Promise.all(cleanups.map(function (cleanup) { return cleanup.catch(function () {}); })).then(function () {});
    return pendingStop;
  }
  async function run(messages, input, options) {
    const startGeneration = generation + 1;
    const stopped = stop();
    // Reserve this start before awaiting cleanup, so an intervening stop/new run invalidates it.
    generation = Math.max(generation, startGeneration);
    const reserved = generation;
    starting = reserved;
    let initialHistory = [];
    let initialSettings;
    let initialError;
    const explicitLedger = options && Object.prototype.hasOwnProperty.call(options, 'usedToolIds');
    const usedIds = Object.create(null);
    const beforeToolBatch = options && options.beforeToolBatch;
    const useFallback = !explicitLedger || typeof beforeToolBatch !== 'function';
    try {
      const validated = validateHistory(messages);
      initialHistory = validated.groups.reduce(function (all, group) { return all.concat(group); }, []);
      const seed = explicitLedger ? options.usedToolIds : Object.keys(fallbackIds);
      if (!Array.isArray(seed)) fail('ARGUMENT_ERROR');
      if (seed.length > LIMITS.toolAuditIds) fail('LIMIT_REACHED');
      seed.forEach(function (id) {
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || usedIds[id]) fail('ARGUMENT_ERROR');
        usedIds[id] = true;
      });
      if (useFallback) Object.keys(fallbackIds).forEach(function (id) { usedIds[id] = true; });
      // Audit and complete protocol history legitimately overlap; only new calls are rejected.
      Object.keys(validated.seen).forEach(function (id) { usedIds[id] = true; });
      if (Object.keys(usedIds).length > LIMITS.toolAuditIds) fail('LIMIT_REACHED');
      if (beforeToolBatch !== undefined && typeof beforeToolBatch !== 'function') fail('ARGUMENT_ERROR');
      initialSettings = normalizeSettings(input);
    } catch (error) { initialError = error; }
    await stopped;
    if (reserved !== generation) return { status: 'cancelled', messages: initialHistory, modelRequests: 0, toolCalls: 0, usedToolIds: Object.keys(usedIds),
      error: { code: 'CANCELLED', message: new CoreError('CANCELLED').message }, pending: null };
    starting = null;
    const owner = { generation: reserved, runId: 'run-' + reserved, cancelled: false, cancelHandlers: [], deadline: now() + LIMITS.runMs };
    active = owner;
    state.status = 'loading'; state.runId = owner.runId; state.modelRequests = 0; state.toolCalls = 0; state.error = null; state.pending = null;
    let history = initialHistory;
    let pending = null;
    let settings;
    const onEvent = options && options.onEvent;
    function check() {
      if (owner.cancelled || generation !== owner.generation || active !== owner) fail('CANCELLED');
      if (now() >= owner.deadline) fail('LIMIT_REACHED');
    }
    const cancellation = {
      isCancelled: function () { return owner.cancelled || generation !== owner.generation; },
      onCancel: function (handler) {
        if (owner.cancelled) { handler(); return function () {}; }
        owner.cancelHandlers.push(handler);
        return function () { const index = owner.cancelHandlers.indexOf(handler); if (index >= 0) owner.cancelHandlers.splice(index, 1); };
      }
    };
    const scope = {
      check: check, cancellation: cancellation, remaining: function () { check(); return Math.max(1, owner.deadline - now()); },
      wait: function (factory, timeout, code) {
        check();
        return new Promise(function (resolve, reject) {
          let done = false;
          let cancelTask = null;
          let aborted = false;
          let timer = null;
          let remove = function () {};
          function finish(error, value) {
            if (done) return;
            done = true;
            if (timer !== null) clearTimeout(timer);
            remove();
            if (error) reject(error); else resolve(value);
          }
          function cancelTransport() {
            if (!cancelTask) return;
            const cancel = cancelTask;
            cancelTask = null;
            let cleanup;
            try { cleanup = Promise.resolve(cancel()).catch(function () {}); } catch (_) { cleanup = Promise.resolve(); }
            pendingStop = Promise.all([pendingStop, cleanup]).then(function () {});
            return cleanup;
          }
          function abort(error) {
            aborted = true;
            finish(error);
            return cancelTransport();
          }
          remove = cancellation.onCancel(function () { return abort(new CoreError('CANCELLED')); });
          const remaining = owner.deadline - now();
          timer = setTimeout(function () {
            try { abort(new CoreError(remaining <= timeout ? 'LIMIT_REACHED' : code)); } catch (_) {}
          }, Math.max(1, Math.min(timeout, remaining)));
          let task;
          try {
            check();
            task = factory();
            if (task && task.promise && typeof task.promise.then === 'function') {
              const handle = task;
              cancelTask = typeof handle.cancel === 'function' ? function () { return handle.cancel(); } : null;
              task = handle.promise;
              // The factory may synchronously stop/reenter before it returns its handle.
              if (aborted) cancelTransport();
            }
          } catch (error) { finish(error); return; }
          Promise.resolve(task).then(function (value) {
            try { check(); finish(null, value); } catch (error) { finish(error); }
          }, function (error) { finish(error); });
        });
      }
    };
    function event(type, data) {
      check();
      if (typeof onEvent === 'function') { try { onEvent(Object.assign({ type: type, runId: owner.runId }, data)); } catch (_) {} }
      check();
    }
    function result(status, error) {
      const safe = error ? stableError(error, 'TOOL_ERROR') : null;
      return { status: status, messages: history, pending: pending, usedToolIds: Object.keys(usedIds), modelRequests: state.runId === owner.runId ? state.modelRequests : owner.modelRequests || 0,
        toolCalls: owner.toolCalls || 0, error: safe ? { code: safe.code, message: safe.message } : null };
    }
    try {
      if (initialError) throw initialError;
      settings = initialSettings;
      const seen = usedIds;
      owner.modelRequests = 0; owner.toolCalls = 0;
      if (!settings.baseUrl || !settings.model) fail('CONFIG_ERROR');
      event('started', {});
      for (;;) {
        check();
        if (owner.modelRequests >= LIMITS.modelRequests || owner.toolCalls >= LIMITS.tools) fail('LIMIT_REACHED');
        owner.modelRequests += 1;
        state.modelRequests = owner.modelRequests;
        event('request', { count: owner.modelRequests });
        const message = await client.complete(history, settings, scope);
        check();
        if (!message.tool_calls) {
          history.push(message);
          event('message', { message: message });
          state.status = 'completed';
          return result('completed');
        }
        const calls = validateToolBatch(message.tool_calls, seen);
        if (owner.toolCalls + calls.length > LIMITS.tools || Object.keys(seen).length + calls.length > LIMITS.toolAuditIds) fail('LIMIT_REACHED');
        // Validate ALL envelopes, IDs, schemas and business arguments before the first side effect.
        const prepared = calls.map(function (call) {
          const tool = registry.filter(function (entry) { return entry.name === call.function.name; })[0];
          let args;
          let error;
          try {
            if (!tool) fail('TOOL_UNKNOWN');
            if (!toolEnabled(settings, tool.name)) fail('TOOL_DISABLED');
            args = parseArguments(call.function.arguments, tool.parameters);
            validateToolArguments(tool, args, settings);
          } catch (caught) { error = stableError(caught, 'ARGUMENT_ERROR'); }
          return { call: call, tool: tool, args: args, error: error };
        });
        calls.forEach(function (call) { seen[call.id] = true; });
        if (useFallback) Object.keys(seen).forEach(function (id) { fallbackIds[id] = true; });
        pending = { assistant: message, results: [], executions: [] };
        state.pending = pending;
        if (beforeToolBatch) {
          // Give persistence its own snapshot; a callback must not mutate executable calls.
          const reservedMessage = { role: 'assistant', content: message.content, tool_calls: validateToolBatch(calls) };
          try {
            const saved = await scope.wait(function () { return beforeToolBatch(reservedMessage); }, scope.remaining(), 'LIMIT_REACHED');
            if (saved === false) fail('STORAGE_ERROR');
          } catch (error) {
            check();
            fail('STORAGE_ERROR');
          }
          check();
        }
        event('tool_batch', { count: calls.length, usedToolIds: Object.keys(seen) });
        for (let i = 0; i < prepared.length; i += 1) {
          check();
          const item = prepared[i];
          owner.toolCalls += 1; state.toolCalls = owner.toolCalls;
          const execution = { id: item.call.id, name: item.call.function.name, status: 'pending' };
          pending.executions.push(execution);
          event('tool_started', { id: execution.id, name: execution.name });
          let content;
          let expired = false;
          const toolCancelHandlers = [];
          const toolDeadline = Math.min(owner.deadline, now() + LIMITS.toolMs);
          function toolCheck() { check(); if (expired || now() >= toolDeadline) fail('NET_TIMEOUT'); }
          try {
            toolCheck();
            if (item.error) throw item.error;
            const policy = currentPolicy ? normalizeSettings(currentPolicy()) : settings;
            if (!toolEnabled(settings, item.tool.name) || !toolEnabled(policy, item.tool.name)) fail('TOOL_DISABLED');
            validateToolArguments(item.tool, item.args, policy);
            execution.status = 'started';
            const ctx = {
              check: toolCheck, generation: owner.generation, runId: owner.runId, deadline: toolDeadline,
              remaining: function () { toolCheck(); return Math.max(1, toolDeadline - now()); }, now: now,
              cancellation: {
                isCancelled: function () { return expired || cancellation.isCancelled(); },
                onCancel: function (handler) {
                  let called = false;
                  let cleanup;
                  function cancelOnce() {
                    if (called) return cleanup;
                    called = true;
                    try { cleanup = Promise.resolve(handler()).catch(function () {}); } catch (_) { cleanup = Promise.resolve(); }
                    return cleanup;
                  }
                  const remove = cancellation.onCancel(cancelOnce);
                  const entry = { handler: cancelOnce, remove: remove };
                  toolCancelHandlers.push(entry);
                  return function () { remove(); const index = toolCancelHandlers.indexOf(entry); if (index >= 0) toolCancelHandlers.splice(index, 1); };
                }
              },
              notes: notes, deviceInfo: adapters.deviceInfo, execPreset: adapters.execPreset, headProbe: adapters.headProbe,
              allowedProbeHosts: policy.allowedProbeHosts.slice()
            };
            content = await scope.wait(function () { toolCheck(); return item.tool.execute(item.args, ctx); }, LIMITS.toolMs, 'NET_TIMEOUT');
            toolCheck();
            if (typeof content !== 'string') fail('TOOL_ERROR');
            content = truncateUtf8(content, LIMITS.resultBytes);
            execution.status = 'completed';
          } catch (error) {
            expired = true;
            if (!owner.cancelled) {
              const cleanups = toolCancelHandlers.map(function (entry) {
                try { return Promise.resolve(entry.handler()).catch(function () {}); } catch (_) { return Promise.resolve(); }
              });
              pendingStop = Promise.all([pendingStop].concat(cleanups)).then(function () {});
              await scope.wait(function () { return Promise.all(cleanups); }, scope.remaining(), 'LIMIT_REACHED');
            }
            check();
            content = errorResult(error);
            execution.status = 'error';
          } finally {
            toolCancelHandlers.forEach(function (entry) { entry.remove(); });
          }
          check();
          const toolMessage = { role: 'tool', tool_call_id: execution.id, content: content };
          pending.results.push(toolMessage);
          event('tool_result', { message: toolMessage, name: execution.name });
        }
        check();
        const group = [message].concat(pending.results);
        history = history.concat(group);
        pending = null; state.pending = null;
        event('tool_group', { messages: group });
      }
    } catch (error) {
      const safe = stableError(error, 'TOOL_ERROR');
      const status = safe.code === 'CANCELLED' ? 'cancelled' : safe.code === 'LIMIT_REACHED' ? 'limited' : 'error';
      if (generation === owner.generation && active === owner) {
        state.status = status; state.error = { code: safe.code, message: safe.message };
        if (typeof onEvent === 'function') { try { onEvent({ type: status, runId: owner.runId, error: state.error }); } catch (_) {} }
      }
      return result(status, safe);
    } finally {
      if (active === owner) active = null;
      const needsCleanup = !owner.cancelled;
      owner.cancelled = true;
      if (needsCleanup) {
        const cleanups = owner.cancelHandlers.slice().map(function (handler) {
          try { return Promise.resolve(handler()).catch(function () {}); } catch (_) { return Promise.resolve(); }
        });
        if (cleanups.length) pendingStop = Promise.all([pendingStop].concat(cleanups)).then(function () {});
      }
      owner.cancelHandlers.length = 0;
    }
  }
  return { run: run, stop: stop, state: state };
}
