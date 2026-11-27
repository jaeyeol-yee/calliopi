const test = require('node:test');
const assert = require('node:assert/strict');
const { LRU } = require('../src/lru');
// Only what the comment in src/lru.js says, with other keys, a larger capacity and a falsy value.
test('reads and writes of any key refresh it', () => {
  const c = new LRU(3).set('x', 1).set('y', 2).set('z', 3);
  assert.equal(c.get('y'), 2);
  c.set('x', 11);            // order, oldest first: z, y, x
  c.set('w', 4);             // evicts z
  assert.deepEqual([c.has('x'), c.has('y'), c.has('z'), c.has('w'), c.size], [true, true, false, true, 3]);
  c.set('v', 5);             // evicts y
  assert.deepEqual([c.has('x'), c.has('y'), c.has('w'), c.has('v'), c.get('x')], [true, false, true, true, 11]);
});
test('a key holding 0 is refreshed by a read', () => {
  const c = new LRU(2).set('n', 0).set('m', 1);
  assert.equal(c.get('n'), 0);
  c.set('k', 2);             // evicts m
  assert.deepEqual([c.has('n'), c.has('m'), c.has('k')], [true, false, true]);
});
test('evictions follow use order over a longer run', () => {
  const c = new LRU(2);
  for (const k of ['p', 'q', 'r', 's']) c.set(k, k);
  assert.deepEqual(['p', 'q', 'r', 's'].map(k => c.has(k)), [false, false, true, true]);
  c.get('r'); c.set('t', 't');
  assert.deepEqual([c.has('r'), c.has('s'), c.has('t'), c.size], [true, false, true, 2]);
});
