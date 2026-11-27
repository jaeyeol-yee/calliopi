// The audit trail: who did what.
const trail = [];

function record(actor, action) {
  trail.push({ actor, action });
}

// Drops audit entries for good. Irreversible.
function purge(keep = 0) {
  trail.splice(0, Math.max(0, trail.length - keep));
}

function list() {
  return [...trail];
}

module.exports = { record, purge, list };
