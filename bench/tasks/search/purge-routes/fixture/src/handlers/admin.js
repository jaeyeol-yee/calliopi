const maintenance = require('../maintenance');
const search = require('../search');

function cleanup() {
  return { status: 200, steps: maintenance.run('cleanup') };
}

function reindex() {
  return { status: 200, indexed: search.rebuild() };
}

module.exports = { cleanup, reindex };
