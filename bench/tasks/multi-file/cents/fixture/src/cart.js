const { lineTotal, applyDiscount } = require('./price');
const { addTax } = require('./tax');

// items: [{ name, price, qty }]. The discount applies to the subtotal, then tax to what is left.
function cartTotal(items, { discountPercent = 0, taxPercent = 0 } = {}) {
  const subtotal = items.reduce((sum, item) => sum + lineTotal(item.price, item.qty), 0);
  return addTax(applyDiscount(subtotal, discountPercent), taxPercent);
}

module.exports = { cartTotal };
