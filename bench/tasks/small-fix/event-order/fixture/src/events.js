// Stock events arrive as lines "seq,type,sku,qty" in any order, for example "7,receive,A1,10".
// loadEvents returns them as objects sorted by sequence number, lowest first. Blank lines are skipped.
function parseLine(line) {
  const [seq, type, sku, qty] = line.split(',').map(part => part.trim());
  return { seq, type, sku, qty: Number(qty) };
}

function loadEvents(lines) {
  return lines
    .filter(line => line.trim())
    .map(parseLine)
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
}

module.exports = { parseLine, loadEvents };
