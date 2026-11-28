const store = require('./store');

// { total, byTag: { tag: count } }
function summary() {
  const byTag = {};
  for (const note of store.all()) byTag[note.tag] = (byTag[note.tag] ?? 0) + 1;
  return { total: store.all().length, byTag };
}

module.exports = { summary };
