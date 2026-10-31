import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiKey, defaultReadRegistry } from '../../hub/keys.mjs';

const reg = () => '    ELEVENLABS_API_KEY    REG_SZ    sk_abc\r\n';

test('config wins over env', () => {
  assert.equal(resolveApiKey({ configKey: 'c', env: { ELEVENLABS_API_KEY: 'e' }, platform: 'win32', readRegistry: reg }), 'c');
});
test('env wins over registry', () => {
  assert.equal(resolveApiKey({ env: { ELEVENLABS_API_KEY: 'e' }, platform: 'win32', readRegistry: reg }), 'e');
});
test('registry not called off win32', () => {
  let called = false;
  const r = resolveApiKey({ env: {}, platform: 'linux', readRegistry: () => { called = true; return ''; } });
  assert.equal(called, false);
  assert.equal(r, '');
});
test('parses registry output', () => {
  assert.equal(resolveApiKey({ env: {}, platform: 'win32', readRegistry: reg }), 'sk_abc');
});
test('nothing found gives empty string', () => {
  assert.equal(resolveApiKey({ env: {}, platform: 'win32', readRegistry: () => '' }), '');
});
test('default registry reader queries HKCU Environment with a real backslash', () => {
  let args;
  const out = defaultReadRegistry((...a) => { args = a; return 'x'; });
  assert.equal(out, 'x');
  assert.equal(args[0], 'reg');
  assert.deepEqual(args[1], ['query', 'HKCU\\Environment', '/v', 'ELEVENLABS_API_KEY']);
  assert.equal(args[1][1].length, 16);
  assert.equal(args[1][1][4], String.fromCharCode(92));
});
test('default registry reader returns empty string when exec throws', () => {
  assert.equal(defaultReadRegistry(() => { throw new Error('nope'); }), '');
});
