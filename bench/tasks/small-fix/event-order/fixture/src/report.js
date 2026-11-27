const { available } = require('./stock');

// One line per sku, sorted by sku: "A1: 6 free".
function stockReport(lines, skus) {
  return [...skus].sort().map(sku => `${sku}: ${available(lines, sku)} free`).join('\n');
}

module.exports = { stockReport };
