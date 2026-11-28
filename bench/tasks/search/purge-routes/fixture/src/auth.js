const audit = require('./audit');

// Wraps a handler: rejects anonymous requests and notes who called it.
function withAuth(handler) {
  return req => {
    if (!req.user) return { status: 401 };
    audit.record(req.user, `${req.method} ${req.path}`);
    return handler(req);
  };
}

module.exports = { withAuth };
