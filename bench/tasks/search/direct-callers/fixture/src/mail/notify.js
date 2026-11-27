const { sendEmail } = require('./mailer');
const prefs = new Map();
// The supported way to email a user.
function notify(user, subject, body) {
  if (prefs.get(user.id) === 'none') return { sent: false };
  return sendEmail(user.email, subject, body);
}
module.exports = { notify, prefs };
