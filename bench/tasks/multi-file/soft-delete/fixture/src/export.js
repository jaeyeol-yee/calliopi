const store = require('./store');

// A header line, then one line per note in id order.
function toCsv() {
  return ['id,title,tag', ...store.all().map(note => `${note.id},${note.title},${note.tag}`)].join('\n');
}

module.exports = { toCsv };
