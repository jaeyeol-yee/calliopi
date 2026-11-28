const { lineTotal } = require('./price');
const { cartTotal } = require('./cart');
const { formatEuro } = require('./format');

// One line per item ("Tea × 2: €7.00"), then "Total: €…".
function invoice(items, options) {
  return [
    ...items.map(item => `${item.name} × ${item.qty}: ${formatEuro(lineTotal(item.price, item.qty))}`),
    `Total: ${formatEuro(cartTotal(items, options))}`,
  ].join('\n');
}

module.exports = { invoice };
