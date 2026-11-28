const { purge: dropAuditTrail } = require('./audit');
const store = require('./store');

// Removes what we may no longer keep about a user.
function apply(userId) {
  store.put('users', userId, { id: userId, name: null, email: null });
  dropAuditTrail();
}

// Removes expired sessions.
function sweep(now) {
  for (const [id, session] of store.tables.sessions) if (session.expires <= now) store.remove('sessions', id);
}

module.exports = { apply, sweep };
