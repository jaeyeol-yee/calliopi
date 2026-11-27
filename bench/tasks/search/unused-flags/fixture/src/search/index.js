const { flags } = require('../flags');
const { rank } = require('./rank');

function search(items, query) {
  const { betaSearch: useBeta } = flags;
  const hits = items.filter(item => item.title.includes(query));
  return useBeta ? rank(hits, query) : hits;
}

module.exports = { search };
