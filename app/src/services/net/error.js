// ============================================================
// 统一错误类型与映射（移植自 pendouyin，真机已验证）
// 事实来源：docs/STANDARDS.md §7
// ============================================================

export const CODE = {
  NET_OFFLINE: 'NET_OFFLINE',
  NET_TIMEOUT: 'NET_TIMEOUT',
  NET_TRANSPORT: 'NET_TRANSPORT',
  HTTP_4XX: 'HTTP_4XX',
  HTTP_5XX: 'HTTP_5XX',
  BIZ_ERROR: 'BIZ_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
  NO_DATA: 'NO_DATA',
  STORAGE_ERROR: 'STORAGE_ERROR',
  TOOL_ERROR: 'TOOL_ERROR',
  INPUT_CANCELLED: 'INPUT_CANCELLED',
  CANCELLED: 'CANCELLED',
  TLS_ERROR: 'TLS_ERROR',
  HTTP_ERROR: 'HTTP_ERROR',
  LIMIT_REACHED: 'LIMIT_REACHED',
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
};

const MESSAGES = {
  NET_OFFLINE: '网络未连接',
  NET_TIMEOUT: '网络较慢，请重试',
  NET_TRANSPORT: '网络异常',
  HTTP_4XX: '请求无效',
  HTTP_5XX: '服务繁忙',
  BIZ_ERROR: '服务返回异常',
  PARSE_ERROR: '数据异常',
  NO_DATA: '暂无内容',
  STORAGE_ERROR: '保存失败',
  TOOL_ERROR: '工具执行失败',
  INPUT_CANCELLED: '已取消',
  CANCELLED: '已停止；底层请求可能仍在回收',
  TLS_ERROR: '安全连接不可用',
  HTTP_ERROR: '服务拒绝请求',
  LIMIT_REACHED: '已达到限额',
  CAPABILITY_UNAVAILABLE: '当前通道尚未通过能力验证',
  INVALID_ARGUMENT: '输入无效',
};

const RETRYABLE = {
  NET_OFFLINE: true,
  NET_TIMEOUT: true,
  NET_TRANSPORT: true,
  HTTP_5XX: true,
  STORAGE_ERROR: true,
};

export class AppError extends Error {
  constructor(code, message, cause) {
    super(message || MESSAGES[code] || '未知错误');
    this.name = 'AppError';
    this.code = code;
    this.cause = cause || null;
  }
}

export function isRetryable(error) {
  return Boolean(error && RETRYABLE[error.code]);
}

export function userMessage(error) {
  if (!error) return MESSAGES.PARSE_ERROR;
  return MESSAGES[error.code] || '未知错误';
}

// 状态码 → AppError（纯函数，可单测）
export function fromStatus(status, businessCode, businessMessage) {
  if (status === 0 || status == null) {
    return new AppError(CODE.NET_TRANSPORT);
  }
  if (status >= 500) return new AppError(CODE.HTTP_5XX);
  if (status >= 400) return new AppError(CODE.HTTP_4XX);
  if (businessCode != null && businessCode !== 0) {
    return new AppError(CODE.BIZ_ERROR, businessMessage || MESSAGES.BIZ_ERROR);
  }
  return null;
}
