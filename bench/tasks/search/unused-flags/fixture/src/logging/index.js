const { isEnabled } = require('../flags');
const { AREAS } = require('./areas');

const lines = [];

function log(area, message) {
  if (!AREAS.includes(area)) return false;
  if (!isEnabled(`${area}Log`)) return false;
  lines.push(`[${area}] ${message}`);
  return true;
}

// Errors always go to stderr; there is no switch for them here.
function logError(error) {
  console.error(error.message);
}

module.exports = { log, logError, lines };
