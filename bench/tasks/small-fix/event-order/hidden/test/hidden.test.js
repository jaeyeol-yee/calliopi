const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEvents } = require('../src/events');
const { available } = require('../src/stock');
// Only what the comments in src/ say: events are applied in the order of their sequence numbers.
test('events sort by sequence number whatever its length', () => {
  const sorted = loadEvents(['100,ship,A1,1', '', '20,receive,A1,5', '3,receive,B2,1', '1000,ship,A1,1']);
  assert.deepEqual(sorted.map(e => Number(e.seq)), [3, 20, 100, 1000]);
  assert.deepEqual(sorted.map(e => [e.type, e.sku, e.qty]), [['receive', 'B2', 1], ['receive', 'A1', 5], ['ship', 'A1', 1], ['ship', 'A1', 1]]);
});
test('a release after a reservation, across other digit boundaries', () => {
  assert.equal(available(['101,release,A1,2', '99,receive,A1,7', '100,reserve,A1,2'], 'A1'), 7);
  assert.equal(available(['500,release,B2,3', '5,receive,B2,9', '50,reserve,B2,5'], 'B2'), 7);
  assert.equal(available(['20,receive,A1,4', '100,reserve,A1,4', '1000,release,A1,1'], 'A1'), 1);
});
