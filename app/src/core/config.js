import { fail } from './errors.js';
import { isObject } from './schema.js';
export const TOOL_NAMES = Object.freeze(['clock', 'calculator', 'note', 'device_info', 'net_probe', 'execShell']);
export const DEFAULT_SETTINGS = Object.freeze({
  baseUrl: '', apiKey: '', model: '', temperature: 0.7,
  maxTokens: 1024, persistApiKey: false, execShellEnabled: false, developmentMode: false
});
// Development mocks run on this host or a private LAN peer; never on a public address.
function developmentHost(host) {
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const parts = host.split('.').map(Number);
  if (parts.some(function (part) { return part < 0 || part > 255; })) return false;
  return parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}
export function parseEndpoint(value, developmentMode) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f\\?#@]/.test(value)) fail('CONFIG_ERROR');
  const match = /^(https?):\/\/([a-zA-Z0-9.-]+|\[::1\])(?::([0-9]{1,5}))?(\/[^]*)?$/.exec(value);
  if (!match) fail('CONFIG_ERROR');
  const host = match[2].toLowerCase();
  if (host !== '[::1]' && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host)) fail('CONFIG_ERROR');
  if (host.length > 253 || (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535))) fail('CONFIG_ERROR');
  const local = developmentHost(host);
  if (match[1] !== 'https' && !(developmentMode && local)) fail('CONFIG_ERROR');
  const path = match[4] || '';
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) fail('CONFIG_ERROR');
  return { host: host, scheme: match[1], url: match[1] + '://' + host + (match[3] ? ':' + Number(match[3]) : '') + path };
}
export function normalizeSettings(input) {
  const source = input == null ? {} : input;
  if (!isObject(source)) fail('CONFIG_ERROR');
  const allowed = Object.keys(DEFAULT_SETTINGS).concat(['tools', 'allowedProbeHosts']);
  Object.keys(source).forEach(function (key) { if (allowed.indexOf(key) < 0) fail('CONFIG_ERROR'); });
  const settings = Object.assign({}, DEFAULT_SETTINGS, source);
  ['persistApiKey', 'execShellEnabled', 'developmentMode'].forEach(function (key) { if (typeof settings[key] !== 'boolean') fail('CONFIG_ERROR'); });
  if (typeof settings.apiKey !== 'string' || settings.apiKey.length > 4096 || /[\x00-\x20\x7f]/.test(settings.apiKey)) fail('CONFIG_ERROR');
  if (typeof settings.model !== 'string' || settings.model.length > 128 || /[\x00-\x1f\x7f]/.test(settings.model)) fail('CONFIG_ERROR');
  settings.model = settings.model.trim();
  if (typeof settings.temperature !== 'number' || !Number.isFinite(settings.temperature) || settings.temperature < 0 || settings.temperature > 2) fail('CONFIG_ERROR');
  if (!Number.isInteger(settings.maxTokens) || settings.maxTokens < 1 || settings.maxTokens > 32768) fail('CONFIG_ERROR');
  if (settings.baseUrl !== '') {
    const root = parseEndpoint(settings.baseUrl, settings.developmentMode);
    if (root.scheme === 'http' && settings.apiKey && !/^(mock|test|fake)(?:[-_]|$)/.test(settings.apiKey)) fail('CONFIG_ERROR');
    settings.baseUrl = root.url.replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/+$/, '');
  }
  settings.tools = {};
  const switches = source.tools == null ? {} : source.tools;
  if (!isObject(switches)) fail('CONFIG_ERROR');
  Object.keys(switches).forEach(function (key) { if (TOOL_NAMES.indexOf(key) < 0 || typeof switches[key] !== 'boolean') fail('CONFIG_ERROR'); });
  TOOL_NAMES.forEach(function (name) { settings.tools[name] = Object.prototype.hasOwnProperty.call(switches, name) ? switches[name] : name !== 'execShell'; });
  const hosts = source.allowedProbeHosts == null ? [] : source.allowedProbeHosts;
  if (!Array.isArray(hosts) || hosts.length > 32) fail('CONFIG_ERROR');
  settings.allowedProbeHosts = hosts.map(function (host) {
    const parsed = parseEndpoint('https://' + host, false);
    if (parsed.url !== 'https://' + parsed.host || parsed.host === '[::1]' || /^(localhost|[0-9.]+)$/.test(parsed.host)) fail('CONFIG_ERROR');
    return parsed.host;
  });
  return settings;
}
export function completionEndpoint(settings) {
  const normalized = normalizeSettings(settings);
  if (!normalized.baseUrl) fail('CONFIG_ERROR');
  return normalized.baseUrl + '/chat/completions';
}
export function toolEnabled(settings, name) {
  return settings.tools[name] === true && (name !== 'execShell' || settings.execShellEnabled === true);
}
export function allowedProbeUrl(url, hosts) {
  let parsed;
  try { parsed = parseEndpoint(url, false); } catch (_) { fail('ARGUMENT_ERROR'); }
  if (hosts.indexOf(parsed.host) < 0 || /[;'"`$<>|&(){}]/.test(parsed.url)) fail('ARGUMENT_ERROR');
  // HEAD probes use the default TLS port, with no redirects or credentials.
  if (!/^https:\/\/[^/:]+(?:\/|$)/.test(parsed.url)) fail('ARGUMENT_ERROR');
  return parsed.url;
}
