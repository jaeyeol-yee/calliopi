const { isEnabled } = require('./flags');

function runSync(records, options = {}) {
  const invalid = records.filter(r => !r.id);
  if (options.strictMode && invalid.length) throw new Error(`${invalid.length} records have no id`);
  const batch = isEnabled('experimentalSync') ? 500 : 50;
  return { synced: records.length - invalid.length, batch };
}

module.exports = { runSync };
