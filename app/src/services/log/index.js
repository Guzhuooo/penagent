// ============================================================
// 日志适配 —— 统一 tag 前缀，禁止记录敏感信息
// 事实来源：docs/STANDARDS.md §12
// ============================================================

function safe(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (e) {
    return String(value);
  }
}

function emit(level, message, detail) {
  const line = detail === undefined ? String(message) : String(message) + ' ' + safe(detail);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug(message, detail) { emit('debug', message, detail); },
  info(message, detail) { emit('info', message, detail); },
  warn(message, detail) { emit('warn', message, detail); },
  error(message, detail) { emit('error', message, detail); },
};

export default log;
