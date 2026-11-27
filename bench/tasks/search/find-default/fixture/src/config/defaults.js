// Defaults for every client; callers may override any of them.
module.exports = {
  retries: 3,
  backoffMs: 250,
  requestTimeoutMs: 30_000,
  userAgent: 'demo-client/1.0',
};
