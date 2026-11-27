const test = require('node:test');
const assert = require('node:assert/strict');
const { range } = require('../src/range');
test('range includes both ends', () => {
  assert.deepEqual(range(1, 3), [1, 2, 3]);
  assert.deepEqual(range(5, 5), [5]);
  assert.deepEqual(range(3, 1), []);
});
