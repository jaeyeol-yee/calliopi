// Amounts are euros as floats.
function lineTotal(price, qty) {
  return price * qty;
}

// The amount after `percent` off.
function applyDiscount(amount, percent) {
  return amount * (1 - percent / 100);
}

module.exports = { lineTotal, applyDiscount };
