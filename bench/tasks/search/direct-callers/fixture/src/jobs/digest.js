const { notify } = require('../mail');
function sendDigest(users) {
  return users.map(u => notify(u, 'Your weekly digest', '...'));
}
module.exports = { sendDigest };
