const { isEnabled } = require('../flags');
const { KEYS } = require('./keys');

function channelsFor(user) {
  return Object.keys(KEYS).filter(channel => user[channel] && isEnabled(KEYS[channel]));
}

module.exports = { channelsFor };
