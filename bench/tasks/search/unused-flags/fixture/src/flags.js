// Feature flags and their defaults. Read them with isEnabled/getFlag or from `flags`.
const FLAGS = {
  newCheckout: true,
  darkMode: false,
  betaSearch: false,
  fastExport: false,
  auditLog: true,
  accessLog: false,
  errorLog: true,
  legacyAuth: false,
  smsAlerts: false,
  emailAlerts: true,
  pushAlerts: false,
  rolloutPercent: 25,
  compactRows: false,
  strictMode: false,
  experimentalSync: false,
  maintenance: false,
};

function isEnabled(name) {
  return Boolean(FLAGS[name]);
}

function getFlag(name) {
  return FLAGS[name];
}

function setFlag(name, value) {
  if (!Object.hasOwn(FLAGS, name)) throw new Error(`unknown flag: ${name}`);
  FLAGS[name] = value;
}

module.exports = { flags: FLAGS, isEnabled, getFlag, setFlag };
