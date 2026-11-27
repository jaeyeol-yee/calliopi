const { readWithRetry } = require('./retry');
function nextCount(cb) {
  readWithRetry('count', 2, (err, raw) => {
    if (err) return cb(err);
    cb(null, Number(raw) + 1);
  });
}
module.exports = { nextCount };
