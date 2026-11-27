const store = require('./store');
// Retries transient read errors up to `times` attempts in total.
function readWithRetry(key, times, cb) {
  store.read(key, (err, value) => {
    if (err && err.message === 'transient' && times > 1) return readWithRetry(key, times - 1, cb);
    cb(err, value);
  });
}
module.exports = { readWithRetry };
