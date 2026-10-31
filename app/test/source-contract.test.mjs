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

// The device font/canvas stack cannot render emoji or glyph-only status symbols
// reliably, so app source must use plain text or inline PNG icons instead.
// Ranges cover emoji blocks, misc symbols/dingbats, arrows-stars block, the
// variation selector and the full-width plus used by the old new-session label.
const EMOJI_OR_STATUS_GLYPH = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{FF0B}]/u;
const iconModulePath = join(src, 'assets', 'icons.js');

test('app source contains no emoji or glyph-only status symbols', () => {
  for (const path of files(src)) {
    const source = readFileSync(path, 'utf8');
    const match = source.match(EMOJI_OR_STATUS_GLYPH);
    if (match) {
      const codePoint = match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      assert.fail(path + ' must not contain glyph U+' + codePoint + '; use text or assets/icons.js');
    }
  }
});

test('icon module is ASCII-only and every icon is a small 48x48 PNG data URI', () => {
  const iconSource = readFileSync(iconModulePath, 'utf8');
  assert.match(iconSource, /^[\t\n\r\x20-\x7e]*$/, 'icons.js must stay ASCII-only');
  assert.match(iconSource, /export function icon\(/, 'icons.js must export icon()');
  const entries = [...iconSource.matchAll(/'([a-z-]+)':\s*'(data:image\/png;base64,[A-Za-z0-9+/=]+)'/g)];
  assert.ok(entries.length >= 3, 'icons.js must define the icon set');
  for (const name of ['check-on', 'check-off', 'plus']) {
    assert.ok(entries.some(entry => entry[1] === name), 'icons.js must define ' + name);
  }
  for (const [, name, uri] of entries) {
    assert.ok(uri.length < 2048, name + ' data URI must stay under 2 KiB');
    const png = Buffer.from(uri.slice('data:image/png;base64,'.length), 'base64');
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], name);
    assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR', name);
    assert.equal(png.readUInt32BE(16), 48, name + ' width');
    assert.equal(png.readUInt32BE(20), 48, name + ' height');
  }
});

test('templated images bind an inlined src and declare vw/vh width and height in one class', () => {
  for (const path of [...pages, ...components]) {
    const source = readFileSync(path, 'utf8');
    const opens = (source.match(/<image\b/g) || []).length;
    const closed = [...source.matchAll(/<image\b[^>]*>\s*<\/image>/g)];
    assert.equal(closed.length, opens, path + ' image tags must be explicitly closed');
    for (const tag of closed) {
      assert.match(tag[0], /\s(?::src|src)=/, path + ' image needs a src binding');
      assert.doesNotMatch(tag[0], /\ssrc="[^"]*assets?\//, path + ' loose asset files are not packaged; inline them');
      const className = tag[0].match(/\sclass="([a-z][a-z-]*)"/);
      assert.ok(className, path + ' image needs exactly one class');
      const rule = source.match(new RegExp('\\.' + className[1] + '\\s*\\{([^}]+)\\}'));
      assert.ok(rule, path + ' image class .' + className[1] + ' must have a style rule');
      assert.match(rule[1], /(?:^|;)\s*width\s*:/, path + ' image class needs width');
      assert.match(rule[1], /(?:^|;)\s*height\s*:/, path + ' image class needs height');
    }
  }
});

test('icon data URIs are referenced through the module, never duplicated in templates', () => {
  for (const path of [...pages, ...components]) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /data:image\/png/, path + ' must import assets/icons.js');
  }
});

// Height family (height/min-height/max-height) must resolve to a vh source: a
// literal vh number, a calc(...) that only uses vh, or a token imported from
// app/src/styles/viewport.less whose definition is vh. Width family must
// resolve to vw the same way. Absolute units, percentages and keyword sizes
// are rejected for these properties. This is the mechanical guard for the
// requirement that every component height is written in vh/vw.
const viewportTokenSource = readFileSync(join(src, 'styles', 'viewport.less'), 'utf8');
const viewportTokens = new Map([...viewportTokenSource.matchAll(/^\s*@([a-z0-9-]+)\s*:\s*([^;]+);/gm)]
  .map(match => [match[1], match[2].trim()]));
const DIMENSION_PROPERTY = /(?:^|[{;]|\s)((?:min-|max-)?(?:height|width))\s*:\s*([^;}]+)/g;
const ABSOLUTE_OR_FOREIGN_UNIT = /\b(?:px|rpx|wx|pt|em|rem|dp|sp)\b|%/;
const LITERAL_DIMENSION = /^\d*\.?\d+(?:vw|vh)$/;
const KEYWORD_DIMENSION = /auto|inherit|initial|unset|fit-content|max-content|min-content/;
const DIMENSIONLESS_ZERO = /^0$/; // STANDARDS §1.1: zero may be written without a unit
function styleBlocks(source, path) {
  if (!path.endsWith('.vue')) return [source];
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]);
}

test('every height-family value resolves to vh and every width-family value to vw', () => {
  for (const [name, value] of viewportTokens) {
    assert.match(value, /^\d*\.?\d+(?:vw|vh)$/, 'viewport token @' + name + ' must be a vw/vh literal, got ' + value);
  }
  let audited = 0;
  const styleFiles = [...pages, ...components, ...files(join(src, 'styles')).filter(file => file.endsWith('.less'))];
  for (const path of styleFiles) {
    for (const block of styleBlocks(readFileSync(path, 'utf8'), path)) {
      for (const match of block.matchAll(new RegExp(DIMENSION_PROPERTY.source, 'g'))) {
        const property = match[1];
        const value = match[2].trim();
        const unit = property.endsWith('height') ? 'vh' : 'vw';
        const label = path + ' ' + property + ': ' + value;
        audited += 1;
        assert.doesNotMatch(value, KEYWORD_DIMENSION, label + ' must not be a keyword size');
        if (DIMENSIONLESS_ZERO.test(value)) continue;
        if (value.startsWith('@')) {
          const token = value.slice(1);
          assert.ok(viewportTokens.has(token), label + ' must reference a viewport.less token');
          assert.ok(viewportTokens.get(token).endsWith(unit), label + ' token @' + token + ' must be defined in ' + unit);
          continue;
        }
        assert.doesNotMatch(value, ABSOLUTE_OR_FOREIGN_UNIT, label + ' must not use absolute or foreign units');
        if (value.startsWith('calc(')) {
          const units = [...value.matchAll(/\d(vw|vh)\b/g)].map(item => item[1]);
          assert.ok(units.length > 0 && units.every(item => item === unit), label + ' calc must only use ' + unit);
          continue;
        }
        assert.match(value, LITERAL_DIMENSION, label + ' must be a literal vh/vw value');
        assert.ok(value.endsWith(unit), label + ' must use ' + unit);
      }
    }
  }
  assert.ok(audited > 80, 'expected to audit every dimension declaration, audited ' + audited);
});

test('every page and component root declares a vw width and a vh height or min-height', () => {
  for (const path of [...pages, ...components]) {
    const source = readFileSync(path, 'utf8');
    const template = source.match(/<template>([\s\S]*?)<\/template>/);
    assert.ok(template, path + ' needs a template block');
    const rootTag = template[1].match(/^\s*<([a-z][a-z0-9-]*)\b([^>]*)>/);
    assert.ok(rootTag, path + ' needs a root element');
    const className = rootTag[2].match(/\sclass="([a-z][a-z-]*)"/);
    assert.ok(className, path + ' root element needs one static class');
    const rule = source.match(new RegExp('\\.' + className[1] + '\\s*\\{([^}]+)\\}'));
    assert.ok(rule, path + ' root class .' + className[1] + ' needs a style rule');
    assert.match(rule[1], /(?:^|;)\s*width\s*:/, path + ' root must declare width in vw');
    assert.match(rule[1], /(?:^|;)\s*(?:min-)?height\s*:/, path + ' root must declare height or min-height in vh');
  }
});
