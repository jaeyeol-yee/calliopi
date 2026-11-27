const { createLogger } = require('./logger');
function startServer(config = {}) {
  const log = createLogger({ verbose: config.verbose });
  log.info('starting');
  log.debug(`port ${config.port ?? 8080}`);
  return log;
}
module.exports = { startServer };
