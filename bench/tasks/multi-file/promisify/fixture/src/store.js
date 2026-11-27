// An in-memory store with a Node-style callback API. Reads of a missing key fail.
const data = new Map([['greeting', 'hello'], ['count', '3']]);
let failNext = 0;
function read(key, cb) {
  setImmediate(() => {
    if (failNext > 0) { failNext--; return cb(new Error('transient')); }
    if (!data.has(key)) return cb(new Error(`missing ${key}`));
    cb(null, data.get(key));
  });
}
function failTimes(n) { failNext = n; }
module.exports = { read, failTimes };
