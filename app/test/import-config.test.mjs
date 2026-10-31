import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigText } from '../src/core/import-config.js';

const harnessEnv = (overrides) => JSON.stringify({
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  env: Object.assign({
    ANTHROPIC_BASE_URL: 'https://api.yunqing.asia',
    ANTHROPIC_AUTH_TOKEN: 'sk-test-import-token',
    ANTHROPIC_MODEL: 'deepseek-v4.1-flash',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }, overrides || {}),
});

test('import parses Claude/DeepSeek harness env JSON without exposing the key', () => {
  const parsed = parseConfigText(harnessEnv());
  assert.equal(parsed.format, 'harness-env');
  assert.equal(parsed.settings.baseUrl, 'https://api.yunqing.asia');
  assert.equal(parsed.settings.apiKey, 'sk-test-import-token');
  assert.equal(parsed.settings.model, 'deepseek-v4.1-flash');
  assert.equal(parsed.settings.apiFormat, 'anthropic');
  assert.equal(JSON.stringify(parsed.fields).includes('sk-test-import-token'), false);
});

test('import parses direct settings JSON, pa.settings envelope and text key files', () => {
  const direct = parseConfigText(JSON.stringify({ baseUrl: 'https://api.example', apiKey: 'sk-x', model: 'm', apiFormat: 'openai', maxTokens: 4096, tools: { clock: true } }));
  assert.equal(direct.format, 'settings-json');
  assert.equal(direct.settings.maxTokens, 4096);
  assert.equal(direct.settings.tools.clock, true);
  const envelope = parseConfigText(JSON.stringify({ 'pa.settings': { version: 1, data: { baseUrl: 'https://api.example', apiKey: 'sk-y', model: 'm' } } }));
  assert.equal(envelope.format, 'pa.settings');
  assert.equal(envelope.settings.apiKey, 'sk-y');
  const text = parseConfigText('baseUrl=https://api.example\napiKey=sk-z\nmodel=deepseek-v4.1-flash\napiFormat=anthropic\n');
  assert.equal(text.format, 'text');
  assert.equal(text.settings.apiKey, 'sk-z');
  assert.equal(text.settings.apiFormat, 'anthropic');
  const bare = parseConfigText('sk-bare-token\n');
  assert.equal(bare.settings.apiKey, 'sk-bare-token');
});

test('import rejects malformed or oversized config', () => {
  assert.throws(() => parseConfigText('{not json'), (error) => error.code === 'CONFIG_ERROR');
  assert.throws(() => parseConfigText('{}'), (error) => error.code === 'CONFIG_ERROR');
  assert.throws(() => parseConfigText('x'.repeat(70 * 1024)), (error) => error.code === 'LIMIT_REACHED');
  assert.throws(() => parseConfigText(JSON.stringify({ env: { OPENAI_BASE_URL: 'https://x' } })), (error) => error.code === 'CONFIG_ERROR');
});
