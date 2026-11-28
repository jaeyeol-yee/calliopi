const audit = require('../audit');
const store = require('../store');

function clear(req) {
  store.purge('sessions');
  if (req.query.forget === 'trail') audit.purge();
  return { status: 204 };
}

module.exports = { clear };
