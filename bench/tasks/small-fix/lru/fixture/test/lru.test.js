const test = require('node:test');
const assert = require('node:assert/strict');
const { LRU } = require('../src/lru');
test('evicts the least recently used on overflow', () => {
  const c = new LRU(2).set('a', 1).set('b', 2).set('c', 3);
  assert.deepEqual([c.has('a'), c.has('b'), c.has('c')], [false, true, true]);
});
test('reading a key makes it recently used', () => {
  const c = new LRU(2).set('a', 1).set('b', 2);
  assert.equal(c.get('a'), 1);
  c.set('c', 3);
  assert.deepEqual([c.has('a'), c.has('b'), c.has('c')], [true, false, true]);
});
test('writing an existing key makes it recently used and does not grow the cache', () => {
  const c = new LRU(2).set('a', 1).set('b', 2).set('a', 10);
  c.set('c', 3);
  assert.deepEqual([c.get('a'), c.has('b'), c.size], [10, false, 2]);
});
test('a missing key reads as undefined and changes nothing', () => {
  const c = new LRU(1).set('a', 1);
  assert.equal(c.get('zzz'), undefined);
  assert.deepEqual([c.has('a'), c.has('zzz'), c.size], [true, false, 1]);
});
