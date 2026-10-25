// ============================================================
// 系统输入法适配 —— 单例 + UUID 校验 + on/off 成对
// 事实来源：STANDARDS §10；pendouyin 真机实测（2026-10-06）：
// startTextEdit 返回 UUID 字符串；textEditFinished(uuid, payload)；
// editConfirmed 严格为 true 才写回。输入期间本页收到 onHide —— 由守卫处理。
// ============================================================

import { getGlobalManager } from '../device/global.js';
import { log } from '../log/index.js';
import { parseInputResult } from './normalize.js';

let sessionUuid = null;
let active = false;
let handlerRef = null;
let delegate = null;

function getManager() {
  return getGlobalManager();
}

export function isInputSessionActive() {
  return active;
}

// 由页面在 mounted 时调用一次，注册 textEditFinished
export function attach(onResult) {
  const mgr = getManager();
  if (handlerRef) {
    if (delegate !== onResult) {
      closeUuid(sessionUuid);
      sessionUuid = null;
      active = false;
      delegate = onResult;
    }
    return;
  }
  delegate = onResult;
  handlerRef = (...args) => {
    const result = parseInputResult(sessionUuid, args);
    if (result.stale) return;
    log.info('[pa:input] finished', { confirmed: result.confirmed });
    const uuid = sessionUuid;
    sessionUuid = null;
    active = false;
    closeUuid(uuid);
    if (delegate) delegate(result);
  };
  if (!mgr.textEditFinished || typeof mgr.textEditFinished.on !== 'function' || typeof mgr.textEditFinished.off !== 'function') {
    handlerRef = null;
    delegate = null;
    const error = new Error('Input event channel unavailable');
    error.code = 'CAPABILITY_UNAVAILABLE';
    throw error;
  }
  try { mgr.textEditFinished.on(handlerRef); }
  catch (error) { handlerRef = null; delegate = null; throw error; }
}

function closeUuid(uuid) {
  if (!uuid) return;
  try {
    getManager().closeTextEdit(uuid);
  } catch (e) {
    log.warn('[pa:input] close failed');
  }
}

export function detach(onResult) {
  if (onResult && delegate !== onResult) return;
  const mgr = getManager();
  if (handlerRef) {
    try { mgr.textEditFinished.off(handlerRef); }
    catch (error) { log.warn('[pa:input] detach failed'); }
    handlerRef = null;
  }
  closeUuid(sessionUuid);
  sessionUuid = null;
  active = false;
  delegate = null;
}

export function open(config) {
  const mgr = getManager();
  if (!handlerRef || typeof mgr.startTextEdit !== 'function') {
    const error = new Error('Input session unavailable');
    error.code = 'CAPABILITY_UNAVAILABLE';
    return Promise.reject(error);
  }
  closeUuid(sessionUuid);
  const cfg = {
    text: (config && config.text) || '',
    placeholder: (config && config.placeholder) || '',
    maxlength: (config && config.maxlength) || 200,
    inputType: (config && config.inputType) || 'EnUSPreferred',
    autofocus: true,
    multiLinesEditVisible: false,
    enterButtonText: (config && config.enterButtonText) || '确定',
  };
  let uuid = null;
  try {
    uuid = mgr.startTextEdit(JSON.stringify(cfg));
  } catch (e) {
    log.error('[pa:input] startTextEdit failed');
    return Promise.reject(e);
  }
  sessionUuid = typeof uuid === 'string' ? uuid : null;
  active = true;
  if (!sessionUuid) {
    active = false;
    return Promise.reject(new Error('input session unavailable'));
  }
  return Promise.resolve(sessionUuid);
}
