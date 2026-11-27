const test = require('node:test');
const assert = require('node:assert/strict');
const { formatPrice } = require('../src/format');
const { summary } = require('../src/cart');
const { invoiceLine } = require('../src/invoice');
const items = [{ name: 'Tea', cents: 1250, qty: 1 }, { name: 'Cup', cents: 99950, qty: 2 }];
test('English stays the default', () => {
  assert.equal(formatPrice(1250), '€12.50');
  assert.equal(summary(items), '2 items, €2011.50');
});
test('German puts the sign after and uses a decimal comma and dot grouping', () => {
  assert.equal(formatPrice(1250, 'de'), '12,50 €');
  assert.equal(formatPrice(201150, 'de'), '2.011,50 €');
  assert.equal(summary(items, 'de'), '2 items, 2.011,50 €');
  assert.equal(invoiceLine(items[1], 'de'), 'Cup × 2: 1.999,00 €');
});
