import http from 'node:http';
import { pathToFileURL } from 'node:url';

const SYNTHETIC_AUTH = 'Bearer test-synthetic-key';
const MAX_BYTES = 2 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) { reject(new Error('LIMIT_REACHED')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(new Error('NET_TRANSPORT')));
  });
}
function completion(message, reason = 'stop') {
  return { id: 'chatcmpl-synthetic', object: 'chat.completion', model: 'mock-gpt',
    choices: [{ index: 0, message, finish_reason: reason }] };
}
function complete(parsed) {
  if (!parsed || parsed.model !== 'mock-gpt' || !Array.isArray(parsed.messages)) return null;
  const messages = parsed.messages;
  const lastUser = messages.reduce((text, msg) => msg.role === 'user' ? msg.content : text, '');
  const userIndex = messages.map(msg => msg.role).lastIndexOf('user');
  const active = messages.slice(userIndex + 1);
  const calls = active.filter(msg => msg.role === 'assistant' && Array.isArray(msg.tool_calls));
  if (lastUser === 'synthetic-tools') {
    if (!calls.length) return completion({ role: 'assistant', content: null, tool_calls: [
      { id: 'mock-calculator-' + userIndex, type: 'function', function: { name: 'calculator', arguments: JSON.stringify({ expression: '(2+3)*4' }) } },
      { id: 'mock-clock-' + userIndex, type: 'function', function: { name: 'clock', arguments: '{}' } },
    ] }, 'tool_calls');
    const results = active.filter(msg => msg.role === 'tool');
    const expected = calls[0].tool_calls;
    if (results.length !== expected.length || expected.some(call => results.filter(msg => msg.tool_call_id === call.id).length !== 1)) return null;
    return completion({ role: 'assistant', content: '工具循环完成：计算器与时钟结果已一一对应返回。' });
  }
  return completion({ role: 'assistant', content: '合成测试对话成功。' });
}

export function createMockServer({ log = () => {} } = {}) {
  const counts = { requests: 0, posts: 0, completions: 0, toolResponses: 0 };
  const server = http.createServer(async (req, res) => {
    let body;
    try { body = await readBody(req); } catch (_) { res.destroy(); return; }
    counts.requests++;
    if (req.method === 'POST') counts.posts++;
    const authorized = req.headers.authorization === SYNTHETIC_AUTH || req.headers.authorization === 'Bearer probe-key-123';
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    function send(status, value) {
      res.statusCode = status;
      log({ request: counts.requests, status, bytes: Buffer.byteLength(body), authorized });
      res.end(JSON.stringify(value));
    }
    if (!authorized) { send(401, { error: { code: 'SYNTHETIC_AUTH_REQUIRED' } }); return; }
    if (req.method === 'GET' && req.url === '/v1/models') {
      send(200, { object: 'list', data: [{ id: 'mock-gpt', object: 'model' }] }); return;
    }
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (_) {}
    if (req.method === 'POST' && req.url === '/v1/echo') {
      const jsonObject = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
      send(200, { method: 'POST', authorized, bodyBytes: Buffer.byteLength(body), jsonObject,
        modelPresent: jsonObject && parsed.model === 'mock-gpt', messagesArray: jsonObject && Array.isArray(parsed.messages) }); return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      counts.completions++;
      const result = complete(parsed);
      if (!result) { send(400, { error: { code: 'INVALID_SYNTHETIC_REQUEST' } }); return; }
      if (result.choices[0].finish_reason === 'tool_calls') counts.toolResponses++;
      send(200, result); return;
    }
    send(404, { error: { code: 'NOT_FOUND' } });
  });
  return { server, counts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.MOCK_HOST || '127.0.0.1';
  const port = Number(process.env.MOCK_PORT || 8787);
  const { server } = createMockServer({ log: meta => console.log('[mock] ' + JSON.stringify(meta)) });
  server.listen(port, host, () => console.log('[mock] synthetic server ready on port ' + port));
  process.on('SIGINT', () => server.close());
  process.on('SIGTERM', () => server.close());
}
