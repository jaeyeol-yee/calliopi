// CSV export of orders.
// TODO: honor fastExport (streaming) once the writer supports it.
function exportOrders(orders, options = {}) {
  if (options.fast) throw new Error('fastExport is not supported yet');
  return orders.map(o => `${o.id},${o.total}`).join('\n');
}

module.exports = { exportOrders };
