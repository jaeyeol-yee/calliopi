const { formatPrice } = require('./format');
function summary(items) {
  const cents = items.reduce((a, i) => a + i.cents * i.qty, 0);
  return `${items.length} items, ${formatPrice(cents)}`;
}
module.exports = { summary };
