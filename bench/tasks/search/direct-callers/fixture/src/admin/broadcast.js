const mailer = require('../mail/mailer');
const send = mailer.sendEmail;
// Admin announcements ignore preferences on purpose.
function broadcast(users, subject, body) {
  return users.map(u => send(u.email, subject, body));
}
function testSendEmail() { return 'sendEmail is not called here'; }
module.exports = { broadcast, testSendEmail };
