const test = require('node:test');
const assert = require('node:assert/strict');
const { lineTotal, applyDiscount } = require('../src/price');
const { addTax } = require('../src/tax');
const { cartTotal } = require('../src/cart');
const { formatEuro } = require('../src/format');
const { invoice } = require('../src/invoice');
const items = [{ name: 'Tea', cents: 350, qty: 2 }, { name: 'Cup', cents: 1999, qty: 1 }];

test('amounts are integer cents', () => {
  assert.equal(lineTotal(10, 3), 30);
  assert.equal(lineTotal(1999, 3), 5997);
  assert.equal(applyDiscount(2000, 10), 1800);
  assert.equal(addTax(1800, 20), 2160);
  assert.equal(cartTotal(items), 2699);
  assert.equal(cartTotal(items, { discountPercent: 10, taxPercent: 20 }), 2915);
});
test('formatting takes cents and the invoice reads as before', () => {
  assert.equal(formatEuro(1250), '€12.50');
  assert.equal(formatEuro(5), '€0.05');
  assert.equal(invoice(items, { taxPercent: 20 }), 'Tea × 2: €7.00\nCup × 1: €19.99\nTotal: €32.39');
});
