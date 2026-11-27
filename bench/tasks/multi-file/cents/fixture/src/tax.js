// The amount with `percent` tax added.
function addTax(amount, percent) {
  return amount * (1 + percent / 100);
}

module.exports = { addTax };
