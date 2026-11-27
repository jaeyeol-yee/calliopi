// Price after discounts, in cents. Members get 10% off; orders of 100 euros or more get 5 euros off.
// Both may apply. The price never goes below zero.
function finalPrice(cents, { member = false } = {}) {
  let price = cents;
  if (member) price = Math.round(price * 0.9);
  if (cents > 10_000) price -= 500;
  return Math.max(0, price);
}
module.exports = { finalPrice };
