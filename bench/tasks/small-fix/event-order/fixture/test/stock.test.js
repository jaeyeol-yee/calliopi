const test = require('node:test');
const assert = require('node:assert/strict');
const { available } = require('../src/stock');
const { stockReport } = require('../src/report');

test('received minus shipped minus reserved', () => {
  assert.equal(available(['1,receive,A1,10', '2,ship,A1,3', '3,reserve,A1,2'], 'A1'), 5);
});
test('a release frees the reservation', () => {
  const lines = ['8,receive,A1,10', '9,reserve,A1,4', '10,release,A1,4'];
  assert.equal(available(lines, 'A1'), 10);
  assert.equal(stockReport(lines, ['A1']), 'A1: 10 free');
});
