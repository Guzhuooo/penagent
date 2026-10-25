import { fail } from '../core/errors.js';
export const CALCULATOR_LIMITS = Object.freeze({ characters: 512, tokens: 256, depth: 32, magnitude: 1e100 });
export function calculate(expression) {
  if (typeof expression !== 'string' || !expression.trim() || expression.length > CALCULATOR_LIMITS.characters) fail('MATH_ERROR');
  const tokens = [];
  let offset = 0;
  while (offset < expression.length) {
    const rest = expression.slice(offset);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) { offset += whitespace[0].length; continue; }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) { tokens.push(Number(number[0])); offset += number[0].length; }
    else if ('+-*/%()'.indexOf(rest[0]) >= 0) { tokens.push(rest[0]); offset += 1; }
    else fail('MATH_ERROR');
    if (tokens.length > CALCULATOR_LIMITS.tokens) fail('MATH_ERROR');
  }
  let index = 0;
  function bounded(value) {
    if (!Number.isFinite(value) || Math.abs(value) > CALCULATOR_LIMITS.magnitude) fail('MATH_ERROR');
    return value;
  }
  function atom(depth) {
    if (depth > CALCULATOR_LIMITS.depth) fail('MATH_ERROR');
    const token = tokens[index];
    index += 1;
    if (token === '+' || token === '-') return bounded((token === '-' ? -1 : 1) * atom(depth + 1));
    if (token === '(') {
      const value = sum(depth + 1);
      if (tokens[index] !== ')') fail('MATH_ERROR');
      index += 1;
      return value;
    }
    if (typeof token !== 'number') fail('MATH_ERROR');
    return bounded(token);
  }
  function product(depth) {
    let value = atom(depth);
    while (['*', '/', '%'].indexOf(tokens[index]) >= 0) {
      const op = tokens[index++];
      const right = atom(depth);
      if ((op === '/' || op === '%') && right === 0) fail('MATH_ERROR');
      value = bounded(op === '*' ? value * right : op === '/' ? value / right : value % right);
    }
    return value;
  }
  function sum(depth) {
    let value = product(depth);
    while (tokens[index] === '+' || tokens[index] === '-') {
      const op = tokens[index++];
      const right = product(depth);
      value = bounded(op === '+' ? value + right : value - right);
    }
    return value;
  }
  const result = sum(0);
  if (index !== tokens.length) fail('MATH_ERROR');
  return result === 0 ? 0 : result;
}
