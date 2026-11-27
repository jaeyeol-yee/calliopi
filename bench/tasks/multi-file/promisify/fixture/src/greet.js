const { readWithRetry } = require('./retry');
function greeting(name, cb) {
  readWithRetry('greeting', 3, (err, word) => {
    if (err) return cb(err);
    cb(null, `${word}, ${name}`);
  });
}
module.exports = { greeting };
