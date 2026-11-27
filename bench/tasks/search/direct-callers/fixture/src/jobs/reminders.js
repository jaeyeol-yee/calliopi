const mail = require('../mail');
// Legacy: reminders predate notify().
function remind(user) {
  return mail.sendEmail(user.email, 'Reminder', 'You have pending items.');
}
module.exports = { remind };
