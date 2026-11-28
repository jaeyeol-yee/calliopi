const { getFlag: f } = require('./flags');

// Users are bucketed 0-99 by id; the first N buckets get the new pricing.
function inRollout(userId) {
  return userId % 100 < f('rolloutPercent');
}

module.exports = { inRollout };
