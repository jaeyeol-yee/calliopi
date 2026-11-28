const test = require('node:test');
const assert = require('node:assert/strict');
const { formatPrice } = require('../src/format');
const { summary } = require('../src/cart');
const { invoiceLine } = require('../src/invoice');
// Only what the prompt and the provided tests describe, with other amounts: 'de' puts the sign after,
// uses a decimal comma and groups thousands with dots; 'en' (the default) is unchanged and ungrouped.
test('German with no, one and two groups', () => {
  assert.equal(formatPrice(99, 'de'), '0,99 €');
  assert.equal(formatPrice(99999, 'de'), '999,99 €');
  assert.equal(formatPrice(100000, 'de'), '1.000,00 €');
  assert.equal(formatPrice(123456789, 'de'), '1.234.567,89 €');
});
test('English by default and by name', () => {
  assert.equal(formatPrice(123456789), '€1234567.89');
  assert.equal(formatPrice(123456789, 'en'), '€1234567.89');
  assert.equal(formatPrice(5, 'en'), '€0.05');
});
test('summary and invoiceLine pass the locale through', () => {
  const items = [{ name: 'Pen', cents: 150, qty: 3 }, { name: 'Desk', cents: 45000000, qty: 3 }];
  assert.equal(summary(items, 'de'), '2 items, 1.350.004,50 €');
  assert.equal(summary(items, 'en'), '2 items, €1350004.50');
  assert.equal(invoiceLine(items[1], 'de'), 'Desk × 3: 1.350.000,00 €');
  assert.equal(invoiceLine(items[0]), 'Pen × 3: €4.50');
  assert.equal(invoiceLine(items[0], 'en'), 'Pen × 3: €4.50');
});
