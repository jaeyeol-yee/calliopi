const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../src/logger');
const { startServer } = require('../src/server');
const { main } = require('../src/cli');
// Only what the prompt says: the option is called `debug` everywhere in src/, behavior otherwise kept.
test('the logger itself takes the debug option', () => {
  const on = createLogger({ debug: true });
  on.debug('a'); on.info('b');
  assert.deepEqual(on.lines, ['debug: a', 'info: b']);
  const off = createLogger();
  off.debug('a'); off.info('b');
  assert.deepEqual(off.lines, ['info: b']);
});
test('the old name does nothing anywhere', () => {
  const old = createLogger({ verbose: true });
  old.debug('a');
  assert.deepEqual(old.lines, []);
  assert.deepEqual(startServer({ verbose: true }).lines, ['info: starting']);
});
test('the server and the CLI pass the option through, other behavior kept', () => {
  assert.deepEqual(startServer({ debug: true, port: 9000 }).lines, ['info: starting', 'debug: port 9000']);
  assert.deepEqual(startServer({ debug: false, port: 9000 }).lines, ['info: starting']);
  assert.deepEqual(main(['--other', '--debug']).lines, ['info: starting', 'debug: port 8080']);
  assert.deepEqual(main([]).lines, ['info: starting']);
});
