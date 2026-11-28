const test = require('node:test');
const assert = require('node:assert/strict');
const { range } = require('../src/range');
// Only what the comment in src/range.js says: integers from start to end, both included.
test('other ranges include both ends', () => {
  assert.deepEqual(range(2, 6), [2, 3, 4, 5, 6]);
  assert.deepEqual(range(-2, 1), [-2, -1, 0, 1]);
  assert.deepEqual(range(0, 0), [0]);
  assert.deepEqual(range(10, 7), []);
});
