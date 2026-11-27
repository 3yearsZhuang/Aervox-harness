import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCsp, cspMetaPlugin, LOOPBACK_ORIGINS } from './security-csp.ts';

const page = 'file:///Applications/Aervox.app/Contents/Resources/app.asar/out/renderer/index.html';

test('the default policy forbids generated code and plugin-capable objects', () => {
  const csp = buildCsp();
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
  // new Function is what Pixi used before @pixi/unsafe-eval; never re-enable it.
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-eval'/);
  // Style injection is required by Vue/Element Plus and cannot execute script.
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
});

test('the desktop policy keeps file: so packaged renderers can load local assets', () => {
  const csp = buildCsp({ allowFileScheme: true });
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval' file:/);
  assert.match(csp, /connect-src[^;]*file:/);
});

test('only loopback API origins are reachable, never arbitrary networks', () => {
  const csp = buildCsp({ extraConnect: [...LOOPBACK_ORIGINS] });
  assert.match(csp, /connect-src[^;]*http:\/\/127\.0\.0\.1:\*/);
  assert.match(csp, /connect-src[^;]*http:\/\/localhost:\*/);
  // A remote host must never be baked in by default.
  assert.doesNotMatch(csp, /https:\/\//);
  // Chromium drops the whole directive on an invalid source, so IPv6 literals
  // are deliberately absent rather than silently loosened.
  assert.doesNotMatch(csp, /\[::1\]/);
});

test('plugin Pages can be framed only from the same approved origins', () => {
  const csp = buildCsp({ extraConnect: [...LOOPBACK_ORIGINS] });
  const frame = /frame-src ([^;]+)/.exec(csp)?.[1] ?? '';
  assert.match(frame, /'self'/);
  assert.match(frame, /http:\/\/127\.0\.0\.1:\*/);
  // A bare wildcard source would frame anything; the only '*' allowed is the
  // port wildcard bound to a loopback host.
  assert.doesNotMatch(frame, /(^|\s)\*(\s|$)/);
  assert.doesNotMatch(frame, /https:/);
});

test('the meta tag is emitted before any script and only for build output', () => {
  const plugin = cspMetaPlugin();
  assert.equal(plugin.apply, 'build');
  const html = plugin.transformIndexHtml('<!doctype html><html><head><title>x</title></head><body></body></html>');
  const metaIndex = html.indexOf('Content-Security-Policy');
  const headIndex = html.indexOf('<head>');
  assert.ok(metaIndex > headIndex, 'policy must live inside <head>');
  assert.ok(html.indexOf('</head>') > metaIndex, 'policy must precede </head>');
  assert.match(html, /http-equiv="Content-Security-Policy"/);
});
