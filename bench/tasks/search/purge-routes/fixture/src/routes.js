const { withAuth } = require('./auth');
const users = require('./handlers/users');
const admin = require('./handlers/admin');
const jobs = require('./handlers/jobs');
const sessions = require('./handlers/sessions');
const reports = require('./handlers/reports');

const routes = [
  ['GET', '/health', () => ({ status: 200 })],
  ['DELETE', '/users/:id', withAuth(users.remove)],
  ['DELETE', '/users', withAuth(users.wipeAll)],
  ['POST', '/users/:id/anonymize', withAuth(users.anonymize)],
  ['POST', '/admin/cleanup', withAuth(admin.cleanup)],
  ['POST', '/admin/reindex', withAuth(admin.reindex)],
  ['POST', '/jobs/:name/run', withAuth(jobs.run)],
  ['DELETE', '/sessions', sessions.clear],
  ['GET', '/reports/daily', withAuth(reports.daily)],
];

module.exports = { routes };
