// Exact title matches first, then by title length.
function rank(hits, query) {
  return [...hits].sort((a, b) => (b.title === query) - (a.title === query) || a.title.length - b.title.length);
}

module.exports = { rank };
