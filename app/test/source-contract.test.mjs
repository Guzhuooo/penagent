import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const src = fileURLToPath(new URL('../src', import.meta.url));
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]); }
const pages = files(join(src, 'pages')).filter(path => path.endsWith('.vue'));
const components = files(join(src, 'components')).filter(path => path.endsWith('.vue'));

test('UI layout uses only relative length units, including inline geometry paths', () => {
  const styles = files(join(src, 'styles'));
  for (const path of [...pages, ...components, ...styles]) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /(?:\d|\.)\s*(?:px|rpx|wx|pt|em|rem|dp|sp|%)\b/, path);
    assert.doesNotMatch(source, /(?:936|280|@px1)/, path);
    // Current components intentionally have no dynamic style channel to bypass the rule.
    assert.doesNotMatch(source, /\b(?:v-bind:style|:style)\s*=/, path);
    if (path.endsWith('.vue')) {
      assert.match(source, /<style\s+lang="less"\s+scoped>/, path);
      for (const match of source.matchAll(/<scroller\b[^>]*class="([a-z-]+)"[^>]*>/g)) {
        assert.match(match[0], /scroll-direction="(?:vertical|horizontal)"/, path);
        const classStyle = source.match(new RegExp('\\.' + match[1] + '\\s*\\{([^}]+)\\}'));
        assert.ok(classStyle, path);
        assert.match(classStyle[1], /(?:^|;)\s*width\s*:/, path);
        assert.match(classStyle[1], /(?:^|;)\s*height\s*:/, path);
        assert.match(classStyle[1], /flex-direction\s*:/, path);
      }
    }
  }
});

test('platform access is composed through services; pure components cannot import business layers', () => {
  for (const path of [...pages, ...components]) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /\$falcon|from\s+['"](?:global|httpx)['"]|\.execShell\(/, path);
    if (components.includes(path)) assert.doesNotMatch(source, /from\s+['"][^'"]*(?:services|core|tools)\//, path);
  }
});

test('single profile configures viewport before pages render; production defaults never contain mock LAN identity', () => {
  const app = readFileSync(join(src, 'app.js'), 'utf8');
  assert.doesNotMatch(app, /936|280/);
  assert.match(app, /setViewPort\(profile\.screen\.logicalWidth\)/);
  const development = readFileSync(join(src, 'services/device/development.js'), 'utf8');
  assert.match(development, /http:\/\/127\.0\.0\.1:8787/);
  assert.doesNotMatch(development, /192\.168\./);
});
