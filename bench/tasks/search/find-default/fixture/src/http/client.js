const defaults = require('../config/defaults');
// A per-call timeout wins over the default.
function request(url, options = {}) {
  const timeout = options.timeoutMs ?? defaults.requestTimeoutMs;
  return { url, timeout, retries: options.retries ?? defaults.retries };
}
module.exports = { request };
