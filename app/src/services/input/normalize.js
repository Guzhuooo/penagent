// ============================================================
// 输入法返回值归一化 —— 纯函数，可单测
// 事实来源：STANDARDS §10；pendouyin 真机实测回调形态（2026-10-06）：
//   textEditFinished("<uuid>", "{\"text\":\"test\",\"cursorIndex\":4,\"editConfirmed\":true}")
// ============================================================

export function normalizeText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.value === 'string') return value.value;
  }
  return '';
}

// args: [uuid, payloadStringOrObject]
export function parseInputResult(expectedUuid, args) {
  const list = Array.isArray(args) ? args : [args];
  const uuid = list[0];
  if (!expectedUuid || uuid !== expectedUuid) {
    return { confirmed: false, text: '', stale: true };
  }
  let payload = list[1];
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (e) {
      return { confirmed: false, text: '', parseError: true };
    }
  }
  if (!payload || typeof payload !== 'object') {
    return { confirmed: false, text: '' };
  }
  if (payload.editConfirmed !== true) {
    return { confirmed: false, text: '', cancelled: true };
  }
  return { confirmed: true, text: normalizeText(payload) };
}
