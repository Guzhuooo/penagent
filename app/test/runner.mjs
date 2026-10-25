// 纯逻辑单测（node test/runner.mjs）—— 只 import 不触碰 $falcon 的模块
import assert from 'node:assert';

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

// ---------- services/storage ----------
import { pickStoredValue } from '../src/services/storage/index.js';

test('pickStoredValue 兼容多种回调形态', () => {
  assert.strictEqual(pickStoredValue([{ data: 'v1' }]), 'v1');
  assert.strictEqual(pickStoredValue([{ value: 'v2' }]), 'v2');
  assert.strictEqual(pickStoredValue([{ 'pa.key': 'v3' }]), 'v3');
  assert.strictEqual(pickStoredValue(['raw']), 'raw');
  assert.strictEqual(pickStoredValue([]), '');
  assert.strictEqual(pickStoredValue(null), '');
  assert.strictEqual(pickStoredValue([42]), '');
});

// ---------- services/net/error ----------
import { AppError, CODE, fromStatus, isRetryable, userMessage } from '../src/services/net/error.js';

test('fromStatus 全映射', () => {
  assert.strictEqual(fromStatus(0, null, null).code, CODE.NET_TRANSPORT);
  assert.strictEqual(fromStatus(null, null, null).code, CODE.NET_TRANSPORT);
  assert.strictEqual(fromStatus(502, null, null).code, CODE.HTTP_5XX);
  assert.strictEqual(fromStatus(403, null, null).code, CODE.HTTP_4XX);
  assert.strictEqual(fromStatus(200, 2483, '请先登录').code, CODE.BIZ_ERROR);
  assert.strictEqual(fromStatus(200, 0, null), null);
  assert.strictEqual(fromStatus(200, null, null), null);
});

test('AppError 默认消息与可重试判断', () => {
  const e = new AppError(CODE.NET_TIMEOUT);
  assert.strictEqual(e.message, '网络较慢，请重试');
  assert.ok(isRetryable(e));
  assert.ok(!isRetryable(new AppError(CODE.HTTP_4XX)));
  assert.strictEqual(userMessage(null), '数据异常');
  assert.strictEqual(new AppError(CODE.TOOL_ERROR).message, '工具执行失败');
});

// ---------- services/input/normalize ----------
import { parseInputResult, normalizeText } from '../src/services/input/normalize.js';

test('parseInputResult 归一化与 uuid 校验', () => {
  const uuid = 'u-123';
  const r1 = parseInputResult(uuid, [uuid, JSON.stringify({ editConfirmed: true, text: 'hello' })]);
  assert.strictEqual(r1.confirmed, true);
  assert.strictEqual(r1.text, 'hello');
  const r2 = parseInputResult(uuid, [uuid, JSON.stringify({ editConfirmed: false, text: 'dirty' })]);
  assert.strictEqual(r2.confirmed, false);
  const r3 = parseInputResult(uuid, ['other-uuid', '{}']);
  assert.strictEqual(r3.stale, true);
  assert.strictEqual(parseInputResult(uuid, [uuid, 'not-json']).parseError, true);
});

test('normalizeText 兼容 string/{value}/{text}/数字/null', () => {
  assert.strictEqual(normalizeText('a'), 'a');
  assert.strictEqual(normalizeText({ value: 'b' }), 'b');
  assert.strictEqual(normalizeText({ text: 'c' }), 'c');
  assert.strictEqual(normalizeText(7), '7');
  assert.strictEqual(normalizeText(null), '');
});

// ---------- 运行 ----------
let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log('PASS ' + name);
  } catch (e) {
    failed += 1;
    console.error('FAIL ' + name + ' :: ' + e.message);
  }
}
console.log(failed === 0 ? '\nALL ' + tests.length + ' TESTS PASSED' : '\n' + failed + ' FAILED / ' + tests.length);
process.exit(failed === 0 ? 0 : 1);
