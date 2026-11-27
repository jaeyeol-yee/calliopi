const base = require('../../config/base.json');

function profileName(argv) {
  const at = argv.indexOf('--profile');
  return at >= 0 ? argv[at + 1] : 'development';
}

// Base config, then the profile's, then the environment.
function loadConfig(argv, env) {
  const profile = profileName(argv);
  let overrides = {};
  try { overrides = require(`../../config/profiles/${profile}.json`); } catch { /* no profile file */ }
  const config = { ...base, ...overrides, profile };
  if (env.PORT) config.port = Number(env.PORT);
  // Several instances on one host: shift every port but production's.
  if (profile !== 'production') config.port += Number(env.PORT_OFFSET ?? 0);
  return config;
}

module.exports = { loadConfig };
