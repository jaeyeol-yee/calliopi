const test = require('node:test');
const assert = require('node:assert/strict');
const { greet } = require('../src/greet');
test('greet', () => assert.equal(greet('Ada'), 'Hello, Ada'));
