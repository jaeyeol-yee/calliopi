const audit = require('../audit');

function daily() {
  const entries = audit.list();
  return { status: 200, actions: entries.length, actors: new Set(entries.map(e => e.actor)).size };
}

module.exports = { daily };
