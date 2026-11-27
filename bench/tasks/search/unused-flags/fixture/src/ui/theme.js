const { isEnabled } = require('../flags');

function theme(user) {
  if (user.prefersDark && isEnabled('darkMode')) return 'dark';
  return 'light';
}

module.exports = { theme };
