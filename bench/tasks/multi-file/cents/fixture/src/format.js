// 12.5 -> "€12.50"
function formatEuro(amount) {
  return `€${amount.toFixed(2)}`;
}

module.exports = { formatEuro };
