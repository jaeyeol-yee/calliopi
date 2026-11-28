const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAmount } = require('../src/parse');
const { total } = require('../src/report');
// Only what the comment in src/parse.js says: commas group thousands, however many groups there are.
test('amounts with one, two and three separators', () => {
  assert.equal(parseAmount('1,234.50'), 1234.5);
  assert.equal(parseAmount('12,345,678.25'), 12345678.25);
  assert.equal(parseAmount('1,234,567,890.5'), 1234567890.5);
  assert.equal(parseAmount('999'), 999);
});
test('totals of other large amounts', () => {
  assert.equal(total(['2,500,000,000.00', '1,000.25']), '2500001000.25');
  assert.equal(total(['10,000.00', '20,000.00', '0.75']), '30000.75');
});
