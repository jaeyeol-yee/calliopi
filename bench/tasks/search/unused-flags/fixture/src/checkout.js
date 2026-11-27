const { flags } = require('./flags');
const { priceOf } = require('./pricing');

function checkout(cart) {
  const total = cart.reduce((sum, item) => sum + priceOf(item), 0);
  if (flags.newCheckout) return { total, steps: ['review', 'pay'] };
  return { total, steps: ['address', 'shipping', 'review', 'pay'] };
}

module.exports = { checkout };
