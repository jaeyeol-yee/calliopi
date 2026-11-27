const { parseAmount } = require('./parse');
// Sum of the amounts, formatted with two decimals.
function total(lines) {
  const sum = lines.reduce((acc, line) => acc + parseAmount(line), 0);
  return sum.toFixed(2);
}
module.exports = { total };
