const audit = require('../audit');
const store = require('../store');
const retention = require('../retention');

function remove(req) {
  const existed = store.remove('users', req.params.id);
  if (existed) audit.record(req.user, `removed user ${req.params.id}`);
  return { status: existed ? 204 : 404 };
}

function anonymize(req) {
  if (!store.get('users', req.params.id)) return { status: 404 };
  retention.apply(req.params.id);
  return { status: 200 };
}

function wipeAll(req) {
  store.purge('users');
  audit.record(req.user, 'wiped all users');
  return { status: 204 };
}

module.exports = { remove, anonymize, wipeAll };
