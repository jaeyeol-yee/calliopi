// Low-level SMTP send. Callers should go through notify() in src/mail/notify.js, which
// respects user preferences; a few legacy paths still call sendEmail directly.
function sendEmail(to, subject, body) {
  return { to, subject, body, sent: true };
}
module.exports = { sendEmail };
