import { fail } from './errors.js';
export function utf8Bytes(text) {
  if (typeof text !== 'string') fail('ARGUMENT_ERROR');
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 128) bytes += 1;
    else if (c < 2048) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i += 1; }
    else bytes += 3;
  }
  return bytes;
}
export function jsonBytes(value) {
  let text;
  try { text = JSON.stringify(value); } catch (_) { fail('ARGUMENT_ERROR'); }
  if (typeof text !== 'string') fail('ARGUMENT_ERROR');
  return utf8Bytes(text);
}
export function truncateUtf8(text, maxBytes) {
  if (utf8Bytes(text) <= maxBytes) return text;
  const marker = '\n[truncated]';
  const budget = maxBytes - utf8Bytes(marker);
  if (budget < 0) fail('LIMIT_REACHED');
  let bytes = 0;
  let end = 0;
  while (end < text.length) {
    const c = text.charCodeAt(end);
    const pair = c >= 0xd800 && c <= 0xdbff && end + 1 < text.length &&
      text.charCodeAt(end + 1) >= 0xdc00 && text.charCodeAt(end + 1) <= 0xdfff;
    const size = pair ? 4 : c < 128 ? 1 : c < 2048 ? 2 : 3;
    if (bytes + size > budget) break;
    bytes += size;
    end += pair ? 2 : 1;
  }
  return text.slice(0, end) + marker;
}
