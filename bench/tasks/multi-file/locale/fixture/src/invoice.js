const { formatPrice } = require('./format');
function invoiceLine(item) {
  return `${item.name} × ${item.qty}: ${formatPrice(item.cents * item.qty)}`;
}
module.exports = { invoiceLine };
