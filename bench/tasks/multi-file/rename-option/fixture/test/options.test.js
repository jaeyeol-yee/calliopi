const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../src/server');
const { main } = require('../src/cli');
test('the debug option turns on debug lines', () => {
  assert.deepEqual(startServer({ debug: true }).lines, ['info: starting', 'debug: port 8080']);
  assert.deepEqual(startServer({}).lines, ['info: starting']);
});
test('the CLI flag is --debug', () => {
  assert.equal(main(['--debug']).lines.length, 2);
  assert.equal(main(['--verbose']).lines.length, 1);
});
