const flagsModule = require('../flags');

function rowHeight() {
  return flagsModule.flags?.compactRows ? 24 : 36;
}

module.exports = { rowHeight };
