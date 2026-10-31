// Parse an imported configuration file without touching the platform filesystem.
// Supports three practical shapes:
//   1. a penagent settings object: {"baseUrl":"...","apiKey":"...","model":"...","apiFormat":"anthropic"}
//   2. a Claude/DeepSeek harness settings file: {"env":{"ANTHROPIC_BASE_URL":...}}
//   3. a tiny key=value / bare-key text file for the pen
// The returned metadata never contains the key; `settings` is for saveSettings only.
import { fail } from '../core/errors.js';

const SETTING_KEYS = ['baseUrl', 'apiKey', 'model', 'temperature', 'maxTokens', 'apiFormat', 'systemPrompt',
  'persistApiKey', 'execShellEnabled', 'developmentMode', 'tools', 'allowedProbeHosts'];
const MAX_BYTES = 64 * 1024;

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function fromEnv(env) {
  if (!isObject(env)) return null;
  const settings = {};
  let anthropic = false;
  let openai = false;
  if (typeof env.ANTHROPIC_BASE_URL === 'string' && env.ANTHROPIC_BASE_URL) { settings.baseUrl = env.ANTHROPIC_BASE_URL; anthropic = true; }
  if (typeof env.ANTHROPIC_AUTH_TOKEN === 'string' && env.ANTHROPIC_AUTH_TOKEN) { settings.apiKey = env.ANTHROPIC_AUTH_TOKEN; anthropic = true; }
  if (typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY && !settings.apiKey) { settings.apiKey = env.ANTHROPIC_API_KEY; anthropic = true; }
  if (typeof env.ANTHROPIC_MODEL === 'string' && env.ANTHROPIC_MODEL) settings.model = env.ANTHROPIC_MODEL;
  if (typeof env.OPENAI_BASE_URL === 'string' && env.OPENAI_BASE_URL) { settings.baseUrl = env.OPENAI_BASE_URL; openai = true; }
  if (typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY) { settings.apiKey = env.OPENAI_API_KEY; openai = true; }
  if (typeof env.OPENAI_MODEL === 'string' && env.OPENAI_MODEL) settings.model = env.OPENAI_MODEL;
  if (settings.baseUrl && !settings.apiKey) fail('CONFIG_ERROR');
  if (anthropic) settings.apiFormat = 'anthropic';
  else if (openai) settings.apiFormat = 'openai';
  return Object.keys(settings).length ? settings : null;
}

function fromDirect(value) {
  const settings = {};
  SETTING_KEYS.forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(value, key)) settings[key] = value[key];
  });
  if (settings.tools != null && !isObject(settings.tools)) fail('CONFIG_ERROR');
  if (!Object.keys(settings).length) return null;
  return settings;
}

function fromText(text) {
  const settings = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.charAt(0) === '#') continue;
    const match = /^([A-Za-z][A-Za-z0-9_]*)\s*[=:]\s*(.+)$/.exec(line);
    if (match) {
      const name = match[1].toLowerCase();
      const value = match[2].trim();
      if (name === 'baseurl' || name === 'base_url' || name === 'url') settings.baseUrl = value;
      else if (name === 'apikey' || name === 'api_key' || name === 'key' || name === 'token' || name === 'auth_token') settings.apiKey = value;
      else if (name === 'model') settings.model = value;
      else if (name === 'apiformat' || name === 'api_format') settings.apiFormat = value;
      else if (name === 'systemprompt' || name === 'system_prompt') settings.systemPrompt = value;
      else continue;
      continue;
    }
    // A bare token file is accepted; other bare lines are ignored.
    if (!settings.apiKey && /^(sk|key|ak)-/i.test(line) && line.length <= 4096) settings.apiKey = line;
  }
  if (!Object.keys(settings).length) fail('CONFIG_ERROR');
  if (settings.apiFormat && settings.apiFormat !== 'openai' && settings.apiFormat !== 'anthropic') fail('CONFIG_ERROR');
  return settings;
}

export function parseConfigText(text) {
  if (typeof text !== 'string' || !text.trim()) fail('CONFIG_ERROR');
  if (text.length > MAX_BYTES) fail('LIMIT_REACHED');
  const trimmed = text.trim();
  if (trimmed.charAt(0) === '{') {
    let value;
    try { value = JSON.parse(trimmed); } catch (_) { fail('CONFIG_ERROR'); }
    if (!isObject(value)) fail('CONFIG_ERROR');
    // Claude Code / DeepSeek harness style.
    if (isObject(value.env)) {
      const settings = fromEnv(value.env);
      if (!settings) fail('CONFIG_ERROR');
      return { format: 'harness-env', settings: settings, fields: Object.keys(settings) };
    }
    // A full storage envelope exported from the app.
    if (isObject(value['pa.settings']) && isObject(value['pa.settings'].data)) {
      const settings = fromDirect(value['pa.settings'].data);
      if (!settings) fail('CONFIG_ERROR');
      return { format: 'pa.settings', settings: settings, fields: Object.keys(settings) };
    }
    const settings = fromDirect(value);
    if (!settings) fail('CONFIG_ERROR');
    return { format: 'settings-json', settings: settings, fields: Object.keys(settings) };
  }
  const settings = fromText(trimmed);
  return { format: 'text', settings: settings, fields: Object.keys(settings) };
}
