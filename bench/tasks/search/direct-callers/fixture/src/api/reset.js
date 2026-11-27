const { notify } = require('../mail/notify');
function requestReset(user) {
  return notify(user, 'Reset your password', 'Use this link: ...');
}
// function legacyReset(user) { return sendEmail(user.email, 'Reset', '...'); }  // removed in v2
module.exports = { requestReset };
