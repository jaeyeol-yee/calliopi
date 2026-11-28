const test = require('node:test');
const assert = require('node:assert/strict');
const { lineTotal, applyDiscount } = require('../src/price');
const { addTax } = require('../src/tax');
const { cartTotal } = require('../src/cart');
const { formatEuro } = require('../src/format');
const { invoice } = require('../src/invoice');
// Only what the prompt says: the discount or tax itself is rounded to the nearest cent, halves up,
// then subtracted or added. These amounts land on half a cent.
test('a discount of half a cent rounds up before it is subtracted', () => {
  assert.equal(applyDiscount(1050, 5), 997);    // 52.5 -> 53
  assert.equal(applyDiscount(130, 25), 97);     // 32.5 -> 33
  assert.equal(applyDiscount(50, 1), 49);       // 0.5 -> 1
  assert.equal(applyDiscount(4950, 3), 4801);   // 148.5 -> 149
  assert.equal(applyDiscount(2000, 0), 2000);
  assert.equal(applyDiscount(999, 100), 0);
});
test('tax of half a cent rounds up before it is added', () => {
  assert.equal(addTax(1050, 5), 1103);          // 52.5 -> 53
  assert.equal(addTax(50, 1), 51);              // 0.5 -> 1
  assert.equal(addTax(1234, 19), 1468);         // 234.46 -> 234
  assert.equal(addTax(1234, 0), 1234);
});
test('the cart discounts the subtotal, then taxes what is left, in whole cents', () => {
  const pens = [{ name: 'Pen', cents: 350, qty: 3 }];
  assert.equal(cartTotal(pens, { discountPercent: 5 }), 997);
  assert.equal(cartTotal(pens, { discountPercent: 5, taxPercent: 19 }), 1186);   // 997 + 189
  assert.equal(cartTotal([{ name: 'a', cents: 10, qty: 1 }, { name: 'b', cents: 20, qty: 1 }]), 30);
  assert.equal(cartTotal([]), 0);
  for (const total of [lineTotal(1999, 7), applyDiscount(1999, 7), addTax(1999, 7), cartTotal(pens, { discountPercent: 7, taxPercent: 7 })]) assert.ok(Number.isInteger(total), String(total));
});
test('formatting and the invoice', () => {
  assert.equal(formatEuro(123456), '€1234.56');
  assert.equal(formatEuro(100), '€1.00');
  assert.equal(formatEuro(7), '€0.07');
  assert.equal(formatEuro(0), '€0.00');
  assert.equal(invoice([{ name: 'Pen', cents: 350, qty: 3 }, { name: 'Ink', cents: 5, qty: 1 }], { discountPercent: 5 }), 'Pen × 3: €10.50\nInk × 1: €0.05\nTotal: €10.02');
});
