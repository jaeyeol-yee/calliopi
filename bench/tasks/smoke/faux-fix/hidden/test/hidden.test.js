const test = require('node:test');
const assert = require('node:assert/strict');
const { greet } = require('../src/greet');
test('greets other names', () => assert.equal(greet('Grace'), 'Hello, Grace'));
