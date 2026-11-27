// Parses durations like "1h30m", "45s", "2h", "1h5m10s" into seconds.
// Units must appear in the order h, m, s, each at most once. An empty string is 0.
// Anything else (unknown units, wrong order, no number before a unit) throws.
const UNITS = { h: 3600, m: 60, s: 1 };
const TOKEN = /(\d+)([hms])/g;

function parseDuration(text) {
  if (text === '') return 0;
  let total = 0, last = -1, consumed = 0, match;
  while ((match = TOKEN.exec(text)) !== null) {
    const order = 'hms'.indexOf(match[2]);
    if (order < last) throw new Error(`unit out of order: ${match[2]}`);
    last = order;
    total += Number(match[1]) * UNITS[match[2]];
    consumed += match[0].length;
  }
  if (consumed !== text.length) throw new Error(`cannot parse: ${text}`);
  return total;
}

module.exports = { parseDuration };
