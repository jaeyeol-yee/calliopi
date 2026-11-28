const { setFlag } = require('./flags');
const { log } = require('./logging');

// Turns push notifications on for the pilot. Nothing sends them yet.
function startPushPilot(admin) {
  setFlag('pushAlerts', true);
  log('audit', `${admin} started the push pilot`);
}

function setMaintenance(admin, on) {
  setFlag('maintenance', on);
  log('audit', `${admin} set maintenance ${on ? 'on' : 'off'}`);
}

module.exports = { startPushPilot, setMaintenance };
