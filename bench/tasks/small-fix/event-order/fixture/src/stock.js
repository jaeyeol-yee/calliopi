const { loadEvents } = require('./events');

// Units of `sku` free to sell: received, minus shipped, minus what is reserved right now.
// A release gives back part of a reservation; the reserved amount never goes below zero.
function available(lines, sku) {
  let received = 0, shipped = 0, reserved = 0;
  for (const event of loadEvents(lines)) {
    if (event.sku !== sku) continue;
    if (event.type === 'receive') received += event.qty;
    else if (event.type === 'ship') shipped += event.qty;
    else if (event.type === 'reserve') reserved += event.qty;
    else if (event.type === 'release') reserved = Math.max(0, reserved - event.qty);
  }
  return received - shipped - reserved;
}

module.exports = { available };
