const { startServer } = require('./server');
// node src/cli.js --verbose
function main(argv) {
  return startServer({ verbose: argv.includes('--verbose'), port: 8080 });
}
module.exports = { main };
