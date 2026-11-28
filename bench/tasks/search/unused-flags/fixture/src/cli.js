const { runSync } = require('./sync');

// node src/cli.js sync [--strict]
function parseArgs(argv) {
  return { command: argv[0], strictMode: argv.includes('--strict') };
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.command === 'sync') return runSync([], options);
  return undefined;
}

module.exports = { parseArgs, main };
