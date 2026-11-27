// Writes debug lines only when the option is on.
function createLogger(options = {}) {
  const lines = [];
  return {
    debug(msg) { if (options.verbose) lines.push(`debug: ${msg}`); },
    info(msg) { lines.push(`info: ${msg}`); },
    lines,
  };
}
module.exports = { createLogger };
