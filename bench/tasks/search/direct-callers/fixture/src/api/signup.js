const { sendEmail: deliver } = require('../mail/mailer');
function signup(email) {
  // Welcome mail goes out before preferences exist.
  deliver(email, 'Welcome', 'Thanks for signing up.');
  return { email };
}
module.exports = { signup };
