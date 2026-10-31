import { createHarness } from '../core/index.js';
import { requestJson } from './net/index.js';
import { createDevRequestJson } from './net/dev.js';
import { createNativeRequestJson } from './net/native.js';
import { getJson, setJson } from './storage/index.js';
import { getDeviceInfo, execPreset, headProbe } from './device/index.js';
import { getWorkspaceAdapter } from './device/workspace.js';
import { MOCK_ORIGIN } from './device/development.js';

let application = null;
export function getApplication() {
  if (!application) {
    const workspace = getWorkspaceAdapter();
    // Production/HTTPS uses the native httpx module (TLS verify, no redirects,
    // real status, timeout, cancelAll). If the module is unavailable, explicit
    // development mode falls back to device curl; every other path uses the
    // fail-closed platform adapter.
    const developmentTransport = createDevRequestJson(workspace, requestJson);
    const transport = createNativeRequestJson(function (options) {
      return options && options.developmentMode === true ? developmentTransport(options) : requestJson(options);
    });
    application = createHarness({ requestJson: transport, getJson, setJson, deviceInfo: getDeviceInfo, execPreset, headProbe, workspace });
  }
  return application;
}

export { getWorkspaceAdapter } from './device/workspace.js';

// Selected explicitly in settings. Never reuse a user's production credential.
export function developerMockSettings(settings) {
  return Object.assign({}, settings, {
    baseUrl: MOCK_ORIGIN + '/v1', apiKey: 'test-synthetic-key',
    model: 'mock-gpt', developmentMode: true, persistApiKey: false,
  });
}

export function errorLabel(error) {
  const labels = {
    CANCELLED: '已停止；底层请求可能仍在回收',
    LIMIT_REACHED: '已达到本轮限额，可调整问题后再次发送',
    NET_TIMEOUT: '请求超时，结果未知；再次发送可能重复计费',
    NET_TRANSPORT: '连接失败，请检查网络和服务地址',
    TLS_ERROR: '安全连接失败，请检查证书和服务地址',
    HTTP_ERROR: '服务拒绝请求，请检查密钥和模型',
    PARSE_ERROR: '服务响应无法读取，请检查兼容性',
    STORAGE_ERROR: '保存失败，内容仍在内存中，请重试保存',
    CAPABILITY_UNAVAILABLE: '当前设备通道不支持此操作',
    CONFIG_ERROR: '请先在设置中填写 HTTPS 服务地址和模型',
    INVALID_ARGUMENT: '输入无效，请检查设置或工具参数',
    ARGUMENT_ERROR: '工具参数无效',
    TOOL_UNKNOWN: '工具不存在',
    TOOL_DISABLED: '此工具已在设置中关闭',
    TOOL_ERROR: '工具执行失败，请检查权限和设备能力',
    MATH_ERROR: '计算表达式无效',
    PROTOCOL_ERROR: '服务响应或会话格式不兼容，请调整问题或新建会话',
  };
  return labels[error && error.code] || '操作失败，请检查设置后重试';
}
