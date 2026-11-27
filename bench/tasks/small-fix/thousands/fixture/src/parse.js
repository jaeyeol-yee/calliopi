// "1,234.50" → 1234.5. Commas group thousands.
function parseAmount(text) {
  return parseFloat(text.trim().replace(',', ''));
}
module.exports = { parseAmount };
